//! The Rust export encoder, exposed to the webview as tauri
//! commands. The webview hands raw RGBA frames + f32 audio chunks to
//! this module, which constructs a [`MediaSink`] and writes the file
//! straight to the scratch directory.
//!
//! Why this exists at all: the editor's previous export ran through
//! `mediabunny` in the webview, which has no path to the native
//! ffmpeg encoder. `MediaSink` lives in `editor-core` and links to
//! `ffmpeg-next`, but `ffmpeg-next` doesn't build for
//! `wasm32-unknown-unknown`. The desktop process is the only place
//! the encoder runs, so the webview talks to it through the binary-IPC
//! bridge the file-streaming commands already use (see
//! `native_fs::bluper_open_write`).
//!
//! Each export is identified by an id (mirrors the `ExportRegistry`
//! design in `editor-core::export`). Sessions are held in a
//! `Mutex<HashMap>` kept inside `Mp4Exports`; the lifetime is the
//! webview's. Multiple exports cannot run on the same thread today
//! — `MediaSink` is single-threaded by design — and the export pipeline
//! on the JS side already serialises them. Cancelling a session drops
//! it from the registry; the partially written file is removed via
//! the existing scratch-cleanup path.
//!
//! What this module does not own:
//! - The export state machine that was prototyped in step 1 of the
//!   port. That logic is Rust-side now and reaches the encoder through
//!   these commands.
//! - Mediabunny. Once the webview routes every export through these
//!   commands, the package can be removed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use editor_core::export::sink::{
    ContainerCapability, MediaSink, MediaSinkConfig, capabilities, open_media_sink,
};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// Default scratch path under which the mp4 lands. Pair with
/// `native_fs::bluper_scratch_path` so the export and the file-move
/// use the same directory layout. The on-disk path is returned by
/// `bluper_export_finish`; the webview then calls
/// `native_fs::bluper_move_file` to put the file wherever the user
/// asked.
const EXPORT_NAME_PREFIX: &str = "export";

/// Every command here reports failure as a plain `String`: tauri
/// serialises the error straight to the webview, and the JS side
/// surfaces the text verbatim in the export error event.
pub type Result<T> = std::result::Result<T, String>;

/// One in-flight export. Constructed by `start`, populated by
/// `write_frame` and `write_audio`, and consumed by `finish` (which
/// closes the sink and removes the session).
pub struct ExportSession {
    sink: MediaSink,
    /// The scratch path the file lives at. Returned to the webview so
    /// it can call `bluper_move_file` to the user's chosen destination.
    scratch_path: std::path::PathBuf,
}

/// The registry of in-flight exports. Mints ids, hands back sessions
/// by id, and forgets them on completion.
#[derive(Default)]
pub struct Mp4Exports {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, ExportSession>>,
}

impl Mp4Exports {
    pub fn next_id(&self) -> u64 {
        // `next_id + 1` so the first id is 1, not 0 — the JS side
        // already treats 0 as "no session", and that path is also
        // open to webview bugs that send id 0 by accident.
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn insert(&self, id: u64, session: ExportSession) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|_| "registry poisoned")?;
        if sessions.contains_key(&id) {
            return Err(format!("session {id} is already registered"));
        }
        sessions.insert(id, session);
        Ok(())
    }

    pub fn with_mut<R>(
        &self,
        id: u64,
        f: impl FnOnce(&mut ExportSession) -> R,
    ) -> Result<R> {
        let mut sessions = self.sessions.lock().map_err(|_| "registry poisoned")?;
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| format!("session {id} is not registered"))?;
        Ok(f(session))
    }

    pub fn take(&self, id: u64) -> Result<ExportSession> {
        let mut sessions = self.sessions.lock().map_err(|_| "registry poisoned")?;
        sessions
            .remove(&id)
            .ok_or_else(|| format!("session {id} is not registered"))
    }

    /// Drops a session without running finish. The sink is dropped
    /// without writing a trailer, and the half-encoded file is left
    /// for `native_fs::sweep_stale_scratch_files` to reclaim later.
    pub fn forget(&self, id: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&id);
        }
    }
}

/// Reads the body of a tauri command as raw bytes. AGENTS.md calls this
/// out as the right shape for media-sized payloads — JSON would turn a
/// megabyte of audio into a million JS numbers before Rust saw a
/// single byte.
fn take_raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8]> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        // Reaching the JSON branch is a caller bug: mediabunny's
        // replacement sends raw bytes only.
        InvokeBody::Json(_) => Err(
            "expected a raw request body for the export pipeline; got JSON".to_string(),
        ),
    }
}

/// Reads one integer header off a raw-body command. The scalars that
/// accompany a binary payload have to travel as headers, not as named
/// tauri arguments: with an `InvokeBody::Raw` payload there is no JSON
/// map for the command macro to deserialise arguments out of, so a
/// `session_id: u64` parameter would try to parse the RGBA bytes as
/// JSON and fail on every call. `native_fs::bluper_write_chunk` sets
/// the same convention with its `stream-id` header.
fn header_u64(request: &Request<'_>, name: &str) -> Result<u64> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("export command is missing a valid {name} header"))
}

fn app_cache_exports_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir unavailable: {e}"))?
        .join("exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating scratch dir failed: {e}"))?;
    Ok(dir)
}

/// Which containers and codecs this build can actually write.
///
/// The export panel asks once when it opens. This replaced the WebCodecs
/// probe `mediabunny` used to run in the page — and it is a stronger answer,
/// because the library that reports the encoder is the library that runs it.
#[tauri::command]
pub fn bluper_export_capabilities() -> Result<Vec<ContainerCapability>> {
    Ok(capabilities())
}

