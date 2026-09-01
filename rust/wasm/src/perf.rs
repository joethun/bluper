#![cfg(target_arch = "wasm32")]

//! Per-frame profile buffer for the render pipeline.
//!
//! Sub-span timings are recorded into a thread-local during `renderFrame`
//! and drained by JS via `getLastFrameProfile()`.

use std::cell::RefCell;

use js_sys::{Array, Object, Reflect};
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

use crate::gpu::with_gpu_runtime;

thread_local! {
    static LAST_FRAME_PROFILE: RefCell<Vec<(&'static str, f64)>> = const { RefCell::new(Vec::new()) };
}

pub(crate) fn now_ms() -> f64 {
    web_sys::window()
        .and_then(|window| window.performance())
        .map(|performance| performance.now())
        .unwrap_or(0.0)
}

pub(crate) fn reset() {
    LAST_FRAME_PROFILE.with(|cell| cell.borrow_mut().clear());
}

pub(crate) fn record(name: &'static str, duration_ms: f64) {
    LAST_FRAME_PROFILE.with(|cell| cell.borrow_mut().push((name, duration_ms)));
}

#[wasm_bindgen(js_name = getLastFrameProfile)]
pub fn get_last_frame_profile() -> Array {
    LAST_FRAME_PROFILE.with(|cell| {
        let entries = cell.borrow();
        let array = Array::new_with_length(entries.len() as u32);
        for (index, (name, duration_ms)) in entries.iter().enumerate() {
            let entry = Object::new();
            Reflect::set(&entry, &JsValue::from_str("name"), &JsValue::from_str(name))
                .expect("set name");
            Reflect::set(
                &entry,
                &JsValue::from_str("durationMs"),
                &JsValue::from_f64(*duration_ms),
            )
            .expect("set durationMs");
            array.set(index as u32, entry.into());
        }
        array
    })
}

/// How many times the `VideoFrame` staging canvas has been built since the GPU
/// came up.
///
/// The staging canvas is what every decoded frame is drawn through on its way to
/// a texture, and it is sized by the layer's on-screen footprint — so keyed by
/// exact size it was thrown away and rebuilt at cuts between clips of different
/// resolutions, and on every frame where two such layers composited together.
/// It now only ever grows, and this is the number that says so: nothing else
/// about the failure is observable, since an allocation per frame reads only as a
/// dropped one.
#[wasm_bindgen(js_name = videoStagingAllocations)]
pub fn video_staging_allocations() -> Result<u32, JsValue> {
    with_gpu_runtime(|runtime| Ok(runtime.context.video_staging_allocations()))
}
