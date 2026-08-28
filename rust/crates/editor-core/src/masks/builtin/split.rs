//! Math for the split mask's drag dispatcher and stroke geometry.
//!
//! Ported from `apps/web/src/masks/builtin/definitions/split.ts`. The split
//! mask's renderer and overlay stay in TypeScript because they touch the
//! canvas API; this module handles the drag-time arithmetic and the line /
//! edge intersection helpers the renderer used to call out to
//! `apps/web/src/masks/utils.ts`.
//!
//! Two details pinned here because they are easy to get wrong:
//!
//! - The feather direction for a split mask is `(−cos(rotation),
//!   −sin(rotation))`, not `(−sin(rotation), cos(rotation))` the way the box
//!   and text masks use. The split line is perpendicular to its feather
//!   outward direction by design; unifying them silently transposes every
//!   split mask's feather handle.
//! - `cos(π/2)` returns a non-zero residual in `f64`. Without the
//!   [`NORMAL_SNAP_EPSILON`] clamp the renderer draws a near-zero normal
//!   that ends exactly on canvas corners and produces opposite-sign float
//!   noise on either side, which adds a spurious midpoint vertex to the
//!   polygon. The threshold is the same one the TS module carries.

use bridge::export;
use serde::{Deserialize, Serialize};
#[cfg(feature = "wasm")]
use tsify_next::Tsify;

use crate::masks::handle_positions::{MaskHandleId, MaskOverlayBounds, MaskOverlayPoint};
use crate::masks::snap::{MaskCanvasSize, SplitMaskParams};
use crate::math::{clamp as clamp_value, js_round};

/// `cos(π/2)` returns ~6e-17 in JS, not 0. Values below this threshold are
/// snapped to exactly 0 to prevent opposite-sign float noise on canvas
/// corners that lie exactly on the split line, which produces spurious
/// midpoint vertices.
const NORMAL_SNAP_EPSILON: f64 = 1e-10;

/// Guards against collinear vertices from float noise at canvas edges.
#[allow(dead_code)]
const MIN_POLYGON_AREA_PX: f64 = 0.5;

/// Tolerance for treating two intersection points as the same one. Matches
/// `INTERSECTION_EPSILON` in `split.ts`.
const INTERSECTION_EPSILON: f64 = 1e-6;

/// Tolerance below which two line-distance signs are treated as parallel —
/// the equivalent of `LINE_PARALLEL_EPSILON` in `apps/web/src/masks/utils.ts`.
const LINE_PARALLEL_EPSILON: f64 = 1e-10;

/// How many pixels of drag add one unit of feather.
const FEATHER_HANDLE_SCALE: f64 = 0.11;

/// The largest feather the editor accepts.
const MAX_FEATHER: f64 = 1000.0;

/// `MaskParamUpdateArgs<SplitMaskParams>` from `apps/web/src/masks/types.ts`.
///
/// Unlike [`crate::masks::builtin::text::ComputeTextMaskParamUpdateOptions`],
/// the split dispatcher takes `canvas_size` so the position case can clamp
/// against canvas edges. A split mask is sized to the canvas, not to the
/// element, so the clamp is necessary.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeSplitMaskParamUpdateOptions {
    pub handle_id: MaskHandleId,
    pub start_params: SplitMaskParams,
    pub delta_x: f64,
    pub delta_y: f64,
    pub start_canvas_x: f64,
    pub start_canvas_y: f64,
    pub bounds: MaskOverlayBounds,
    pub canvas_size: MaskCanvasSize,
}

/// The fields a split mask's param-update dispatcher can return. Empty
/// partials (`{}`) round-trip because every field is `Option<f64>` with
/// `skip_serializing_if = "Option::is_none"`.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputeSplitMaskParamUpdateResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
}

