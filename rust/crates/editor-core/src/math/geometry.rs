//! Plane geometry shared by the mask shapes, the preview handles and the
//! timeline's drag gestures — `apps/web/src/utils/geometry.ts`.
//!
//! The rotation helpers have no bridge function of their own: their only
//! TypeScript callers were the shape masks, which now ask for a whole outline,
//! and `masks::builtin::shapes` calls them here directly.
//!
//! Everything here is a pure function of a handful of numbers.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::js_number_to_string;

/// A point in whatever space the caller is working in — canvas units for the
/// mask shapes, client pixels for the drag thresholds.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeometryPoint {
    pub x: f64,
    pub y: f64,
}

/// Rotates an offset around the origin. Callers holding an absolute point and
/// a centre want [`rotate_point_around`]; this is the primitive both build on.
pub fn rotate_offset(dx: f64, dy: f64, rotation_rad: f64) -> GeometryPoint {
    let cos = rotation_rad.cos();
    let sin = rotation_rad.sin();

    GeometryPoint {
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos,
    }
}

pub fn rotate_point_around(
    x: f64,
    y: f64,
    center_x: f64,
    center_y: f64,
    rotation_rad: f64,
) -> GeometryPoint {
    let rotated = rotate_offset(x - center_x, y - center_y, rotation_rad);

    GeometryPoint {
        x: center_x + rotated.x,
        y: center_y + rotated.y,
    }
}

/// Whether a pointer has moved far enough from where it went down to count as
/// a drag rather than a click. Per-axis rather than by distance, which is what
/// makes a straight horizontal nudge cross the threshold at the same place a
/// diagonal one does.
pub fn exceeds_drag_threshold(
    current: GeometryPoint,
    origin: GeometryPoint,
    threshold: f64,
) -> bool {
    (current.x - origin.x).abs() > threshold || (current.y - origin.y).abs() > threshold
}

fn gcd(a: f64, b: f64) -> f64 {
    if b == 0.0 { a } else { gcd(b, a % b) }
}

/// `"16:9"` for 1920x1080 — the reduced form of the fraction, rendered with
/// JavaScript's number-to-string rules so a non-integer dimension formats the
/// way the caller's template literal used to.
pub fn dimension_to_aspect_ratio(width: f64, height: f64) -> String {
    let divisor = gcd(width, height);
    let aspect_width = width / divisor;
    let aspect_height = height / divisor;
    format!(
        "{}:{}",
        js_number_to_string(aspect_width),
        js_number_to_string(aspect_height)
    )
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExceedsDragThresholdOptions {
    pub current: GeometryPoint,
    pub origin: GeometryPoint,
    pub threshold: f64,
}

#[export]
pub fn exceeds_drag_threshold_value(
    ExceedsDragThresholdOptions {
        current,
        origin,
        threshold,
    }: ExceedsDragThresholdOptions,
) -> bool {
    exceeds_drag_threshold(current, origin, threshold)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DimensionToAspectRatioOptions {
    pub width: f64,
    pub height: f64,
}

#[export]
pub fn dimension_to_aspect_ratio_value(
    DimensionToAspectRatioOptions { width, height }: DimensionToAspectRatioOptions,
) -> String {
    dimension_to_aspect_ratio(width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-12,
            "expected {expected}, got {actual}",
        );
    }

    fn point(x: f64, y: f64) -> GeometryPoint {
        GeometryPoint { x, y }
    }

    #[test]
    fn a_quarter_turn_sends_the_x_axis_onto_the_y_axis() {
        // Screen space: y grows downward, so a positive rotation is clockwise
        // and (1, 0) lands on (0, 1).
        let rotated = rotate_offset(1.0, 0.0, std::f64::consts::FRAC_PI_2);
        approx(rotated.x, 0.0);
        approx(rotated.y, 1.0);
    }

    #[test]
    fn rotating_about_a_point_leaves_that_point_alone() {
        let rotated = rotate_point_around(5.0, 7.0, 5.0, 7.0, 1.234);
        assert_eq!(rotated, point(5.0, 7.0));
    }

    #[test]
    fn rotating_about_a_point_is_the_offset_rotation_translated() {
        let center_x = -3.0;
        let center_y = 11.0;
        let rotation = 0.7;
        let rotated = rotate_point_around(2.0, 4.0, center_x, center_y, rotation);
        let offset = rotate_offset(2.0 - center_x, 4.0 - center_y, rotation);
        approx(rotated.x, center_x + offset.x);
        approx(rotated.y, center_y + offset.y);
    }

    #[test]
    fn the_drag_threshold_is_per_axis_and_strict() {
        let origin = point(100.0, 100.0);
        // Exactly at the threshold is not past it — a click that jitters by
        // precisely the slop distance stays a click.
        assert!(!exceeds_drag_threshold(point(104.0, 100.0), origin, 4.0));
        assert!(exceeds_drag_threshold(point(104.1, 100.0), origin, 4.0));
        // Either axis on its own is enough; the diagonal is not measured.
        assert!(exceeds_drag_threshold(point(100.0, 95.0), origin, 4.0));
        assert!(!exceeds_drag_threshold(point(103.0, 97.0), origin, 4.0));
    }

    #[test]
    fn aspect_ratios_reduce_by_the_greatest_common_divisor() {
        assert_eq!(dimension_to_aspect_ratio(1920.0, 1080.0), "16:9");
        assert_eq!(dimension_to_aspect_ratio(1080.0, 1920.0), "9:16");
        assert_eq!(dimension_to_aspect_ratio(1000.0, 1000.0), "1:1");
        assert_eq!(dimension_to_aspect_ratio(1280.0, 720.0), "16:9");
    }

    #[test]
    fn a_zero_dimension_reduces_against_the_other_side() {
        // gcd(x, 0) is x, so the ratio is 1:0 rather than a division by zero.
        assert_eq!(dimension_to_aspect_ratio(1920.0, 0.0), "1:0");
    }
}
