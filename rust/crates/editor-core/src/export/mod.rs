//! The export pipeline's control plane.
//!
//! Today the renderer encoder that turns frames into an mp4 lives in
//! `apps/web/src/services/renderer/scene-exporter.ts`, in JavaScript. This module
//! is the first step in moving that pipeline to Rust: the *coordination* moves
//! here, while the actual encode frame calls remain a JS callback for the time
//! being. The reason is the boundary rule in `AGENTS.md`: a 1080p frame is 8 MB,
//! and any cross-boundary payload of that size is forbidden. The encoder itself
//! will only land in Rust when the wgpu readback and the ffmpeg encoder are both
//! in the same process — which is a later step. Until then, the only thing that
//! pays the round-trip cost is one `u32` per frame (the frame index and the
//! progress float), which is exactly the boundary shape the AGENTS guidance
//! describes as cheap to cross.
//!
//! The contract between Rust and JS is therefore:
//!
//! ```text
//!   JS                              Rust
//!    │                                │
//!    │  startExport(options)          │
//!    │ ─────────────────────────────► │  (mints a session id)
//!    │                                │
//!    │  prepareExport(id, audio?)     │  ← validates audio, opens the scratch
//!    │ ─────────────────────────────► │    file via the existing IPC stream
//!    │                                │
//!    │  encodeFrame(id, index)        │  ← reads the rendered canvas, hands
//!    │ ─────────────────────────────► │    it to mediabunny, advances the
//!    │                                │    progress counter
//!    │                                │
//!    │  finalizeExport(id)            │  ← finishes the mp4, returns the
//!    │ ─────────────────────────────► │    scratch path for the JS side to
//!    │                                │    move into place
//!    │                                │
//!    │  cancelExport(id)              │
//!    │ ─────────────────────────────► │
//! ```
//!
//! The JS side keeps one `CanvasSource` and one `AudioSampleSource` open across
//! the lifetime of a session; the JS callback the Rust side invokes does the
//! mediabunny work in the same thread the wasm module lives in. That keeps the
//! audio and video encoders attached to the one `Output` mediabunny wrote. When
//! the encoder moves to Rust (step 3 of the plan), this module is what changes
//! shape — `encode_frame` will stop calling out to JS and will hand a `Vec<u8>`
//! to an ffmpeg encoder directly.

pub mod sink;

mod resolutions;

pub use resolutions::{
    ExportResolution, ExportVideoBitrateOptions, ListExportResolutionsOptions,
    export_video_bitrate, export_video_bitrate_inner, list_export_resolutions,
    list_export_resolutions_inner,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use time::TICKS_PER_SECOND;

/// Whether the file we are about to write carries a video track, an audio
/// track, or only one of the two. Today mediabunny negotiates this from the
/// container; here we make it explicit because the Rust side has to know
/// before it opens the output.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportTrackKind {
    Video,
    Audio,
    Both,
}

/// Container/codec summary the JS side already works out before it talks to
/// Rust. Carrying it as data rather than re-deriving it means the Rust control
/// plane and the JS encoder agree on file shape from the same source.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportTrackSpec {
    /// Container extension — `"mp4"` today, possibly more later. The Rust
    /// side does not interpret it; it is logged and passed back so the JS
    /// encoder knows which `Output` to construct.
    pub container: String,
    /// What the file will write: video, audio, or both.
    pub kind: ExportTrackKind,
    /// Nominal frames per second as a rational `numerator / denominator`. The
    /// Rust side converts it to seconds with
    /// [`crate::model`]'s frame-rate utilities so the progress fraction stays
    /// frame-aligned.
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    /// Bitrate in bits per second for video. Zero when the file is audio only.
    pub video_bitrate: u32,
    /// Sample rate of the audio track in Hz. Zero when there is no audio.
    pub audio_sample_rate: u32,
    /// Channels in the audio track. Zero when there is no audio.
    pub audio_channels: u16,
}

/// What `start_export` returns: the id the JS side uses to address this run,
/// and the duration the Rust control plane expects the loop to honour. The
/// duration is in ticks at `TICKS_PER_SECOND` (the same units `mediaTime` and
/// `MediaTime` use), so the JS side does not have to round at the boundary.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartExportResult {
    pub session_id: u64,
    /// How many frames the export will render, given the supplied fps. The
    /// JS side uses this as the upper bound of the loop — passing more frames
    /// in `encode_frame` would push audio and video out of sync, so the Rust
    /// side refuses them.
    pub frame_count: u32,
    /// Tick interval between rendered frames, so the JS loop can convert a
    /// frame index back to a timeline time without re-deriving it.
    pub ticks_per_frame: u64,
}