/// `computeSplitMaskParamUpdate` from
/// `apps/web/src/masks/builtin/definitions/split.ts`.
#[export]
pub fn compute_split_mask_param_update_value(
    ComputeSplitMaskParamUpdateOptions {
        handle_id,
        start_params,
        delta_x,
        delta_y,
        start_canvas_x,
        start_canvas_y,
        bounds,
        canvas_size,
    }: ComputeSplitMaskParamUpdateOptions,
) -> ComputeSplitMaskParamUpdateResult {
    if let MaskHandleId::Position = handle_id {
        let raw_x = start_params.center_x + delta_x / bounds.width;
        let raw_y = start_params.center_y + delta_y / bounds.height;

        let min_x = -bounds.cx / bounds.width;
        let max_x = (canvas_size.width - bounds.cx) / bounds.width;
        let min_y = -bounds.cy / bounds.height;
        let max_y = (canvas_size.height - bounds.cy) / bounds.height;

        return ComputeSplitMaskParamUpdateResult {
            center_x: Some(clamp_value(raw_x, min_x, max_x)),
            center_y: Some(clamp_value(raw_y, min_y, max_y)),
            ..ComputeSplitMaskParamUpdateResult::default()
        };
    }

    if let MaskHandleId::Feather = handle_id {
        let angle_rad = start_params.rotation.to_radians();
        let feather = compute_feather_update(
            start_params.base.feather,
            delta_x,
            delta_y,
            -angle_rad.cos(),
            -angle_rad.sin(),
        );
        return ComputeSplitMaskParamUpdateResult {
            feather: Some(feather),
            ..ComputeSplitMaskParamUpdateResult::default()
        };
    }

    if let MaskHandleId::Rotation = handle_id {
        let pivot_x = bounds.cx + start_params.center_x * bounds.width;
        let pivot_y = bounds.cy + start_params.center_y * bounds.height;
        let start_angle = (start_canvas_y - pivot_y)
            .atan2(start_canvas_x - pivot_x)
            .to_degrees();
        let current_angle = (start_canvas_y + delta_y - pivot_y)
            .atan2(start_canvas_x + delta_x - pivot_x)
            .to_degrees();

        let mut delta_angle = current_angle - start_angle;
        if delta_angle > 180.0 {
            delta_angle -= 360.0;
        }
        if delta_angle < -180.0 {
            delta_angle += 360.0;
        }

        let rotation = positive_modulo(start_params.rotation + delta_angle, 360.0);
        return ComputeSplitMaskParamUpdateResult {
            rotation: Some(rotation),
            ..ComputeSplitMaskParamUpdateResult::default()
        };
    }

    ComputeSplitMaskParamUpdateResult::default()
}

/// Shoelace-formula polygon area, mirroring `polygonArea` in
/// `apps/web/src/masks/builtin/definitions/split.ts`. Returns the unsigned
/// area; the sign is dropped because the TS module takes `Math.abs` too.
#[allow(dead_code)]
fn polygon_area(vertices: &[[f64; 2]]) -> f64 {
    let mut area = 0.0;
    let count = vertices.len();
    for index in 0..count {
        let next = (index + 1) % count;
        let [x1, y1] = vertices[index];
        let [x2, y2] = vertices[next];
        area += x1 * y2 - x2 * y1;
    }
    area.abs() * 0.5
}

/// `splitLineGeometry` from the TS module. Returns the line's normal vector
/// (with sub-epsilon magnitudes clamped to 0) and the line's reference
/// point on the canvas.
#[allow(dead_code)]
fn split_line_geometry(
    center_x: f64,
    center_y: f64,
    rotation: f64,
    width: f64,
    height: f64,
) -> SplitLineGeometry {
    let angle_rad = rotation.to_radians();
    let raw_normal_x = angle_rad.cos();
    let raw_normal_y = angle_rad.sin();
    let normal_x = if raw_normal_x.abs() < NORMAL_SNAP_EPSILON {
        0.0
    } else {
        raw_normal_x
    };
    let normal_y = if raw_normal_y.abs() < NORMAL_SNAP_EPSILON {
        0.0
    } else {
        raw_normal_y
    };
    let line_x = width / 2.0 + center_x * width;
    let line_y = height / 2.0 + center_y * height;
    SplitLineGeometry {
        normal_x,
        normal_y,
        line_x,
        line_y,
    }
}

