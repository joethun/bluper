//! Native filesystem bridge for the editor webview.
//!
//! Everything here exists to keep large media off the JavaScript heap. The
//! `fs` plugin's `read_file`/`write_file` commands serialise their payload as a
//! JSON array of numbers, which turns a 2 GB video into billions of JS numbers
//! before it ever reaches Rust — the exact ceiling the desktop build is
//! supposed to remove. These commands instead take (and return) raw IPC bodies
//! and write through a `BufWriter` that is held open across calls, so importing
//! or exporting a file costs one chunk of memory regardless of its size.
//!
//! Reads don't go through IPC at all: media is served to the webview over
//! Tauri's `asset:` protocol, which streams from disk with range requests.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime, State};

/// Bytes buffered before a write reaches the kernel. Chunks arrive from the
/// webview at 8 MiB (see `CHUNK_BYTES` in `tauri-runtime.ts`); a 1 MiB buffer
/// keeps the syscall count low without holding another large allocation per
/// open stream.
const WRITE_BUFFER_BYTES: usize = 1024 * 1024;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self(error.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

fn err(message: impl Into<String>) -> Error {
    Error(message.into())
}

/// Treats "it was already gone" as success. Callers delete media and metadata in
/// parallel and must not fail on a retry, so every removal here is idempotent.
fn ignore_not_found(result: std::io::Result<()>) -> Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// An open file the webview is streaming bytes into.
///
/// Writes are usually sequential, but a muxer finishing an MP4 seeks back to
/// patch sizes into headers it wrote earlier, so a chunk can carry an explicit
/// position. `cursor` tracks where the file is so the common sequential case
/// never pays for a seek (which would flush the buffer).
struct WriteStream {
    path: PathBuf,
    writer: BufWriter<File>,
    cursor: u64,
    length: u64,
}

/// Every write stream currently open, keyed by the id handed back to JS.
#[derive(Default)]
pub struct WriteStreams {
    streams: Mutex<HashMap<u64, WriteStream>>,
    next_id: AtomicU64,
}

impl WriteStreams {
    fn insert(&self, stream: WriteStream) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.streams
            .lock()
            .expect("write stream registry poisoned")
            .insert(id, stream);
        id
    }

    fn take(&self, id: u64) -> Option<WriteStream> {
        self.streams
            .lock()
            .expect("write stream registry poisoned")
            .remove(&id)
    }

    fn with<T>(&self, id: u64, f: impl FnOnce(&mut WriteStream) -> Result<T>) -> Result<T> {
        let mut streams = self.streams.lock().expect("write stream registry poisoned");
        let stream = streams
            .get_mut(&id)
            .ok_or_else(|| err(format!("write stream {id} is not open")))?;
        f(stream)
    }
}

/// Rejects anything that isn't a single path segment. Project and media ids are
/// app-generated UUIDs, so this only ever fires on a bug or a tampered store —
/// but it's what keeps `..` from walking out of the media directory.
fn validate_segment(segment: &str, label: &str) -> Result<()> {
    if segment.is_empty() {
        return Err(err(format!("{label} is empty")));
    }
    let is_safe = segment
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !is_safe || segment == "." || segment == ".." {
        return Err(err(format!("{label} \"{segment}\" is not a valid name")));
    }
    Ok(())
}

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| err(format!("app data directory is unavailable: {error}")))
}

fn app_cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    app.path()
        .app_cache_dir()
        .map_err(|error| err(format!("app cache directory is unavailable: {error}")))
}

/// Normalises without touching the filesystem: `Path::canonicalize` needs the
/// file to exist, and these checks run before a file is created.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Streams may only be opened inside directories this app owns. Exports are
/// written to a scratch file here first and moved to the user's chosen path
/// afterwards, so the destination picked in a save dialog never needs to be
/// writable through this command.
fn ensure_writable_root<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<PathBuf> {
    let path = normalize(path);
    let roots = [app_data_dir(app)?, app_cache_dir(app)?];
    if roots.iter().any(|root| path.starts_with(root)) {
        return Ok(path);
    }
    Err(err(format!(
        "{} is outside the directories this app can write to",
        path.display()
    )))
}

fn media_dir<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> Result<PathBuf> {
    validate_segment(project_id, "project id")?;
    Ok(app_data_dir(app)?
        .join("projects")
        .join(project_id)
        .join("media"))
}