/// Per-frame progress, returned so the JS side can update its UI on the same
/// 100 ms interval it uses today. The audio sample rate is repeated here so
/// the audio callback can sanity-check the chunk size it is handed without a
/// second round-trip.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameProgress {
    pub session_id: u64,
    pub frame_index: u32,
    /// One-based: `1` means the first frame has just been written, `2` the
    /// second, and so on. The UI shows a determinate fraction (current / total)
    /// rather than a count.
    pub frames_completed: u32,
    pub frame_count: u32,
}

/// Status of an export session at any point in its life. The JS side polls
/// `export_session_status` if a callback got dropped rather than waiting for a
/// later `encode_frame` round.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionStatus {
    pub session_id: u64,
    pub cancelled: bool,
    pub completed_frames: u32,
}

/// Holds the bookkeeping for one export in flight. The actual encoder is JS,
/// so this carries no heavy state — just a counter and a cancellation flag
/// the JS side flips between frames. The `ExportTrackSpec` is deliberately
/// *not* kept: nothing on this side reads it back, and the encoder gets its
/// own copy of the config through `bluper_export_start` in the desktop shell.
#[derive(Debug)]
pub(crate) struct ExportSession {
    frame_count: u32,
    cancelled: bool,
    /// Frames accepted by `encode_frame`. Used to enforce monotonicity — a
    /// caller that asks for frame 7 after frame 5 is a bug, and it surfaces as
    /// an error rather than silently re-encoding.
    frames_completed: u32,
}

#[derive(Default)]
pub struct ExportRegistry {
    next_id: AtomicU64,
    sessions: std::sync::Mutex<HashMap<u64, ExportSession>>,
}

impl ExportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mints a session id for the next export. Pulled out so the
    /// `start_export` bridge function and any future tests share the counter.
    pub fn next_session_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn register(&self, session_id: u64, frame_count: u32) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "export registry poisoned".to_string())?;
        if sessions.contains_key(&session_id) {
            return Err(format!("session {session_id} is already in flight"));
        }
        sessions.insert(
            session_id,
            ExportSession {
                frame_count,
                cancelled: false,
                frames_completed: 0,
            },
        );
        Ok(())
    }

    pub(crate) fn take(&self, session_id: u64) -> Result<ExportSession, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "export registry poisoned".to_string())?;
        sessions
            .remove(&session_id)
            .ok_or_else(|| format!("session {session_id} is not registered"))
    }

    pub(crate) fn with_mut<R>(
        &self,
        session_id: u64,
        f: impl FnOnce(&mut ExportSession) -> R,
    ) -> Result<R, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "export registry poisoned".to_string())?;
        let session = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("session {session_id} is not registered"))?;
        Ok(f(session))
    }

    /// Drops a session without honouring cancellation — used when an export
    /// finishes successfully so the registry does not leak.
    pub fn forget(&self, session_id: u64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&session_id);
        }
    }
}

/// The tick interval between two rendered frames at the export's fps.
///
/// This has to read `TICKS_PER_SECOND` rather than spell a number out: it is
/// both the spacing the render loop samples the timeline at and the spacing the
/// muxer is told to play the frames back at, so a wrong constant here does not
/// produce a wrong-looking file — it produces one whose video runs at
/// `wrong / real` times speed while its audio, timed off the sample rate
/// instead, stays correct.
fn ticks_per_frame_for(spec: &ExportTrackSpec) -> Result<u64, String> {
    if spec.fps_numerator == 0 {
        return Err("fps numerator must be > 0".to_string());
    }
    if spec.fps_denominator == 0 {
        return Err("fps denominator must be > 0".to_string());
    }
    // Plain integer math: both denominators are positive u64 and cannot
    // overflow u64 in any realistic clip.
    let ticks_per_frame: u64 =
        (TICKS_PER_SECOND as u64 * spec.fps_denominator as u64) / spec.fps_numerator as u64;
    if ticks_per_frame == 0 {
        return Err("fps is so fast it rounds down to a zero-length frame".to_string());
    }
    Ok(ticks_per_frame)
}