#[allow(dead_code)]
struct SplitLineGeometry {
    normal_x: f64,
    normal_y: f64,
    line_x: f64,
    line_y: f64,
}

/// Two points are equal if both coordinates land within
/// [`INTERSECTION_EPSILON`]. Mirrors `pointsEqual` from `split.ts`.
#[allow(dead_code)]
fn points_equal(a: MaskOverlayPoint, b: MaskOverlayPoint) -> bool {
    (a.x - b.x).abs() <= INTERSECTION_EPSILON && (a.y - b.y).abs() <= INTERSECTION_EPSILON
}

/// Half-plane signed distance from `(x, y)` to the line through `lineX/Y`
/// along the unit normal `normalX/Y`. Mirrors `halfPlaneSign` in
/// `apps/web/src/masks/utils.ts`.
fn half_plane_sign(line_x: f64, line_y: f64, normal_x: f64, normal_y: f64, x: f64, y: f64) -> f64 {
    (x - line_x) * normal_x + (y - line_y) * normal_y
}

/// Intersection of the infinite line with the segment `(x1, y1) → (x2, y2)`,
/// or `None` if the two are parallel or the intersection falls outside the
/// segment. Mirrors `lineEdgeIntersection` in `apps/web/src/masks/utils.ts`.
#[allow(dead_code)]
fn line_edge_intersection(
    line_x: f64,
    line_y: f64,
    normal_x: f64,
    normal_y: f64,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
) -> Option<MaskOverlayPoint> {
    let distance_1 = half_plane_sign(line_x, line_y, normal_x, normal_y, x1, y1);
    let distance_2 = half_plane_sign(line_x, line_y, normal_x, normal_y, x2, y2);
    let denom = distance_1 - distance_2;
    if denom.abs() < LINE_PARALLEL_EPSILON {
        return None;
    }
    let t = distance_1 / denom;
    if t < 0.0 || t > 1.0 {
        return None;
    }
    Some(MaskOverlayPoint {
        x: x1 + (x2 - x1) * t,
        y: y1 + (y2 - y1) * t,
    })
}

/// `getSplitMaskStrokeSegment` from `split.ts`. Returns the two endpoints
/// where the split line crosses the bounding rectangle, or `None` if the
/// line misses the rectangle entirely.
#[allow(dead_code)]
fn get_split_mask_stroke_segment(
    resolved_params: SplitMaskParams,
    width: f64,
    height: f64,
) -> Option<[MaskOverlayPoint; 2]> {
    let SplitLineGeometry {
        normal_x,
        normal_y,
        line_x,
        line_y,
    } = split_line_geometry(
        resolved_params.center_x,
        resolved_params.center_y,
        resolved_params.rotation,
        width,
        height,
    );

    let edges: [[f64; 4]; 4] = [
        [0.0, 0.0, width, 0.0],
        [width, 0.0, width, height],
        [width, height, 0.0, height],
        [0.0, height, 0.0, 0.0],
    ];

    let mut intersections: Vec<MaskOverlayPoint> = Vec::new();
    for edge in &edges {
        let hit = line_edge_intersection(
            line_x,
            line_y,
            normal_x,
            normal_y,
            edge[0],
            edge[1],
            edge[2],
            edge[3],
        );
        if hit.is_none() {
            continue;
        }
        if intersections
            .iter()
            .any(|point| points_equal(*point, hit.unwrap()))
        {
            continue;
        }
        intersections.push(hit.unwrap());
    }

    if intersections.len() != 2 {
        return None;
    }
    Some([intersections[0], intersections[1]])
}

