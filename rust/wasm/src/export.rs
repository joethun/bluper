#![cfg(target_arch = "wasm32")]

//! The export pipeline's wasm-side bridge.
//!
//! The pure-Rust bookkeeping lives in `editor_core::export`; this module is
//! the `wasm-bindgen` glue that turns it into calls the JS side can make.
//! The split keeps `editor_core::export` free of `wasm-bindgen` types in its
//! produced logic — `AGENTS.md`'s boundary rule says a struct that
//! serialises as a map crosses as a JS `Map`, and the lifecycle structs
//! (`StartExportResult`, `FrameProgress`, `ExportSessionStatus`) cross the
//! boundary as tagged TypeScript objects. Putting the conversion here, where
//! `wasm-bindgen` is a direct dep rather than a gated feature, means a single
//! `pub use` re-export continues to put all of `editor_core::export::*` on
//! the wasm package's surface and the `tsify` machinery hands the types to
//! TypeScript.
//!
//! The session registry is shared across calls on a single thread; a new
//! session id is minted on `start_export`, registered against the registry,
//! and reached by the JS side through every follow-up call by id. There is
//! one registry per thread (`thread_local!`), which is right for the editor
//! — each export runs on the main thread and the registry outlives the call
//! because the export is one long user-paced operation, not a tight loop on
//! a worker.

use std::cell::RefCell;

use editor_core::export::bridge::{
    EncodeFrameOptions, SessionIdOptions, StartExportOptions,
};
use editor_core::export::{
    ExportRegistry, ExportSessionStatus, FrameProgress, StartExportResult,
};
use wasm_bindgen::prelude::wasm_bindgen;

thread_local! {
    static REGISTRY: RefCell<Option<ExportRegistry>> = const { RefCell::new(None) };
}

fn with_registry<F, R>(f: F) -> R
where
    F: FnOnce(&ExportRegistry) -> R,
{
    REGISTRY.with(|cell| {
        let mut borrow = cell.borrow_mut();
        if borrow.is_none() {
            *borrow = Some(ExportRegistry::new());
        }
        f(borrow.as_ref().expect("export registry just initialised"))
    })
}

// Every function here takes its options and returns its result as the
// `tsify` type rather than a `JsValue`. That is what makes the generated
// `.d.ts` carry a real signature instead of `(options: any): any` — a
// hand-rolled `serde_wasm_bindgen` round-trip compiles just as well but
// leaves the TypeScript side asserting its way back to a type nothing
// checks. The error half stays a `String`: `wasm_bindgen` throws it as a
// JavaScript string, which is what the JS façade already reports verbatim.

/// Mints a session id, registers it against the registry, and returns the
/// frame-count bound the JS loop will iterate up to. The `sessionId` returned
/// here is how every follow-up call reaches this run.
#[wasm_bindgen(js_name = startExport)]
pub fn start_export(options: StartExportOptions) -> Result<StartExportResult, String> {
    with_registry(|registry| editor_core::export::bridge::start_export_inner(registry, options))
}

/// Records that `session_id`'s loop has just written `frame_index` and
/// returns the progress fraction to the JS side. The control plane enforces
/// monotonicity: an out-of-order call is an error, not a silent reorder.
#[wasm_bindgen(js_name = encodeFrame)]
pub fn encode_frame(options: EncodeFrameOptions) -> Result<FrameProgress, String> {
    with_registry(|registry| editor_core::export::bridge::encode_frame_inner(registry, options))
}

/// Drops the session. `Ok(true)` means the run completed; `Ok(false)` means
/// it was cancelled (signal, not error); `Err` means the session id was
/// unknown, which is a programmer error in the calling JS.
#[wasm_bindgen(js_name = finalizeExport)]
pub fn finalize_export(options: SessionIdOptions) -> Result<bool, String> {
    with_registry(|registry| editor_core::export::bridge::finalize_export_inner(registry, options))
}

/// Sets the session's cancellation flag. Idempotent — a JS callback that
/// races with itself cannot fault the registry, and the eventual
/// `finalizeExport` will report `false` for "cancelled" either way.
#[wasm_bindgen(js_name = cancelExport)]
pub fn cancel_export(options: SessionIdOptions) -> Result<ExportSessionStatus, String> {
    with_registry(|registry| editor_core::export::bridge::cancel_export_inner(registry, options))
}