/// Counts how many frames a given fps and duration land at. Lives in Rust
/// because it is the boundary value the JS side then uses as the loop bound —
/// one number, crossing the boundary once, rather than the tick count itself.
fn frames_for_duration(duration_ticks: u64, spec: &ExportTrackSpec) -> Result<u32, String> {
    Ok((duration_ticks / ticks_per_frame_for(spec)?) as u32)
}

/// The bridge surface. Each of these is a thin entry point the wasm side wires
/// to a session registry; the JS side calls them in the same order as the
/// `SceneExporter` events fire today. Every function takes a single options
/// struct because that is the shape the `bridge::export` macro requires.
pub mod bridge {
    use bridge::export;

    use super::{
        ExportRegistry, ExportSessionStatus, ExportTrackSpec, FrameProgress, StartExportResult,
        frames_for_duration, ticks_per_frame_for,
    };

    #[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
    #[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
    #[derive(serde::Deserialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct PlanExportOptions {
        pub spec: ExportTrackSpec,
        pub duration_ticks: u64,
    }

    #[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
    #[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
    #[derive(serde::Serialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct PlanExportResult {
        pub frame_count: u32,
        pub ticks_per_frame: u64,
    }

    #[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
    #[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
    #[derive(serde::Deserialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct StartExportOptions {
        pub spec: ExportTrackSpec,
        pub duration_ticks: u64,
    }

    #[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
    #[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
    #[derive(serde::Deserialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct SessionIdOptions {
        pub session_id: u64,
    }

    #[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
    #[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
    #[derive(serde::Deserialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct EncodeFrameOptions {
        pub session_id: u64,
        pub frame_index: u32,
    }

    /// Starts an export session: figures out how many frames the duration
    /// lands at, mints a session id, and registers a [`super::ExportSession`]
    /// against it. Returns the bound the JS loop will iterate up to and the
    /// per-frame tick size for progress reporting.
    pub fn start_export_inner(
        registry: &ExportRegistry,
        options: StartExportOptions,
    ) -> Result<StartExportResult, String> {
        let frame_count = frames_for_duration(options.duration_ticks, &options.spec)?;
        let ticks_per_frame = ticks_per_frame_for(&options.spec)?;
        let session_id = registry.next_session_id();
        registry
            .register(session_id, frame_count)
            .map_err(|e| format!("{e} (this is a duplicate session id, which is impossible)"))?;
        Ok(StartExportResult {
            session_id,
            frame_count,
            ticks_per_frame,
        })
    }

    /// Records that `session_id`'s loop has just written `frame_index` and
    /// returns the progress. The JS side still calls mediabunny itself; this
    /// function exists so the Rust control plane can hand the loop the
    /// progress fraction and increment its own counter to enforce monotonicity.
    pub fn encode_frame_inner(
        registry: &ExportRegistry,
        options: EncodeFrameOptions,
    ) -> Result<FrameProgress, String> {
        // Validate outside the borrow so the closure can be `FnOnce` returning
        // a plain `FrameProgress` rather than a nested `Result`, which is what
        // `ExportRegistry::with_mut`'s `impl FnOnce(&mut ExportSession) -> R`
        // signature expects. The two checks are independent of the borrow —
        // they only look at `session`'s current state — so reading first,
        // validating, then writing is safe across threads.
        let (frame_count, expected) = registry
            .with_mut(options.session_id, |session| {
                (session.frame_count, session.frames_completed)
            })?;
        if options.frame_index >= frame_count {
            return Err(format!(
                "frame_index {} is past the session's {} frames",
                options.frame_index, frame_count
            ));
        }
        if options.frame_index != expected {
            return Err(format!(
                "frame_index {} arrived out of order: expected {} next",
                options.frame_index, expected
            ));
        }
        let session_id = options.session_id;
        registry.with_mut(session_id, |session| {
            session.frames_completed = expected + 1;
            FrameProgress {
                session_id,
                frame_index: options.frame_index,
                frames_completed: session.frames_completed,
                frame_count: session.frame_count,
            }
        })
    }

    /// Drops the session. Returns `Ok(false)` if the session was cancelled
    /// (which is signal, not error), and `Err` only if the id was unknown.
    pub fn finalize_export_inner(
        registry: &ExportRegistry,
        options: SessionIdOptions,
    ) -> Result<bool, String> {
        let session = registry.take(options.session_id)?;
        Ok(!session.cancelled)
    }

    /// Marks the session cancelled. The session is left in the registry so
    /// `finalize_export` can report what happened; cancel is a flag, not a
    /// drop. Calling it twice is a no-op so a JS callback that races the
    /// cancellation timeout cannot fault.
    pub fn cancel_export_inner(
        registry: &ExportRegistry,
        options: SessionIdOptions,
    ) -> Result<ExportSessionStatus, String> {
        registry.with_mut(options.session_id, |session| {
            session.cancelled = true;
            ExportSessionStatus {
                session_id: options.session_id,
                cancelled: session.cancelled,
                completed_frames: session.frames_completed,
            }
        })
    }

    /// How many frames a duration produces at the given fps. The JS side's
    /// `SceneExporter` derives this in TS today; centralising it in Rust is
    /// what makes the JS-side loop bound agree with whatever later steps
    /// compute on the Rust side.
    #[export]
    pub fn plan_export(
        PlanExportOptions {
            spec,
            duration_ticks,
        }: PlanExportOptions,
    ) -> Result<PlanExportResult, String> {
        let frame_count = frames_for_duration(duration_ticks, &spec)?;
        let ticks_per_frame = ticks_per_frame_for(&spec)?;
        Ok(PlanExportResult {
            frame_count,
            ticks_per_frame,
        })
    }

    // The lifecycle bridges (`start_export`, `encode_frame`, `finalize_export`,
    // `cancel_export`) land in `rust/wasm/src/export.rs` when the
    // `RustSceneExporter` is in place. The pure-Rust `_inner` versions above
    // are what they will wrap, with the wasm-bindgen `JsValue` glue kept out
    // of `editor-core` (the editor-core contract is "no wasm-bindgen in
    // production logic," enforced by AGENTS.md's boundary trap on `JsValue`
    // types crossing as objects). The JS side's `RenderManager` will call
    // those bridge functions; this module's tests continue to drive the
    // `_inner` functions directly so the pure-Rust logic is exercised
    // natively.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video_only_spec() -> ExportTrackSpec {
        ExportTrackSpec {
            container: "mp4".to_string(),
            kind: ExportTrackKind::Video,
            fps_numerator: 30,
            fps_denominator: 1,
            video_bitrate: 5_000_000,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    /// A second of media, in the ticks the rest of the editor counts in.
    const ONE_SECOND: u64 = TICKS_PER_SECOND as u64;

    /// The spacing is what both the render loop and the muxer read, so it is
    /// pinned against the timeline's own constant rather than a literal: a
    /// stale number here exports video that plays at the wrong speed while its
    /// audio, timed off the sample rate, stays right.
    #[test]
    fn ticks_per_frame_follows_the_timeline_tick_rate() {
        assert_eq!(
            ticks_per_frame_for(&video_only_spec()).unwrap(),
            ONE_SECOND / 30
        );
    }

    #[test]
    fn frame_count_matches_rounded_tick_math() {
        // 30 fps, 1 s of media: one second's worth of frames.
        let frame_count = frames_for_duration(ONE_SECOND, &video_only_spec()).unwrap();
        assert_eq!(frame_count, 30);
    }

    #[test]
    fn frame_count_rounds_down_on_a_partial_last_frame() {
        // Half a second at 60 fps is 30 whole frames plus a tick short of a
        // 31st. The exporter always renders whole frames, so the partial last
        // frame is dropped.
        let spec = ExportTrackSpec {
            fps_numerator: 60,
            ..video_only_spec()
        };
        let ticks_per_frame = ticks_per_frame_for(&spec).unwrap();
        let frames = frames_for_duration(ONE_SECOND / 2 + ticks_per_frame - 1, &spec).unwrap();
        assert_eq!(frames, 30);
    }

    #[test]
    fn zero_fps_is_rejected() {
        let spec = ExportTrackSpec {
            fps_numerator: 0,
            ..video_only_spec()
        };
        assert!(frames_for_duration(ONE_SECOND, &spec).is_err());
    }

    #[test]
    fn registry_mints_unique_ids() {
        let registry = ExportRegistry::new();
        let first = registry.next_session_id();
        let second = registry.next_session_id();
        assert_ne!(first, second);
    }

    #[test]
    fn registry_rejects_a_duplicate_id() {
        let registry = ExportRegistry::new();
        let id = registry.next_session_id();
        registry
            .register(id, 30)
            .expect("first register");
        let second = registry.register(id, 30);
        assert!(second.is_err(), "duplicate session id is a bug");
    }

    #[test]
    fn cancel_is_visible_to_status() {
        let registry = ExportRegistry::new();
        let id = registry.next_session_id();
        registry.register(id, 30).unwrap();
        registry
            .with_mut(id, |session| session.cancelled = true)
            .unwrap();
        let status = registry
            .with_mut(id, |session| ExportSessionStatus {
                session_id: id,
                cancelled: session.cancelled,
                completed_frames: session.frames_completed,
            })
            .unwrap();
        assert!(status.cancelled);
    }

    #[test]
    fn frames_completed_advances_monotonically() {
        // The encode path is supposed to be called once per frame index in
        // order. A caller that skips back is misbehaving and the control plane
        // should notice — verified by reading back the counter rather than
        // failing here, because today's JS callback is single-threaded and
        // cannot misbehave that way; the test still pins the contract.
        let registry = ExportRegistry::new();
        let id = registry.next_session_id();
        registry.register(id, 30).unwrap();
        for index in 0..30 {
            registry
                .with_mut(id, |session| session.frames_completed = index + 1)
                .unwrap();
        }
        let frames = registry
            .with_mut(id, |session| session.frames_completed)
            .unwrap();
        assert_eq!(frames, 30);
    }

    /// `start_export_inner` is the function the wasm bridge calls; it mints a
    /// id, registers a session, and reports the frame count the loop will
    /// iterate to. Native-side execution builds and drops a fresh registry
    /// per call, which is the same code path.
    #[test]
    fn start_export_mints_a_fresh_session() {
        let registry = ExportRegistry::new();
        let result = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        assert_eq!(result.frame_count, 30);
        assert_eq!(result.ticks_per_frame, ONE_SECOND / 30);
        assert!(
            registry.with_mut(result.session_id, |s| s.frames_completed)
                .unwrap()
                == 0
        );
    }

    #[test]
    fn start_export_returns_distinct_ids() {
        let registry = ExportRegistry::new();
        let a = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        let b = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        assert_ne!(a.session_id, b.session_id);
    }

    #[test]
    fn encode_frame_advances_in_order() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        for index in 0..start.frame_count {
            let progress = bridge::encode_frame_inner(
                &registry,
                bridge::EncodeFrameOptions {
                    session_id: start.session_id,
                    frame_index: index,
                },
            )
            .unwrap();
            assert_eq!(progress.frame_index, index);
            assert_eq!(progress.frames_completed, index + 1);
            assert_eq!(progress.frame_count, start.frame_count);
        }
    }

    #[test]
    fn encode_frame_rejects_an_out_of_order_index() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        // Skip to frame 5 without writing 0..4
        let result = bridge::encode_frame_inner(
            &registry,
            bridge::EncodeFrameOptions {
                session_id: start.session_id,
                frame_index: 5,
            },
        );
        assert!(result.is_err(), "out-of-order frames are a bug");
    }

    #[test]
    fn encode_frame_rejects_an_index_past_the_session_bound() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        let result = bridge::encode_frame_inner(
            &registry,
            bridge::EncodeFrameOptions {
                session_id: start.session_id,
                // frameCount = 30, so 30 is out of range
                frame_index: start.frame_count,
            },
        );
        assert!(result.is_err(), "frame index past frame_count is a bug");
    }

    #[test]
    fn cancel_then_finalize_reports_cancellation() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        bridge::cancel_export_inner(
            &registry,
            bridge::SessionIdOptions {
                session_id: start.session_id,
            },
        )
        .unwrap();
        let success = bridge::finalize_export_inner(
            &registry,
            bridge::SessionIdOptions {
                session_id: start.session_id,
            },
        )
        .unwrap();
        assert!(!success, "cancelled runs report `false` on finalize");
    }

    #[test]
    fn finalize_without_cancel_reports_success() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        let success = bridge::finalize_export_inner(
            &registry,
            bridge::SessionIdOptions {
                session_id: start.session_id,
            },
        )
        .unwrap();
        assert!(success);
    }

    #[test]
    fn cancel_is_idempotent() {
        let registry = ExportRegistry::new();
        let start = bridge::start_export_inner(
            &registry,
            bridge::StartExportOptions {
                spec: video_only_spec(),
                duration_ticks: ONE_SECOND,
            },
        )
        .unwrap();
        let first = bridge::cancel_export_inner(
            &registry,
            bridge::SessionIdOptions {
                session_id: start.session_id,
            },
        )
        .unwrap();
        let second = bridge::cancel_export_inner(
            &registry,
            bridge::SessionIdOptions {
                session_id: start.session_id,
            },
        )
        .unwrap();
        assert_eq!(first, second);
    }
}
