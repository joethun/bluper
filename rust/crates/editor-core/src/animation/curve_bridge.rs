//! Conversion between a segment's stored handles and the normalised
//! `cubic-bezier(x1, y1, x2, y2)` form the curve editor works in.
//!
//! Unlike the evaluator, this runs when someone drags a curve rather than once
//! per frame per property, so the two keys can cross the boundary per call
//! without the cost mattering.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use super::bezier::{
    DefaultHandleOptions, ScalarAnimationKey, default_left_handle, default_right_handle,
};

/// Below this, a segment counts as flat and its own value span cannot set the
/// vertical scale.
const VALUE_EPSILON: f64 = 1e-6;

/// A handle as it is *stored* on a key: a whole number of ticks. Distinct from
/// the `CurveHandle` the solver uses, whose `dt` may be a fraction of a tick
/// because a default handle is a third of the span.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCurveHandle {
    pub dt: MediaTime,
    pub dv: f64,
}

/// The normalised `cubic-bezier(x1, y1, x2, y2)` control points.
///
/// A named struct rather than a four-element sequence: `Vec<f64>` crosses the
/// boundary as an object with numeric keys, not a JS array, so a caller
/// destructuring it as a tuple silently gets `undefined`s. The façade turns this
/// back into the tuple TypeScript uses.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurveHandlePair {
    pub right_handle: StoredCurveHandle,
    pub left_handle: StoredCurveHandle,
}

/// Project a fractional tick count onto the integer lattice the way
/// `roundMediaTime` does: half away from zero, and `-0` normalised to `0` so it
/// cannot reach stored data. Rust's `f64::round` already rounds away from zero;
/// the zero case is the part that has to be written out.
fn round_ticks(time: f64) -> MediaTime {
    let magnitude = time.abs().round();
    if magnitude == 0.0 {
        return MediaTime::ZERO;
    }
    MediaTime::from_ticks(if time < 0.0 {
        -magnitude as i64
    } else {
        magnitude as i64
    })
}

fn clamp01(value: f64) -> f64 {
    value.max(0.0).min(1.0)
}

