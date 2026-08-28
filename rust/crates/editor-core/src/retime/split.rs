//! Cutting a clip that carries a speed curve.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::{RetimeConfig, RetimeCurve};

use super::curve::{
    curve_clip_per_source, curve_source_fraction_at_clip_fraction, retime_curve,
    scale_retime_curve_rates, slice_retime_curve,
};
use super::presets::{BuildCurveRetimeOptions, build_curve_retime};
use super::resolve::{SourceTimeAtClipTimeOptions, get_source_time_at_clip_time};

/// A cut stretch of curve, retimed so it still takes exactly as long as the half
/// it belongs to.
///
/// Slicing recomputes the spline's tangents from the handles that survived, so
/// the shape over the kept span comes out very slightly different — enough that
/// the half's own length and the length its curve implies would disagree by a
/// fraction of a percent, and disagree again on every later cut. Nudging the
/// whole slice by one constant factor puts the two back in step without moving
/// any handle relative to its neighbours.
fn fit_curve_to_span(curve: &RetimeCurve, clip_span: f64, source_span: f64) -> RetimeCurve {
    if clip_span <= 0.0 || source_span <= 0.0 {
        return curve.clone();
    }

    let required_clip_per_source = clip_span / source_span;
    let actual_clip_per_source = curve_clip_per_source(curve);
    if required_clip_per_source <= 0.0 || actual_clip_per_source <= 0.0 {
        return curve.clone();
    }

    scale_retime_curve_rates(curve, actual_clip_per_source / required_clip_per_source)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpanAtClipTimeOptions {
    pub clip_time: f64,
    #[serde(default)]
    pub clip_duration: Option<f64>,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

#[export]
pub fn get_source_span_at_clip_time(
    SourceSpanAtClipTimeOptions {
        clip_time,
        clip_duration,
        retime,
    }: SourceSpanAtClipTimeOptions,
) -> f64 {
    get_source_time_at_clip_time(SourceTimeAtClipTimeOptions {
        clip_time,
        clip_duration,
        retime,
    })
    .max(0.0)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitRetime {
    pub left: Option<RetimeConfig>,
    pub right: Option<RetimeConfig>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SplitRetimeOptions {
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
    pub split_clip_time: f64,
    #[serde(default)]
    pub clip_duration: Option<f64>,
}

/// The retime each half of a cut clip keeps.
///
/// A single rate splits into itself — both halves still run at that speed. A
/// curve has to be cut where the clip was: each half keeps only the stretch of
/// shape over the material it still holds, renormalised across its own span, so
/// a cut through a speed ramp does not restart the ramp in both halves.
#[export]
pub fn split_retime_at_clip_time(
    SplitRetimeOptions {
        retime,
        split_clip_time,
        clip_duration,
    }: SplitRetimeOptions,
) -> SplitRetime {
    let curve = retime_curve(retime.as_ref()).cloned();
    let (Some(curve), Some(clip_duration)) = (
        curve,
        clip_duration.filter(|duration| *duration > 0.0),
    ) else {
        return SplitRetime {
            left: retime.clone(),
            right: retime,
        };
    };

    let clip_span = split_clip_time.max(0.0).min(clip_duration);
    let source_fraction =
        curve_source_fraction_at_clip_fraction(&curve, clip_span / clip_duration);
    let total_source_span = clip_duration / curve_clip_per_source(&curve);
    let left_source_span = total_source_span * source_fraction;
    let maintain_pitch = retime.as_ref().and_then(|config| config.maintain_pitch);

    SplitRetime {
        left: Some(build_curve_retime(BuildCurveRetimeOptions {
            curve: fit_curve_to_span(
                &slice_retime_curve(&curve, 0.0, source_fraction),
                clip_span,
                left_source_span,
            ),
            maintain_pitch,
        })),
        right: Some(build_curve_retime(BuildCurveRetimeOptions {
            curve: fit_curve_to_span(
                &slice_retime_curve(&curve, source_fraction, 1.0),
                clip_duration - clip_span,
                total_source_span - left_source_span,
            ),
            maintain_pitch,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::super::presets::{BuildRetimeCurvePresetOptions, build_retime_curve_preset};
    use super::*;
    use crate::model::RetimeCurvePresetId;

    fn curved(preset: RetimeCurvePresetId) -> RetimeConfig {
        build_curve_retime(BuildCurveRetimeOptions {
            curve: build_retime_curve_preset(BuildRetimeCurvePresetOptions { preset_id: preset }),
            maintain_pitch: Some(true),
        })
    }

    #[test]
    fn a_uniform_rate_splits_into_itself() {
        let retime = Some(RetimeConfig {
            rate: 2.0,
            maintain_pitch: Some(false),
            curve: None,
        });
        let split = split_retime_at_clip_time(SplitRetimeOptions {
            retime: retime.clone(),
            split_clip_time: 500.0,
            clip_duration: Some(1000.0),
        });
        assert_eq!(split.left, retime);
        assert_eq!(split.right, retime);
    }

    #[test]
    fn a_split_with_no_clip_length_cannot_cut_the_curve() {
        // Without the clip's length the handles cannot be turned back into
        // times, so both halves keep the whole curve rather than a wrong slice.
        let retime = Some(curved(RetimeCurvePresetId::Montage));
        let split = split_retime_at_clip_time(SplitRetimeOptions {
            retime: retime.clone(),
            split_clip_time: 500.0,
            clip_duration: None,
        });
        assert_eq!(split.left, retime);
        assert_eq!(split.right, retime);
    }

    #[test]
    fn the_two_halves_still_add_up_to_the_whole() {
        // The point of `fit_curve_to_span`: each half's curve has to imply the
        // length that half actually occupies, or repeated cuts drift.
        let clip_duration = 4000.0;
        let split_at = 1500.0;
        let retime = curved(RetimeCurvePresetId::Hero);
        let split = split_retime_at_clip_time(SplitRetimeOptions {
            retime: Some(retime.clone()),
            split_clip_time: split_at,
            clip_duration: Some(clip_duration),
        });

        let whole_source = clip_duration
            / curve_clip_per_source(retime.curve.as_ref().expect("curved"));
        let left = split.left.expect("left half");
        let right = split.right.expect("right half");
        let left_source =
            split_at / curve_clip_per_source(left.curve.as_ref().expect("curved"));
        let right_source = (clip_duration - split_at)
            / curve_clip_per_source(right.curve.as_ref().expect("curved"));

        let error = ((left_source + right_source) - whole_source).abs() / whole_source;
        assert!(error < 0.01, "halves drifted by {error}");
    }

    #[test]
    fn maintain_pitch_survives_the_cut() {
        let split = split_retime_at_clip_time(SplitRetimeOptions {
            retime: Some(curved(RetimeCurvePresetId::Bullet)),
            split_clip_time: 800.0,
            clip_duration: Some(2000.0),
        });
        assert_eq!(split.left.unwrap().maintain_pitch, Some(true));
        assert_eq!(split.right.unwrap().maintain_pitch, Some(true));
    }

    #[test]
    fn a_source_span_is_never_negative() {
        let span = get_source_span_at_clip_time(SourceSpanAtClipTimeOptions {
            clip_time: -5000.0,
            clip_duration: Some(1000.0),
            retime: None,
        });
        assert_eq!(span, 0.0);
    }
}
