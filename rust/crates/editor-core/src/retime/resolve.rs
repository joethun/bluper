//! The bijection between clip time and source time.

use bridge::export;
use serde::Deserialize;

use crate::model::{RetimeConfig, RetimeCurve};

use super::curve::{
    curve_clip_fraction_at_source_fraction, curve_clip_per_source, curve_rate_at_position,
    curve_source_fraction_at_clip_fraction, retime_curve,
};
use super::rate::clamp_retime_rate;

/// The source span a curved clip covers, from the length it occupies. A curve
/// keeps the material the trim exposes and changes how long the clip runs, so
/// dividing the clip's length by the curve's own stretch factor recovers the
/// span.
fn curve_source_span(curve: &RetimeCurve, clip_duration: f64) -> f64 {
    let clip_per_source = curve_clip_per_source(curve);
    if clip_per_source > 0.0 {
        clip_duration / clip_per_source
    } else {
        clip_duration
    }
}

/// A curve's average speed, for callers that cannot supply the clip's length.
/// Exact at the clip's ends and an approximation in between.
fn curve_average_rate(curve: &RetimeCurve) -> f64 {
    let clip_per_source = curve_clip_per_source(curve);
    if clip_per_source > 0.0 {
        1.0 / clip_per_source
    } else {
        1.0
    }
}

fn uniform_rate(retime: Option<&RetimeConfig>) -> f64 {
    clamp_retime_rate(retime.map_or(1.0, |config| config.rate))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceTimeAtClipTimeOptions {
    pub clip_time: f64,
    #[serde(default)]
    pub clip_duration: Option<f64>,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

/// Where in the source a clip is at `clipTime`.
///
/// `clipDuration` is what anchors a speed curve: the handles sit at fractions of
/// the clip rather than at times, so the clip's own length turns them back into
/// seconds. Times outside the clip's span are answered by continuing at the
/// speed of the nearest end — transitions ask both clips to keep playing past
/// their own edges.
#[export]
pub fn get_source_time_at_clip_time(
    SourceTimeAtClipTimeOptions {
        clip_time,
        clip_duration,
        retime,
    }: SourceTimeAtClipTimeOptions,
) -> f64 {
    let Some(curve) = retime_curve(retime.as_ref()) else {
        return clip_time * uniform_rate(retime.as_ref());
    };

    let Some(clip_duration) = clip_duration.filter(|duration| *duration > 0.0) else {
        return clip_time * curve_average_rate(curve);
    };

    let source_span = curve_source_span(curve, clip_duration);

    if clip_time <= 0.0 {
        return clip_time * curve_rate_at_position(curve, 0.0);
    }
    if clip_time >= clip_duration {
        return source_span
            + (clip_time - clip_duration) * curve_rate_at_position(curve, 1.0);
    }

    source_span * curve_source_fraction_at_clip_fraction(curve, clip_time / clip_duration)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipTimeAtSourceTimeOptions {
    pub source_time: f64,
    #[serde(default)]
    pub clip_duration: Option<f64>,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

#[export]
pub fn get_clip_time_at_source_time(
    ClipTimeAtSourceTimeOptions {
        source_time,
        clip_duration,
        retime,
    }: ClipTimeAtSourceTimeOptions,
) -> f64 {
    let Some(curve) = retime_curve(retime.as_ref()) else {
        return source_time / uniform_rate(retime.as_ref());
    };

    let Some(clip_duration) = clip_duration.filter(|duration| *duration > 0.0) else {
        return source_time / curve_average_rate(curve);
    };

    let source_span = curve_source_span(curve, clip_duration);

    if source_time <= 0.0 {
        return source_time / curve_rate_at_position(curve, 0.0);
    }
    if source_time >= source_span {
        return clip_duration
            + (source_time - source_span) / curve_rate_at_position(curve, 1.0);
    }

    // Mirrors the TypeScript exactly, `sourceSpan` multiplier included. It reads
    // like it should be `clipDuration`, but changing it here would be a silent
    // behaviour change rather than a port.
    source_span * curve_clip_fraction_at_source_fraction(curve, source_time / source_span)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDurationOptions {
    pub source_span: f64,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

/// How long a clip runs when it has to get through `sourceSpan` of material.
/// This is the whole reason a speed change resizes a clip, and for a curve it is
/// the curve's integral rather than a division.
#[export]
pub fn get_timeline_duration_for_source_span(
    TimelineDurationOptions {
        source_span,
        retime,
    }: TimelineDurationOptions,
) -> f64 {
    if source_span <= 0.0 {
        return 0.0;
    }

    match retime_curve(retime.as_ref()) {
        Some(curve) => source_span * curve_clip_per_source(curve),
        None => source_span / uniform_rate(retime.as_ref()),
    }
}