/// Absolute path of one media file. The parent directory is created so the
/// caller can open a write stream straight away.
#[tauri::command]
pub fn bluper_media_path<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    media_id: String,
) -> Result<String> {
    validate_segment(&media_id, "media id")?;
    let dir = media_dir(&app, &project_id)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(media_id).to_string_lossy().into_owned())
}

/// File names of every media file stored for a project. A project with no media
/// yet has no directory, which is not an error.
#[tauri::command]
pub fn bluper_list_media<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
) -> Result<Vec<String>> {
    let dir = media_dir(&app, &project_id)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    Ok(names)
}

/// Deletes one media file. Removing something that is already gone succeeds.
#[tauri::command]
pub fn bluper_remove_media<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    media_id: String,
) -> Result<()> {
    validate_segment(&media_id, "media id")?;
    let path = media_dir(&app, &project_id)?.join(media_id);
    ignore_not_found(fs::remove_file(&path))
}

/// Deletes every media file for a project, and the directory holding them.
#[tauri::command]
pub fn bluper_clear_media<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<()> {
    let dir = media_dir(&app, &project_id)?;
    ignore_not_found(fs::remove_dir_all(&dir))?;
    // The project's own directory has nothing else in it once the media is
    // gone; leaving it behind would accumulate an empty directory per project
    // the user ever deleted. `remove_dir` fails if anything is still there,
    // which is exactly the behaviour wanted.
    if let Some(parent) = dir.parent() {
        let _ = fs::remove_dir(parent);
    }
    Ok(())
}

/// Size of a media file, or `None` when it doesn't exist.
#[tauri::command]
pub fn bluper_media_size<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    media_id: String,
) -> Result<Option<u64>> {
    validate_segment(&media_id, "media id")?;
    let path = media_dir(&app, &project_id)?.join(media_id);
    match fs::metadata(&path) {
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// A path in the app's cache directory for an in-progress export. Exports are
/// written here as they encode and moved to the user's chosen file at the end,
/// so a cancelled or crashed export never leaves a half-written video where the
/// user asked for a finished one.
#[tauri::command]
pub fn bluper_scratch_path<R: Runtime>(app: AppHandle<R>, name: String) -> Result<String> {
    validate_segment(&name, "scratch file name")?;
    let dir = app_cache_dir(&app)?.join("exports");
    fs::create_dir_all(&dir)?;
    Ok(dir.join(name).to_string_lossy().into_owned())
}

/// Opens `path` for writing, truncating anything already there, and returns the
/// id used by [`bluper_write_chunk`] and [`bluper_close_write`].
#[tauri::command]
pub fn bluper_open_write<R: Runtime>(
    app: AppHandle<R>,
    streams: State<'_, WriteStreams>,
    path: String,
) -> Result<u64> {
    let path = ensure_writable_root(&app, Path::new(&path))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::create(&path)?;
    Ok(streams.insert(WriteStream {
        path,
        writer: BufWriter::with_capacity(WRITE_BUFFER_BYTES, file),
        cursor: 0,
        length: 0,
    }))
}

/// Writes the raw request body to an open stream and returns the file's length
/// so far. The body arrives as `application/octet-stream`, never as JSON — this
/// is what keeps a multi-gigabyte write off the JS heap.
///
/// An optional `stream-position` header places the write; without it the bytes
/// go wherever the previous write left off.
#[tauri::command]
pub fn bluper_write_chunk(
    request: Request<'_>,
    streams: State<'_, WriteStreams>,
) -> Result<u64> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };

    let id: u64 = header("stream-id")
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| err("write chunk is missing a valid stream-id header"))?;
    let position: Option<u64> = match header("stream-position") {
        Some(value) => Some(
            value
                .parse()
                .map_err(|_| err(format!("invalid stream-position header: {value}")))?,
        ),
        None => None,
    };

    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(err("write chunk expects a raw (binary) request body"));
    };

    streams.with(id, |stream| {
        if let Some(position) = position {
            if position != stream.cursor {
                // `BufWriter` flushes before it seeks, so the buffered bytes
                // still land at the offset they were written for.
                stream.writer.seek(SeekFrom::Start(position))?;
                stream.cursor = position;
            }
        }
        stream.writer.write_all(bytes)?;
        stream.cursor += bytes.len() as u64;
        stream.length = stream.length.max(stream.cursor);
        Ok(stream.length)
    })
}

