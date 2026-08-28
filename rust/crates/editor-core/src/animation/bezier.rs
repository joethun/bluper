//! Cubic-bezier segments between two scalar keyframes.
//!
//! Handle offsets are `f64` here, not `MediaTime`, and that is deliberate rather
//! than sloppy. A *stored* handle carries an integer tick offset, but a
//! *default* handle is a third of the span between two keys — `span / 3` — which
//! is fractional for all but every third tick. The TypeScript this replaces gets
//! that for free because the default-handle helpers have an inferred return type
//! of `{ dt: number; dv: number }` rather than the branded `CurveHandle` the
//! stored ones use. Typing `dt` as an integer here would truncate, and the curve
//! would sit a fraction of a tick away from where the editor drew it.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

/// Bisection steps taken to invert the time curve. Matches the TypeScript
/// constant exactly: the result is the midpoint of the surviving interval, so a
/// different count is a different answer, not a more accurate one.
const BEZIER_SOLVE_ITERATIONS: u32 = 20;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurveHandle {
    /// Tick offset from the key that owns the handle. Fractional for a default
    /// handle; a whole number for one the user has dragged.
    pub dt: f64,
    pub dv: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScalarSegmentType {
    Step,
    Linear,
    Bezier,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TangentMode {
    Auto,
    Aligned,
    Broken,
    Flat,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScalarAnimationKey {
    pub id: String,
    /// Relative to the element's start time.
    pub time: MediaTime,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left_handle: Option<CurveHandle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_handle: Option<CurveHandle>,
    pub segment_to_next: ScalarSegmentType,
    pub tangent_mode: TangentMode,
}

impl ScalarAnimationKey {
    fn time_f64(&self) -> f64 {
        self.time.as_ticks() as f64
    }
}

/// De Casteljau written out as the expanded polynomial, in the same term order
/// as the TypeScript. Float addition is not associative, so re-ordering these
/// terms changes the last bits of the result.
pub fn bezier_point(BezierPointOptions { progress, p0, p1, p2, p3 }: BezierPointOptions) -> f64 {
    let mt = 1.0 - progress;
    mt * mt * mt * p0
        + 3.0 * mt * mt * progress * p1
        + 3.0 * mt * progress * progress * p2
        + progress * progress * progress * p3
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BezierPointOptions {
    pub progress: f64,
    pub p0: f64,
    pub p1: f64,
    pub p2: f64,
    pub p3: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DefaultHandleOptions {
    pub left_key: ScalarAnimationKey,
    pub right_key: ScalarAnimationKey,
}

/// The outgoing handle of the left key when it has none of its own: a third of
/// the way towards the right key, along the straight line between them.
pub fn default_right_handle(
    DefaultHandleOptions { left_key, right_key }: DefaultHandleOptions,
) -> CurveHandle {
    let span = right_key.time_f64() - left_key.time_f64();
    let value_delta = right_key.value - left_key.value;
    CurveHandle {
        dt: span / 3.0,
        dv: value_delta / 3.0,
    }
}

/// The incoming handle of the right key when it has none of its own: the mirror
/// of [`default_right_handle`], pointing back the way it came.
pub fn default_left_handle(
    DefaultHandleOptions { left_key, right_key }: DefaultHandleOptions,
) -> CurveHandle {
    let span = right_key.time_f64() - left_key.time_f64();
    let value_delta = right_key.value - left_key.value;
    CurveHandle {
        dt: -span / 3.0,
        dv: -value_delta / 3.0,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolveBezierProgressOptions {
    pub time: f64,
    pub left_key: ScalarAnimationKey,
    pub right_key: ScalarAnimationKey,
}

/// Invert the segment's time curve: given a time, find the curve parameter that
/// produces it.
///
/// A cubic's time component is not invertible in closed form, so this bisects.
/// It always runs the full [`BEZIER_SOLVE_ITERATIONS`] and returns the midpoint
/// of the final interval — there is no early exit on convergence, because the
/// caller relies on the answer being the same every time rather than on it being
/// as close as possible.
pub fn solve_bezier_progress_for_time(
    SolveBezierProgressOptions { time, left_key, right_key }: SolveBezierProgressOptions,
) -> f64 {
    let mut lower = 0.0_f64;
    let mut upper = 1.0_f64;

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

    for _ in 0..BEZIER_SOLVE_ITERATIONS {
        let mid = (lower + upper) / 2.0;
        let estimate = bezier_point(BezierPointOptions {
            progress: mid,
            p0: left_key.time_f64(),
            p1: left_key.time_f64() + right_handle.dt,
            p2: right_key.time_f64() + left_handle.dt,
            p3: right_key.time_f64(),
        });
        if estimate < time {
            lower = mid;
        } else {
            upper = mid;
        }
    }

    (lower + upper) / 2.0
}

// The exported names mirror the TypeScript module they replace, so a call site
// reads the same after the swap.

#[export]
pub fn get_bezier_point(options: BezierPointOptions) -> f64 {
    bezier_point(options)
}

#[export]
pub fn get_default_right_handle(options: DefaultHandleOptions) -> CurveHandle {
    default_right_handle(options)
}

#[export]
pub fn get_default_left_handle(options: DefaultHandleOptions) -> CurveHandle {
    default_left_handle(options)
}

#[export]
pub fn solve_bezier_progress(options: SolveBezierProgressOptions) -> f64 {
    solve_bezier_progress_for_time(options)
}

#[cfg(test)]
mod tests {
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
    fn the_curve_passes_through_its_endpoints() {
        let options = |progress| BezierPointOptions {
            progress,
            p0: 10.0,
            p1: 20.0,
            p2: 30.0,
            p3: 40.0,
        };
        assert_eq!(bezier_point(options(0.0)), 10.0);
        assert_eq!(bezier_point(options(1.0)), 40.0);
    }

    #[test]
    fn evenly_spaced_controls_make_a_straight_line() {
        // p0..p3 at 0,1,2,3 is a straight ramp, so the curve is the identity.
        let at = |progress| {
            bezier_point(BezierPointOptions {
                progress,
                p0: 0.0,
                p1: 1.0,
                p2: 2.0,
                p3: 3.0,
            })
        };
        for step in 0..=10 {
            let progress = f64::from(step) / 10.0;
            assert!((at(progress) - progress * 3.0).abs() < 1e-12);
        }
    }

    #[test]
    fn a_default_handle_is_a_third_of_the_span_and_may_be_fractional() {
        // 100 ticks / 3 is not a whole number. Truncating it here is the bug
        // this type signature exists to prevent.
        let handle = default_right_handle(DefaultHandleOptions {
            left_key: key(0, 0.0),
            right_key: key(100, 30.0),
        });
        assert_eq!(handle.dt, 100.0 / 3.0);
        assert_eq!(handle.dv, 10.0);
        assert_ne!(handle.dt, handle.dt.trunc());
    }

    #[test]
    fn the_left_default_handle_mirrors_the_right_one() {
        let options = || DefaultHandleOptions {
            left_key: key(0, 0.0),
            right_key: key(100, 30.0),
        };
        let right = default_right_handle(options());
        let left = default_left_handle(options());
        assert_eq!(left.dt, -right.dt);
        assert_eq!(left.dv, -right.dv);
    }

    #[test]
    fn solving_a_straight_segment_recovers_the_fraction() {
        // With default handles the time curve is a straight ramp, so the
        // progress for a time is that time's fraction of the span.
        let progress = solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time: 25.0,
            left_key: key(0, 0.0),
            right_key: key(100, 1.0),
        });
        assert!((progress - 0.25).abs() < 1e-6, "got {progress}");
    }

    #[test]
    fn solving_clamps_to_the_ends_rather_than_running_away() {
        let before = solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time: -1000.0,
            left_key: key(0, 0.0),
            right_key: key(100, 1.0),
        });
        let after = solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time: 1000.0,
            left_key: key(0, 0.0),
            right_key: key(100, 1.0),
        });
        assert!((0.0..=1.0).contains(&before), "got {before}");
        assert!((0.0..=1.0).contains(&after), "got {after}");
    }

    #[test]
    fn a_stored_handle_is_used_in_place_of_the_default() {
        let mut left = key(0, 0.0);
        left.right_handle = Some(CurveHandle { dt: 90.0, dv: 0.0 });
        let mut right = key(100, 1.0);
        right.left_handle = Some(CurveHandle { dt: -90.0, dv: 0.0 });

        // Asked at the midpoint both curves answer 0.5, because each control
        // pair is symmetric about it — 90/10 and 33.3/66.7 alike. Ask off-centre
        // or the test passes whatever the handles do.
        let with_stored = solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time: 25.0,
            left_key: left,
            right_key: right,
        });
        let with_default = solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time: 25.0,
            left_key: key(0, 0.0),
            right_key: key(100, 1.0),
        });
        assert_ne!(with_stored, with_default);
    }

    #[test]
    fn the_solver_is_deterministic() {
        // No early exit on convergence: the same input has to give the same
        // answer, since callers compare resolved values for equality.
        let run = || {
            solve_bezier_progress_for_time(SolveBezierProgressOptions {
                time: 37.0,
                left_key: key(0, 0.0),
                right_key: key(100, 1.0),
            })
        };
        assert_eq!(run(), run());
    }
}