/// The vertical scale for the segment: its own value span, or the caller's
/// reference when the segment is flat, or nothing when neither is usable.
fn effective_span_value(span_value: f64, reference_span_value: Option<f64>) -> Option<f64> {
    if span_value.abs() > VALUE_EPSILON {
        return Some(span_value);
    }
    match reference_span_value {
        Some(reference) if reference.abs() > VALUE_EPSILON => Some(reference),
        _ => None,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedCubicBezierOptions {
    pub left_key: ScalarAnimationKey,
    pub right_key: ScalarAnimationKey,
    /// Y-axis scale to fall back on when the segment is flat.
    #[serde(default)]
    pub reference_span_value: Option<f64>,
}

#[export]
pub fn get_normalized_cubic_bezier_for_scalar_segment(
    NormalizedCubicBezierOptions {
        left_key,
        right_key,
        reference_span_value,
    }: NormalizedCubicBezierOptions,
) -> Option<NormalizedCubicBezier> {
    let span_time = (right_key.time.as_ticks() - left_key.time.as_ticks()) as f64;
    let span_value = right_key.value - left_key.value;
    let effective = effective_span_value(span_value, reference_span_value)?;
    if span_time == 0.0 {
        return None;
    }

    let right_handle = left_key.right_handle.unwrap_or_else(|| {
        default_right_handle(DefaultHandleOptions {
            left_key: left_key.clone(),
            right_key: right_key.clone(),
        })
    });
    let left_handle = right_key.left_handle.unwrap_or_else(|| {
        default_left_handle(DefaultHandleOptions {
            left_key: left_key.clone(),
            right_key: right_key.clone(),
        })
    });

    Some(NormalizedCubicBezier {
        x1: clamp01(right_handle.dt / span_time),
        y1: right_handle.dv / effective,
        x2: clamp01(1.0 + left_handle.dt / span_time),
        y2: 1.0 + left_handle.dv / effective,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CurveHandlesOptions {
    pub left_key: ScalarAnimationKey,
    pub right_key: ScalarAnimationKey,
    pub cubic_bezier: Vec<f64>,
    #[serde(default)]
    pub reference_span_value: Option<f64>,
}

#[export]
pub fn get_curve_handles_for_normalized_cubic_bezier(
    CurveHandlesOptions {
        left_key,
        right_key,
        cubic_bezier,
        reference_span_value,
    }: CurveHandlesOptions,
) -> Option<CurveHandlePair> {
    let span_time = (right_key.time.as_ticks() - left_key.time.as_ticks()) as f64;
    let span_value = right_key.value - left_key.value;
    let effective = effective_span_value(span_value, reference_span_value)?;
    if span_time == 0.0 {
        return None;
    }

    // A four-element curve is the contract; anything else is a caller bug, and
    // reading past the end would be worse than declining.
    let [raw_x1, y1, raw_x2, y2] = <[f64; 4]>::try_from(cubic_bezier.as_slice()).ok()?;
    let x1 = clamp01(raw_x1);
    let x2 = clamp01(raw_x2);

    Some(CurveHandlePair {
        right_handle: StoredCurveHandle {
            dt: round_ticks(span_time * x1),
            dv: effective * y1,
        },
        left_handle: StoredCurveHandle {
            dt: round_ticks(span_time * (x2 - 1.0)),
            dv: effective * (y2 - 1.0),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::super::bezier::{ScalarSegmentType, TangentMode};
    use super::*;

    fn key(time: i64, value: f64) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: format!("key-{time}"),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: ScalarSegmentType::Bezier,
            tangent_mode: TangentMode::Auto,
        }
    }

    #[test]
    fn rounding_matches_the_typescript_including_negative_zero() {
        assert_eq!(round_ticks(0.5).as_ticks(), 1);
        assert_eq!(round_ticks(-0.5).as_ticks(), -1);
        assert_eq!(round_ticks(1.4).as_ticks(), 1);
        assert_eq!(round_ticks(-1.5).as_ticks(), -2);
        // `-0.4` rounds to `-0` in float; storing that would put a negative zero
        // into the document.
        let rounded = round_ticks(-0.4);
        assert_eq!(rounded.as_ticks(), 0);
        assert!(!(rounded.as_ticks() as f64).is_sign_negative());
    }

    #[test]
    fn default_handles_normalise_to_the_even_thirds_curve() {
        let curve = get_normalized_cubic_bezier_for_scalar_segment(NormalizedCubicBezierOptions {
            left_key: key(0, 0.0),
            right_key: key(300, 30.0),
            reference_span_value: None,
        })
        .expect("a sloped segment has a curve");
        // Defaults sit a third along in both axes.
        assert!((curve.x1 - 1.0 / 3.0).abs() < 1e-12);
        assert!((curve.y1 - 1.0 / 3.0).abs() < 1e-12);
        assert!((curve.x2 - 2.0 / 3.0).abs() < 1e-12);
        assert!((curve.y2 - 2.0 / 3.0).abs() < 1e-12);
    }

    #[test]
    fn a_flat_segment_has_no_curve_without_a_reference() {
        let flat = || NormalizedCubicBezierOptions {
            left_key: key(0, 5.0),
            right_key: key(300, 5.0),
            reference_span_value: None,
        };
        assert!(get_normalized_cubic_bezier_for_scalar_segment(flat()).is_none());

        let with_reference = NormalizedCubicBezierOptions {
            reference_span_value: Some(10.0),
            ..flat()
        };
        assert!(get_normalized_cubic_bezier_for_scalar_segment(with_reference).is_some());
    }

    #[test]
    fn a_reference_below_the_epsilon_does_not_rescue_a_flat_segment() {
        let curve = get_normalized_cubic_bezier_for_scalar_segment(NormalizedCubicBezierOptions {
            left_key: key(0, 5.0),
            right_key: key(300, 5.0),
            reference_span_value: Some(1e-9),
        });
        assert!(curve.is_none());
    }

    #[test]
    fn a_zero_length_segment_has_no_curve() {
        assert!(
            get_normalized_cubic_bezier_for_scalar_segment(NormalizedCubicBezierOptions {
                left_key: key(100, 0.0),
                right_key: key(100, 30.0),
                reference_span_value: None,
            })
            .is_none()
        );
    }

    #[test]
    fn handles_and_curve_are_inverses_for_the_default_shape() {
        let left_key = key(0, 0.0);
        let right_key = key(300, 30.0);
        let curve = get_normalized_cubic_bezier_for_scalar_segment(NormalizedCubicBezierOptions {
            left_key: left_key.clone(),
            right_key: right_key.clone(),
            reference_span_value: None,
        })
        .expect("curve");

        let handles = get_curve_handles_for_normalized_cubic_bezier(CurveHandlesOptions {
            left_key: left_key.clone(),
            right_key: right_key.clone(),
            cubic_bezier: vec![curve.x1, curve.y1, curve.x2, curve.y2],
            reference_span_value: None,
        })
        .expect("handles");

        // 300 / 3 is a whole number of ticks, so the round trip is exact here.
        assert_eq!(handles.right_handle.dt.as_ticks(), 100);
        assert_eq!(handles.left_handle.dt.as_ticks(), -100);
        assert!((handles.right_handle.dv - 10.0).abs() < 1e-9);
        assert!((handles.left_handle.dv + 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_curve_that_is_not_four_numbers_is_declined_rather_than_read_past() {
        assert!(
            get_curve_handles_for_normalized_cubic_bezier(CurveHandlesOptions {
                left_key: key(0, 0.0),
                right_key: key(300, 30.0),
                cubic_bezier: vec![0.1, 0.2, 0.3],
                reference_span_value: None,
            })
            .is_none()
        );
    }

    #[test]
    fn the_x_components_are_clamped_into_the_segment() {
        let handles = get_curve_handles_for_normalized_cubic_bezier(CurveHandlesOptions {
            left_key: key(0, 0.0),
            right_key: key(300, 30.0),
            cubic_bezier: vec![5.0, 0.0, -5.0, 1.0],
            reference_span_value: None,
        })
        .expect("handles");
        // x1 clamps to 1 and x2 to 0, so the handles reach the far end and the
        // near end respectively rather than shooting outside the segment.
        assert_eq!(handles.right_handle.dt.as_ticks(), 300);
        assert_eq!(handles.left_handle.dt.as_ticks(), -300);
    }
}