/// Flushes and closes a stream, returning the length of the finished file.
#[tauri::command]
pub fn bluper_close_write(streams: State<'_, WriteStreams>, id: u64) -> Result<u64> {
    let mut stream = streams
        .take(id)
        .ok_or_else(|| err(format!("write stream {id} is not open")))?;
    stream.writer.flush()?;
    // Exports are handed to the user as a file path the moment this resolves,
    // so the bytes need to have reached the filesystem, not just the page cache
    // of a process that might be about to exit.
    stream.writer.get_ref().sync_all()?;
    Ok(stream.length)
}

/// Closes a stream and deletes the partial file. Used when an import or export
/// is cancelled or fails.
#[tauri::command]
pub fn bluper_abort_write(streams: State<'_, WriteStreams>, id: u64) -> Result<()> {
    let Some(stream) = streams.take(id) else {
        return Ok(());
    };
    let path = stream.path.clone();
    drop(stream);
    ignore_not_found(fs::remove_file(&path))
}

/// Deletes a file this app owns — a scratch export the user cancelled out of,
/// for instance. Paths outside the app's own directories are rejected.
#[tauri::command]
pub fn bluper_remove_file<R: Runtime>(app: AppHandle<R>, path: String) -> Result<()> {
    let path = ensure_writable_root(&app, Path::new(&path))?;
    ignore_not_found(fs::remove_file(&path))
}

/// Moves a finished scratch file to its destination. `rename` fails across
/// filesystems (the cache directory and the user's home are often on different
/// mounts), so fall back to a streaming copy rather than reading the file into
/// memory to move it.
#[tauri::command]
pub fn bluper_move_file<R: Runtime>(
    app: AppHandle<R>,
    from: String,
    to: String,
) -> Result<()> {
    let from = ensure_writable_root(&app, Path::new(&from))?;
    let to = normalize(Path::new(&to));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }

    if fs::rename(&from, &to).is_err() {
        fs::copy(&from, &to)?;
        fs::remove_file(&from)?;
    }
    Ok(())
}

/// How long an abandoned scratch export is kept before startup reclaims it. A
/// long enough window that a running export is never touched, short enough that
/// a crash mid-render doesn't leave gigabytes sitting in the cache forever.
const SCRATCH_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Deletes scratch exports left behind by a crash or a kill. An export that
/// completes normally removes its own file, so anything still here that is
/// older than [`SCRATCH_MAX_AGE`] has been orphaned.
pub fn sweep_stale_scratch_files<R: Runtime>(app: &AppHandle<R>) {
    let Ok(cache) = app_cache_dir(app) else { return };
    let dir = cache.join("exports");
    let Ok(entries) = fs::read_dir(&dir) else { return };

    let mut reclaimed = 0u64;
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > SCRATCH_MAX_AGE);
        if is_stale && fs::remove_file(entry.path()).is_ok() {
            reclaimed += metadata.len();
        }
    }

    if reclaimed > 0 {
        log::info!("reclaimed {reclaimed} bytes of abandoned export scratch files");
    }
}

/// When the self-check last said anything. A check can take the webview's
/// process down with it — a WebCodecs encoder that aborts rather than failing is
/// enough — and then no result is ever reported and no summary is ever reached.
/// The shell watches this to give the terminal back instead of leaving a window
/// nobody asked for. See [`crate::run`].
static LAST_DIAGNOSTIC_AT: LazyLock<Mutex<Instant>> =
    LazyLock::new(|| Mutex::new(Instant::now()));

fn touch_diagnostic_clock() {
    if let Ok(mut at) = LAST_DIAGNOSTIC_AT.lock() {
        *at = Instant::now();
    }
}

/// How long the self-check has been silent. Zero when the clock is unreadable,
/// so a poisoned lock can never be mistaken for a stalled run.
pub fn since_last_diagnostic() -> Duration {
    LAST_DIAGNOSTIC_AT
        .lock()
        .map(|at| at.elapsed())
        .unwrap_or_default()
}

