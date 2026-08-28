//! Audio retiming math: the wrapper pieces that survive without
//! `OfflineAudioContext` or the `soundtouchjs` library. The library call itself
//! stays in the browser because it pulls PCM through `OfflineAudioContext` —
//! that bridge is not in scope here. What moves is the sizing/curve math the
//! browser calls *around* it.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::RetimeConfig;
use crate::retime::{clamp_curve_rate, get_source_time_at_clip_time, SourceTimeAtClipTimeOptions};

const TEMPO_UPDATE_INTERVAL_SECONDS: f64 = 0.1;
const RENDER_QUANTUM_FRAMES: f64 = 128.0;
const MAX_TEMPO_UPDATES: u32 = 512;

/// A linear interpolation sample between two adjacent frames. Out-of-range
/// positions are clamped (below zero returns the first sample, beyond the end
/// returns the last), which is what a frame buffer written outside its own
/// span wants — the next call will resync from the right place.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SampleLinearOptions {
    /// The channel samples, laid out in time order.
    pub channel_data: Vec<f64>,
    /// The fractional sample index to read. Integer indices return the
    /// exact frame; non-integer values blend the two neighbours.
    pub position: f64,
}

#[export]
pub fn sample_linear(
    SampleLinearOptions {
        channel_data,
        position,
    }: SampleLinearOptions,
) -> f64 {
    if position <= 0.0 {
        return *channel_data.first().unwrap_or(&0.0);
    }
    let lower = position.floor() as usize;
    if lower >= channel_data.len() {
        return 0.0;
    }
    let upper = (lower + 1).min(channel_data.len() - 1);
    let fraction = position - lower as f64;
    channel_data[lower] * (1.0 - fraction) + channel_data[upper] * fraction
}

/// The average speed a curve achieves over a window of clip time. Each render
/// window is given its own average tempo so the stretcher retunes to something
/// near the curve rather than chasing every spike, and the source the window
/// consumes is right to the sample: an under- or over-estimate by a fraction
/// of a percent would compound over a long clip.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AverageRateOverWindowOptions {
    pub from: f64,
    pub to: f64,
    pub clip_duration: f64,
    pub retime: RetimeConfig,
}

/// `to <= from` (the last window can be shorter) gets clamped to 1 — the
/// stretcher cannot play silence at a tempo of zero and the caller would
/// rather have a flat window than a no-op.
#[export]
pub fn average_rate_over_window(
    AverageRateOverWindowOptions {
        from,
        to,
        clip_duration,
        retime,
    }: AverageRateOverWindowOptions,
) -> f64 {
    let span = to - from;
    if span > 0.0 {
        let source_to = get_source_time_at_clip_time(SourceTimeAtClipTimeOptions {
            clip_time: to.min(clip_duration).max(0.0),
            clip_duration: Some(clip_duration),
            retime: Some(retime.clone()),
        });
        let source_from = get_source_time_at_clip_time(SourceTimeAtClipTimeOptions {
            clip_time: from.min(clip_duration).max(0.0),
            clip_duration: Some(clip_duration),
            retime: Some(retime),
        });
        clamp_curve_rate((source_to - source_from) / span)
    } else {
        clamp_curve_rate(1.0)
    }
}

/// The fields a curve-aware stretcher render needs to size its retune windows.
/// The browser side does the suspension scheduling on a quantum boundary — that
/// is part of the OfflineAudioContext orchestration, which is not in scope.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StretcherWindowPlanOptions {
    pub clip_duration: f64,
    pub target_sample_rate: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StretcherWindowPlan {
    /// How many retune windows the render will use.
    pub window_count: u32,
    /// How long each retune window is, in seconds. The last window may be
    /// shorter when `clip_duration` does not divide evenly.
    pub window_seconds: f64,
    /// The render-quantum length, in seconds. The stretcher can only be
    /// paused on a quantum boundary, so this is the granularity the caller
    /// schedules suspensions on.
    pub quantum_seconds: f64,
    /// How many quanta make up one retune window. Capped at 1 so a clip
    /// shorter than a single retune interval still gets one window.
    pub quanta_per_window: u32,
}

#[export]
pub fn stretcher_window_plan(
    StretcherWindowPlanOptions {
        clip_duration,
        target_sample_rate,
    }: StretcherWindowPlanOptions,
) -> StretcherWindowPlan {
    let quantum_seconds = RENDER_QUANTUM_FRAMES / target_sample_rate;
    let quanta_per_window = (TEMPO_UPDATE_INTERVAL_SECONDS / quantum_seconds).round().max(1.0) as u32;
    let window_count = MAX_TEMPO_UPDATES.min(
        (clip_duration / (quanta_per_window as f64 * quantum_seconds))
            .floor()
            .max(1.0) as u32,
    );
    let window_seconds = clip_duration / window_count as f64;
    StretcherWindowPlan {
        window_count,
        window_seconds,
        quantum_seconds,
        quanta_per_window,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_linear_at_integer_returns_the_frame() {
        let data = vec![0.0, 0.5, 1.0, 0.5];
        assert_eq!(
            sample_linear(SampleLinearOptions {
                channel_data: data.clone(),
                position: 1.0,
            }),
            0.5
        );
    }

    #[test]
    fn sample_linear_blends_neighbours() {
        let data = vec![0.0, 1.0];
        // Halfway: 0.0 * 0.5 + 1.0 * 0.5 = 0.5.
        assert_eq!(
            sample_linear(SampleLinearOptions {
                channel_data: data,
                position: 0.5,
            }),
            0.5
        );
    }

    #[test]
    fn sample_linear_below_zero_returns_the_first_sample() {
        let data = vec![0.5, 0.6, 0.7];
        assert_eq!(
            sample_linear(SampleLinearOptions {
                channel_data: data,
                position: -10.0,
            }),
            0.5
        );
    }

    #[test]
    fn sample_linear_past_the_end_returns_zero() {
        let data = vec![0.1, 0.2];
        assert_eq!(
            sample_linear(SampleLinearOptions {
                channel_data: data,
                position: 100.0,
            }),
            0.0
        );
    }

    #[test]
    fn window_plan_uses_at_least_one_window() {
        let plan = stretcher_window_plan(StretcherWindowPlanOptions {
            clip_duration: 0.001,
            target_sample_rate: 48000.0,
        });
        assert_eq!(plan.window_count, 1);
    }

    #[test]
    fn window_plan_caps_at_max_tempo_updates() {
        let plan = stretcher_window_plan(StretcherWindowPlanOptions {
            clip_duration: 1_000_000.0,
            target_sample_rate: 48000.0,
        });
        assert_eq!(plan.window_count, MAX_TEMPO_UPDATES);
    }
}