/// `computeFeatherUpdate` from `apps/web/src/masks/param-update.ts`, inlined
/// here because the feather direction differs from the box / text masks —
/// split uses `(−cos(θ), −sin(θ))` rather than `(−sin(θ), cos(θ))`. The
/// shape is identical otherwise.
fn compute_feather_update(
    start_feather: f64,
    delta_x: f64,
    delta_y: f64,
    direction_x: f64,
    direction_y: f64,
) -> f64 {
    let projection = delta_x * direction_x + delta_y * direction_y;
    let rounded = js_round(start_feather + projection / FEATHER_HANDLE_SCALE);
    clamp_value(rounded, 0.0, MAX_FEATHER)
}

/// `(((x + d) % 360) + 360) % 360`, written out because Rust's `%` keeps
/// the sign of the dividend.
fn positive_modulo(value: f64, modulus: f64) -> f64 {
    ((value % modulus) + modulus) % modulus
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masks::handle_positions::MaskOverlayPoint;
    use crate::masks::snap::BaseMaskParams;

    fn base() -> BaseMaskParams {
        BaseMaskParams {
            feather: 0.0,
            inverted: false,
            stroke_color: "#ffffff".to_string(),
            stroke_width: 0.0,
            stroke_align: "center".to_string(),
        }
    }

    fn split_params() -> SplitMaskParams {
        SplitMaskParams {
            base: base(),
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
        }
    }

    fn bounds() -> MaskOverlayBounds {
        MaskOverlayBounds {
            cx: 100.0,
            cy: 200.0,
            width: 400.0,
            height: 300.0,
            rotation: 0.0,
        }
    }

    fn canvas_size() -> MaskCanvasSize {
        MaskCanvasSize {
            width: 800.0,
            height: 600.0,
        }
    }

    fn args(
        handle_id: MaskHandleId,
        start_params: SplitMaskParams,
        delta_x: f64,
        delta_y: f64,
        start_canvas_x: f64,
        start_canvas_y: f64,
        bounds: MaskOverlayBounds,
        canvas_size: MaskCanvasSize,
    ) -> ComputeSplitMaskParamUpdateOptions {
        ComputeSplitMaskParamUpdateOptions {
            handle_id,
            start_params,
            delta_x,
            delta_y,
            start_canvas_x,
            start_canvas_y,
            bounds,
            canvas_size,
        }
    }

    #[test]
    fn position_drag_normalises_against_bounds_size() {
        // 40 / 400 = 0.1, 30 / 300 = 0.1. Canvas is wider than bounds, so
        // the clamp does nothing.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Position,
            split_params(),
            40.0,
            30.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.center_x, Some(0.1));
        assert_eq!(result.center_y, Some(0.1));
    }

    #[test]
    fn position_drag_clamps_to_canvas_edges() {
        // bounds (cx=100, cy=200, w=400, h=300) inside canvas 800x600.
        // Element-centred left edge: -100/400 = -0.25. Canvas left in
        // element-centred: -100/400 = -0.25 (because bounds.cx = 100 =
        // canvas_width/2). Element-centred right edge: (800 - 100)/400 =
        // 1.75. Element-centred bottom: (600 - 200)/300 = 1.333.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Position,
            split_params(),
            10_000.0,
            10_000.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.center_x, Some(1.75));
        assert_eq!(result.center_y, Some(1.3333333333333333));
    }

    #[test]
    fn position_drag_pulls_back_when_dragging_left() {
        // Symmetric to above: drag of -10000 → raw -25, clamped to -0.25.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Position,
            split_params(),
            -10_000.0,
            -10_000.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.center_x, Some(-0.25));
        assert_eq!(result.center_y, Some(-0.6666666666666666));
    }

    #[test]
    fn position_drag_on_zero_size_bounds_yields_infinity() {
        // Mirror of the text-mask test: 1.0 / 0.0 = +inf.
        let degenerate = MaskOverlayBounds {
            cx: 0.0,
            cy: 0.0,
            width: 0.0,
            height: 0.0,
            rotation: 0.0,
        };
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Position,
            split_params(),
            1.0,
            1.0,
            0.0,
            0.0,
            degenerate,
            canvas_size(),
        ));
        assert_eq!(result.center_x, Some(f64::INFINITY));
        assert_eq!(result.center_y, Some(f64::INFINITY));
    }

    #[test]
    fn rotation_drag_wraps_into_zero_three_sixty() {
        // pivot (100, 200). start (200, 200) → 0°. current (100, 300) → 90°.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Rotation,
            split_params(),
            -100.0,
            100.0,
            200.0,
            200.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.rotation, Some(90.0));
    }

    #[test]
    fn rotation_drag_above_one_eighty_subtracts_three_sixty() {
        // Pivot (100, 200). start at exactly -90° → (100, 199) (i.e.
        // (cx, cy - 1)). current at +91° → unit vector
        // (cos 91°, sin 91°) ≈ (-0.0174524, 0.999848). Place the pointer
        // 100 units away along that vector from the pivot.
        let start_x = 100.0;
        let start_y = 199.0;
        let angle_rad = 91.0_f64.to_radians();
        let current_x = 100.0 + 100.0 * angle_rad.cos();
        let current_y = 200.0 + 100.0 * angle_rad.sin();
        let delta_x = current_x - start_x;
        let delta_y = current_y - start_y;
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Rotation,
            split_params(),
            delta_x,
            delta_y,
            start_x,
            start_y,
            bounds(),
            canvas_size(),
        ));
        // start -90° → current +91° → raw delta = +181° → wrap -360 → -179°.
        // Then positive_modulo(-179, 360) = ((-179 % 360) + 360) % 360 = 181.
        assert!(
            (result.rotation.unwrap() - 181.0).abs() < 1e-6,
            "rotation = {:?}",
            result.rotation
        );
    }

    #[test]
    fn rotation_drag_below_minus_one_eighty_adds_three_sixty() {
        // Pivot (100, 200). start at exactly +90° → (100, 201). current
        // at -91° → unit vector (cos -91°, sin -91°) ≈ (-0.0174524,
        // -0.999848). Place 100 units away.
        let start_x = 100.0;
        let start_y = 201.0;
        let angle_rad = -91.0_f64.to_radians();
        let current_x = 100.0 + 100.0 * angle_rad.cos();
        let current_y = 200.0 + 100.0 * angle_rad.sin();
        let delta_x = current_x - start_x;
        let delta_y = current_y - start_y;
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Rotation,
            split_params(),
            delta_x,
            delta_y,
            start_x,
            start_y,
            bounds(),
            canvas_size(),
        ));
        // start +90° → current -91° → raw delta = -181° → wrap +360 → 179°.
        assert!(
            (result.rotation.unwrap() - 179.0).abs() < 1e-6,
            "rotation = {:?}",
            result.rotation
        );
    }

    #[test]
    fn rotation_drag_with_negative_result_wraps_to_positive() {
        // start_params.rotation = 10°. Drag produces a delta that lands
        // negative. start (200, 200) → 0°. current (0, 100) → -135°.
        // delta = -135°. Final = 10 - 135 = -125°. Wrap: 235°.
        let params = SplitMaskParams {
            rotation: 10.0,
            ..split_params()
        };
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Rotation,
            params,
            -200.0,
            -100.0,
            200.0,
            200.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.rotation, Some(235.0));
    }

    #[test]
    fn feather_drag_projects_against_the_split_normal() {
        // rotation = 0° → split normal direction is (1, 0) (since
        // direction = (-cos, -sin) = (-1, 0)). The "outward" feather
        // direction is the *negative* of this, i.e. (-1, 0). Drag -X by
        // 11 px → projection = 11. feather = round(0 + 11 / 0.11) = 100.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Feather,
            split_params(),
            -11.0,
            0.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.feather, Some(100.0));
    }

    #[test]
    fn feather_drag_against_the_normal_clamps_to_zero() {
        // Drag +X → projection = -11 → -100 → clamp to 0.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Feather,
            split_params(),
            11.0,
            0.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.feather, Some(0.0));
    }

    #[test]
    fn feather_drag_clamps_to_max_feather() {
        // Drag way past the ceiling; expect MAX_FEATHER.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Feather,
            split_params(),
            -100_000.0,
            0.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.feather, Some(MAX_FEATHER));
    }

    #[test]
    fn feather_drag_at_ninety_degrees_uses_minus_sin() {
        // rotation = 90° → direction = (-cos(90°), -sin(90°)) = (0, -1).
        // Drag +Y by 11 px → projection = -11 → clamp to 0.
        let params = SplitMaskParams {
            rotation: 90.0,
            ..split_params()
        };
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Feather,
            params,
            0.0,
            11.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.feather, Some(0.0));

        // Drag -Y by 11 → projection = 11 → round(100) = 100.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Feather,
            SplitMaskParams {
                rotation: 90.0,
                ..split_params()
            },
            0.0,
            -11.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result.feather, Some(100.0));
    }

    #[test]
    fn unknown_handle_returns_an_empty_partial() {
        // Scale / edge / corner / freeform handles are not part of the
        // split dispatcher's vocabulary, so they fall through to `{}`.
        let result = compute_split_mask_param_update_value(args(
            MaskHandleId::Scale,
            split_params(),
            5.0,
            5.0,
            0.0,
            0.0,
            bounds(),
            canvas_size(),
        ));
        assert_eq!(result, ComputeSplitMaskParamUpdateResult::default());
    }

    #[test]
    fn empty_partial_serializes_to_an_empty_object() {
        let result = ComputeSplitMaskParamUpdateResult::default();
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized, serde_json::json!({}));
    }

    #[test]
    fn partial_with_only_rotation_writes_only_rotation() {
        let result = ComputeSplitMaskParamUpdateResult {
            rotation: Some(45.0),
            ..ComputeSplitMaskParamUpdateResult::default()
        };
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized, serde_json::json!({ "rotation": 45.0 }));
    }

    #[test]
    fn polygon_area_is_zero_for_an_empty_polygon() {
        assert_eq!(polygon_area(&[]), 0.0);
    }

    #[test]
    fn polygon_area_matches_the_shoelace_formula() {
        // A 1x1 axis-aligned square has area 1.
        let square = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        assert_eq!(polygon_area(&square), 1.0);

        // A right triangle with legs 4 and 3 has area 6.
        let triangle = [[0.0, 0.0], [4.0, 0.0], [0.0, 3.0]];
        assert_eq!(polygon_area(&triangle), 6.0);

        // A counter-clockwise winding gives the same magnitude — the
        // function takes abs.
        let cw_triangle = [[0.0, 0.0], [0.0, 3.0], [4.0, 0.0]];
        assert_eq!(polygon_area(&cw_triangle), 6.0);
    }

    #[test]
    fn split_line_geometry_snaps_near_zero_normals() {
        // rotation = 90° → cos(π/2) ≈ 6.12e-17 < NORMAL_SNAP_EPSILON.
        let geometry = split_line_geometry(0.0, 0.0, 90.0, 800.0, 600.0);
        assert_eq!(geometry.normal_x, 0.0);
        assert_eq!(geometry.normal_y, 1.0);
        assert_eq!(geometry.line_x, 400.0);
        assert_eq!(geometry.line_y, 300.0);

        // rotation = 0° → sin(0) = 0 exactly, cos(0) = 1.
        let geometry = split_line_geometry(0.0, 0.0, 0.0, 800.0, 600.0);
        assert_eq!(geometry.normal_x, 1.0);
        assert_eq!(geometry.normal_y, 0.0);
    }

    #[test]
    fn points_equal_is_true_within_the_epsilon() {
        let a = MaskOverlayPoint { x: 1.0, y: 2.0 };
        assert!(points_equal(a, MaskOverlayPoint { x: 1.0, y: 2.0 }));
        assert!(points_equal(a, MaskOverlayPoint { x: 1.0 + 5e-7, y: 2.0 - 5e-7 }));
        assert!(!points_equal(a, MaskOverlayPoint { x: 1.01, y: 2.0 }));
        assert!(!points_equal(a, MaskOverlayPoint { x: 1.0, y: 2.01 }));
    }

    #[test]
    fn line_edge_intersection_returns_none_for_parallel_lines() {
        // Split line through (400, 300) with normal (0, 1) — the y=300
        // horizontal. Horizontal edge from (0, 0) to (800, 0) has both
        // endpoints at y=0 → both at signed distance -300 → denom = 0.
        // The two are parallel and the function returns None.
        let hit = line_edge_intersection(400.0, 300.0, 0.0, 1.0, 0.0, 0.0, 800.0, 0.0);
        assert!(hit.is_none());
    }

    #[test]
    fn line_edge_intersection_clips_to_the_segment() {
        // Split line through (400, 300) with normal (1, 0). Edge from
        // (0, 0) to (200, 0) — both points are on the negative side and
        // the intersection would be at x=400, outside the segment.
        let hit = line_edge_intersection(400.0, 300.0, 1.0, 0.0, 0.0, 0.0, 200.0, 0.0);
        assert!(hit.is_none());

        // Edge from (300, 0) to (500, 0) crosses x=400 between t=0.25 and
        // t=0.75 → t=0.5 → (400, 0).
        let hit = line_edge_intersection(400.0, 300.0, 1.0, 0.0, 300.0, 0.0, 500.0, 0.0).unwrap();
        assert_eq!(hit, MaskOverlayPoint { x: 400.0, y: 0.0 });
    }

    #[test]
    fn get_split_mask_stroke_segment_returns_two_corners() {
        // 800x600 canvas, rotation 0° → line at x=400 vertical.
        let segment =
            get_split_mask_stroke_segment(split_params(), 800.0, 600.0).unwrap();
        // Vertical line x=400 from y=0 to y=600.
        assert_eq!(segment[0], MaskOverlayPoint { x: 400.0, y: 0.0 });
        assert_eq!(segment[1], MaskOverlayPoint { x: 400.0, y: 600.0 });
    }

    #[test]
    fn get_split_mask_stroke_segment_returns_two_corners_at_ninety_degrees() {
        // rotation = 90° → line is horizontal y=300. Endpoints (0, 300)
        // and (800, 300) — order depends on which edge the loop hits
        // first, so we check membership rather than position.
        let params = SplitMaskParams {
            rotation: 90.0,
            ..split_params()
        };
        let segment = get_split_mask_stroke_segment(params, 800.0, 600.0).unwrap();
        let expected_0 = MaskOverlayPoint { x: 0.0, y: 300.0 };
        let expected_1 = MaskOverlayPoint { x: 800.0, y: 300.0 };
        let matches = (segment[0] == expected_0 && segment[1] == expected_1)
            || (segment[0] == expected_1 && segment[1] == expected_0);
        assert!(matches, "got {segment:?}");
    }

    #[test]
    fn get_split_mask_stroke_segment_returns_none_when_line_misses_rect() {
        // An offset large enough that the line exits the rectangle before
        // reaching any other edge produces fewer than two intersections.
        // rotation = 0° → line at x=400 + offset. offset by 1 → x=1200,
        // outside the 800-wide rect.
        let params = SplitMaskParams {
            center_x: 1.0,
            ..split_params()
        };
        assert!(get_split_mask_stroke_segment(params, 800.0, 600.0).is_none());
    }

    #[test]
    fn positive_modulo_wraps_a_negative_value() {
        assert_eq!(positive_modulo(-125.0, 360.0), 235.0);
        assert_eq!(positive_modulo(540.0, 360.0), 180.0);
        assert_eq!(positive_modulo(360.0, 360.0), 0.0);
    }
}