/// Prints a line from the desktop self-check to the app's log and to stdout,
/// so `/desktop-check` can be run headlessly and read from a terminal.
///
/// Under `BLUPER_SELFTEST=1` the run's last line also ends the process, with the
/// result as the exit code. That mode exists to be read from a terminal, and a
/// window left sitting open afterwards makes it unusable from a script — worse,
/// closing it by hand truncates the output of whatever was still running. A run
/// started from the page by hand only logs.
#[tauri::command]
pub fn bluper_diagnostic_log<R: Runtime>(app: AppHandle<R>, line: String) {
    println!("[desktop-check] {line}");
    log::info!("[desktop-check] {line}");
    touch_diagnostic_clock();

    if !crate::selftest_enabled() {
        return;
    }

    if let Some(summary) = line.strip_prefix("DONE ") {
        // "DONE 26/27 passed"
        let all_passed = summary
            .split_once('/')
            .and_then(|(passed, rest)| Some(passed == rest.split_whitespace().next()?))
            .unwrap_or(false);
        app.exit(if all_passed { 0 } else { 1 });
    } else if line.starts_with("FAIL harness") {
        app.exit(1);
    }
}

/// Free space on the filesystem holding the app's media, in bytes. The webview's
/// `navigator.storage.estimate()` reports a sandbox quota that has nothing to do
/// with the disk once media lives on the real filesystem, so the editor asks
/// here instead.
#[tauri::command]
pub fn bluper_available_disk_bytes<R: Runtime>(app: AppHandle<R>) -> Result<Option<u64>> {
    let dir = app_data_dir(&app)?;
    fs::create_dir_all(&dir)?;
    Ok(available_bytes(&dir))
}

#[cfg(unix)]
fn available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` only reads through the path pointer and writes into the
    // zeroed struct we hand it; both outlive the call.
    let stats = unsafe {
        let mut stats: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stats) != 0 {
            return None;
        }
        stats
    };
    // `f_bavail` is what a non-root process may actually use, which is what the
    // editor needs to decide whether an import fits.
    (stats.f_bavail as u64).checked_mul(stats.f_frsize as u64)
}

/// `GetDiskFreeSpaceExW` reports free space for the volume holding `path`, and
/// its first out-param is the quota-aware figure — the Windows analogue of
/// `f_bavail`, which is what the editor needs to decide whether an import fits.
#[cfg(windows)]
fn available_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // The W entry point takes a NUL-terminated UTF-16 path. `encode_wide` does
    // not add the terminator, and an interior NUL would truncate the path, so
    // reject that rather than querying the wrong directory.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return None;
    }
    wide.push(0);

    let mut free_to_caller: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call. The API only
    // writes through the out-params, and the two we don't want are passed as
    // null, which it documents as permitted.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free_to_caller)
}

#[cfg(not(any(unix, windows)))]
fn available_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_in_segments() {
        assert!(validate_segment("..", "project id").is_err());
        assert!(validate_segment("a/b", "project id").is_err());
        assert!(validate_segment("../../etc/passwd", "project id").is_err());
        assert!(validate_segment("", "project id").is_err());
        assert!(validate_segment("with space", "project id").is_err());
    }

    #[test]
    fn accepts_generated_ids() {
        assert!(validate_segment("3f2504e0-4f89-11d3-9a0c-0305e82c3301", "media id").is_ok());
        assert!(validate_segment("export_1.mp4", "scratch name").is_ok());
    }

    #[test]
    fn normalize_strips_parent_components() {
        assert_eq!(
            normalize(Path::new("/home/u/.local/share/app/../../../etc/passwd")),
            PathBuf::from("/home/u/etc/passwd")
        );
        assert_eq!(
            normalize(Path::new("/home/u/./media/clip")),
            PathBuf::from("/home/u/media/clip")
        );
        // Popping can never walk above the root, so a path made of nothing but
        // `..` still lands somewhere `ensure_writable_root` will reject.
        assert_eq!(
            normalize(Path::new("/a/../../../etc")),
            PathBuf::from("/etc")
        );
    }

    #[test]
    fn normalized_traversal_no_longer_starts_with_the_app_root() {
        let root = PathBuf::from("/home/u/.local/share/net.bluper.desktop");
        let escaped = normalize(Path::new(
            "/home/u/.local/share/net.bluper.desktop/../../../../etc/passwd",
        ));
        assert!(!escaped.starts_with(&root));
    }

    #[test]
    fn available_bytes_reports_a_positive_number_for_a_real_directory() {
        // `temp_dir` rather than a literal, so this covers the Windows
        // implementation on Windows instead of asking it about `/tmp`.
        let bytes = available_bytes(&std::env::temp_dir());
        assert!(bytes.is_some_and(|value| value > 0));
    }
}