/// Mints a session id, opens a `MediaSink` against a scratch path, and
/// registers the session. The path returned by the matching
/// `bluper_export_finish` is what the webview hands to
/// `bluper_move_file`. (Tauri commands can't return a struct field
/// directly with simple derive — every argument and the result get
/// serialised, so we keep the path inside the webview's earlier
/// `bluper_scratch_path` call rather than returning it here.)
#[tauri::command]
pub fn bluper_export_start<R: tauri::Runtime>(
    app: AppHandle<R>,
    exports: tauri::State<'_, Mp4Exports>,
    config: MediaSinkConfig,
) -> Result<u64> {
    let session_id = exports.next_id();
    let dir = app_cache_exports_dir(&app)?;
    // The extension is the container's own: ffmpeg names the muxer
    // explicitly, but a `.mp4` holding a WebM would still be a file the
    // user's player refuses and their file manager mislabels.
    let path = dir.join(format!(
        "{EXPORT_NAME_PREFIX}-{session_id}.{}",
        config.container.extension()
    ));

    // `open_media_sink` rather than `MediaSink::open`: it runs
    // `MediaSinkConfig::validate` first, so an odd width comes back as
    // "width and height must be even for 4:2:0 video" instead of an opaque
    // ffmpeg failure three frames later.
    let sink =
        open_media_sink(&path, config).map_err(|e| format!("opening the encoder: {e}"))?;

    exports.insert(
        session_id,
        ExportSession {
            sink,
            scratch_path: path,
        },
    )?;
    Ok(session_id)
}

/// Encodes one RGBA frame. The body is the raw RGBA8 row-major buffer;
/// the session and the presentation index travel as the
/// `export-session-id` and `export-pts-index` headers. Both width and
/// height come from the encoder config `bluper_export_start`
/// validated, so a wrong-sized frame is caught by
/// `MediaSink::write_frame` rather than at the IPC boundary.
#[tauri::command(async)]
pub async fn bluper_export_write_frame(
    request: Request<'_>,
    exports: tauri::State<'_, Mp4Exports>,
) -> Result<()> {
    let session_id = header_u64(&request, "export-session-id")?;
    let pts_index = header_u64(&request, "export-pts-index")? as i64;
    let pixels = take_raw_body(&request)?;
    exports.with_mut(session_id, |session| {
        session
            .sink
            .write_frame(pixels, pts_index)
            .map_err(|e| format!("write_frame: {e}"))
    })?
}

/// Encodes one chunk of audio. The body is `frames * channels`
/// little-endian f32 samples laid out in the same interleaved order the
/// legacy `OfflineAudioContext` produced (s0_c0, s0_c1, s1_c0, s1_c1,
/// …). The session, the frame count and the presentation index travel
/// as the `export-session-id`, `export-frames` and `export-pts-index`
/// headers. Interleaved is what every audio pipeline agrees on at the
/// per-clip level, and once on the wire it stays stable across encoder
/// versions; `MediaSink::write_audio` deinterleaves into the planar frame
/// AAC wants.
#[tauri::command(async)]
pub async fn bluper_export_write_audio(
    request: Request<'_>,
    exports: tauri::State<'_, Mp4Exports>,
) -> Result<()> {
    let session_id = header_u64(&request, "export-session-id")?;
    let frames = header_u64(&request, "export-frames")? as usize;
    let pts_index = header_u64(&request, "export-pts-index")? as i64;
    let bytes = take_raw_body(&request)?;
    if bytes.len() % std::mem::size_of::<f32>() != 0 {
        return Err(format!(
            "audio chunk is {} bytes, which is not a multiple of f32 size ({})",
            bytes.len(),
            std::mem::size_of::<f32>()
        ));
    }
    // Decoded rather than reinterpreted. The IPC body is a `&[u8]`
    // with no alignment guarantee, so casting the pointer to `*const
    // f32` is undefined behaviour even where it happens to work; a
    // stereo second at 48 kHz is 384 KB, which is nothing beside the
    // AAC encode that follows. `f32::from_le_bytes` also pins the
    // wire format to little-endian instead of the host's.
    let samples: Vec<f32> = bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect();
    // The sample count is not checked here: only the sink knows the
    // channel count the export was opened with, and
    // `MediaSink::write_audio` rejects a chunk that is not
    // `frames * channels` with the counts spelled out.
    exports.with_mut(session_id, |session| {
        session
            .sink
            .write_audio(&samples, frames, pts_index)
            .map_err(|e| format!("write_audio: {e}"))
    })?
}

/// Closes the encoders, writes the mp4 trailer, takes the session
/// out of the registry, and returns the on-disk path. The webview
/// then calls `bluper_move_file` to put the file at the user's
/// destination. The session is removed only after `finish` returns
/// Ok; a half-finished session leaks the file for the existing
/// scratch-cleanup sweep to find.
#[tauri::command]
pub fn bluper_export_finish(
    exports: tauri::State<'_, Mp4Exports>,
    session_id: u64,
) -> Result<String> {
    let session = exports.take(session_id)?;
    let path = session.scratch_path;
    session.sink.finish().map_err(|e| format!("finish: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Drops the session without running `finish`. The half-encoded file
/// stays on disk for the existing scratch sweep to reap. The
/// `RendererManager` calls this when the user cancels an export.
#[tauri::command]
pub fn bluper_export_cancel(
    exports: tauri::State<'_, Mp4Exports>,
    session_id: u64,
) -> Result<()> {
    // `cancel` on an unknown session is a no-op; the user clicked
    // cancel twice, or the session was already finalised. Either way
    // the file is already where it should be or it has been swept, so
    // an unregistered id is not an error to report back.
    exports.forget(session_id);
    Ok(())
}

