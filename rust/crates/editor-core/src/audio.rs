//! Audio math that lives outside the browser's Web Audio API: sampling,
//! stretcher-window planning, peak finding, mixing, mastering. The
//! browser-bound glue (`OfflineAudioContext`, `soundtouchjs`) stays in
//! TypeScript; what moves here is the per-sample numerics, the mixer
//! itself, and the limiter that replaces `createDynamicsCompressor` for
//! the native export pipeline.

mod mastering;
#[cfg(not(target_arch = "wasm32"))]
mod mixer;
mod stretch;

pub use stretch::{
    AverageRateOverWindowOptions, SampleLinearOptions, StretcherWindowPlan,
    StretcherWindowPlanOptions, average_rate_over_window, sample_linear,
    stretcher_window_plan,
};

#[cfg(not(target_arch = "wasm32"))]
pub use mixer::{
    AudioClip, MixerContext, MixdownError, decode_to_planar_f32, mix_audio_clips,
    resample_planar,
};

#[cfg(not(target_arch = "wasm32"))]
pub use mastering::apply_peak_limiter;
