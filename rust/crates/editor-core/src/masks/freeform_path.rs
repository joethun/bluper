//! Geometry of a freeform (pen-tool) mask path: anchor points with cubic bezier
//! handles, and the maths that turns them into canvas-space curves.
//!
//! A path is stored as a list of `FreeformPathPoint` entries in the mask's own
//! local frame: `(x, y)` is the anchor, and `(inX, inY)` / `(outX, outY)` are the
//! bezier handles expressed as offsets from the anchor. Every other function in
//! this module projects that representation onto the element's canvas frame
//! (rotation, scale, anchor offset) and back.
//!
//! Ported from `apps/web/src/masks/freeform/path.ts`. The two implementations
//! are kept equal by `interpolation-parity.test.ts`'s sibling for freeforms;
//! that file is the only reason deleting either side is safe.
//!
//! `Math.sin` and `Math.cos` appear here. V8 ships its own implementations and
//! does not always agree with the platform libm on which of the two answers in
//! the last bit is the right one; the parity test allows a relative drift of
//! `1e-12` for the leaves that come out of those calls.

use bridge::export;
use serde::{Deserialize, Serialize};

/// An anchor on a freeform path with its two cubic bezier handles.
///
/// The anchor lives in the mask's local frame — `(x, y)` is its position, and
/// the handles are offsets from the anchor, so the absolute in-handle position
/// is `(x + inX, y + inY)`. Every entry carries an `id` so the surrounding UI
/// can keep its selection across edits that rearrange the list.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformPathPoint {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub in_x: f64,
    pub in_y: f64,
    pub out_x: f64,
    pub out_y: f64,
}

/// A point on the canvas — the coordinate space the preview draws in.
///
/// Named `FreeformCanvasPoint` so it does not collide with `MaskOverlayPoint`
/// or the `Point` in `apps/web/src/utils/geometry.ts`: tsify merges same-named
/// interfaces in the generated `.d.ts` and starts lying once they diverge.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformCanvasPoint {
    pub x: f64,
    pub y: f64,
}

/// One anchor's three canvas-space positions: the anchor itself, its incoming
/// bezier handle, and its outgoing one.
///
/// Kept as a named struct rather than three `FreeformCanvasPoint`s because the
/// TS callers consume it as an object — `Vec<FreeformCanvasPoint>` would cross
/// the boundary as `Map` with numeric keys (see AGENTS.md).
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformCanvasAnchor {
    pub id: String,
    pub anchor: FreeformCanvasPoint,
    pub in_handle: FreeformCanvasPoint,
    pub out_handle: FreeformCanvasPoint,
}

/// The axis-aligned bounding box of a set of canvas points, with a floor of one
/// on each dimension so an empty shape never reads as zero-sized.
///
/// The centre fields exist because the recentre logic consumes them directly;
/// the `width`/`height` floors are the ones the box-mask handle layout assumes.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformCanvasBounds {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
    pub width: f64,
    pub height: f64,
    pub center_x: f64,
    pub center_y: f64,
}

/// Either the anchors and their bounds, or the anchors alone when the path is
/// empty.
///
/// The TS function returned `bounds: null` for an empty path; the Rust side
/// keeps the same shape so the façade can serialise it without a `Map`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformCanvasGeometry {
    pub anchors: Vec<FreeformCanvasAnchor>,
    pub bounds: Option<FreeformCanvasBounds>,
}

/// One bezier segment of the canvas-space path, in the form the overlay layer
/// consumes — both as the bare anchor/handle fields and as the SVG `pathData`
/// string it draws for hit-testing.
///
/// `pathData` is rebuilt here rather than read back from a `Path2D` so the same
/// shape feeds both the SVG overlay and the canvas path builder.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformCanvasSegment {
    pub index: i64,
    pub start_point_id: String,
    pub end_point_id: String,
    pub start: FreeformCanvasPoint,
    pub start_out: FreeformCanvasPoint,
    pub end_in: FreeformCanvasPoint,
    pub end: FreeformCanvasPoint,
    pub path_data: String,
}

/// The closest-point search's answer: where on the bezier the cursor sat, and
/// the canvas-space point itself.
///
/// `t` is the parameter in `[0, 1]` along the segment; the original TS clamps
/// it to `[0.001, 0.999]` so a follow-up split cannot produce a zero-width
/// slice. That clamp is preserved here.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformClosestPoint {
    pub t: f64,
    pub point: FreeformCanvasPoint,
}

/// Local-axis size of the path, the input the box-mask resize handles scale.
///
/// `None` matches the TS return — an empty path has no local size to display.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformLocalBounds {
    pub width: f64,
    pub height: f64,
}

/// The output of `recenterFreeformPath`: the new centre, and the new path with
/// every anchor rewritten relative to it.
///
/// `None` for an empty path (the TS early-returned the input as-is, which a
/// caller could not distinguish from a no-op recentre — the Rust side picks
/// the no-op shape because it is the honest one).
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeformRecenteredPath {
    pub center_x: f64,
    pub center_y: f64,
    pub points: Vec<FreeformPathPoint>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoveFreeformPathPointsOptions {
    pub points: Vec<FreeformPathPoint>,
    pub point_ids: Vec<String>,
}

/// Removes the named anchors from a freeform path.
///
/// The empty-input fast path mirrors the original so a no-op caller gets its
/// list back reference-identical.
#[export]
pub fn remove_freeform_path_points(
    RemoveFreeformPathPointsOptions { points, point_ids }: RemoveFreeformPathPointsOptions,
) -> Vec<FreeformPathPoint> {
    if point_ids.is_empty() {
        return points;
    }

    let to_remove: std::collections::HashSet<&String> = point_ids.iter().collect();
    points
        .into_iter()
        .filter(|point| !to_remove.contains(&point.id))
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GetFreeformPathClosedStateAfterPointRemovalOptions {
    pub was_closed: bool,
    pub remaining_point_count: i64,
}

/// Whether a path that just lost some anchors should still report itself as
/// closed.
///
/// Two anchors cannot form a closed shape, so the answer flips to `false`
/// below three. The original TS returned a plain `boolean`; the bridge
/// preserves that.
#[export]
pub fn get_freeform_path_closed_state_after_point_removal(
    GetFreeformPathClosedStateAfterPointRemovalOptions {
        was_closed,
        remaining_point_count,
    }: GetFreeformPathClosedStateAfterPointRemovalOptions,
) -> bool {
    was_closed && remaining_point_count >= 3
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FreeformElementBounds {
    pub cx: f64,
    pub cy: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FreeformTransformOptions {
    pub point: FreeformCanvasPoint,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
}

/// Degrees to radians, written as `(rotation * Math.PI) / 180` so the rounding
/// of the intermediate product matches the TS.
fn to_radians(rotation_degrees: f64) -> f64 {
    (rotation_degrees * std::f64::consts::PI) / 180.0
}

/// Rotate an offset around the origin. The companion of
/// `freeformCanvasPointToLocal` — both project between the mask's local frame
/// and the element's canvas frame, one for the forward direction and one for
/// the inverse.
fn rotate_offset(dx: f64, dy: f64, rotation_radians: f64) -> FreeformCanvasPoint {
    let cos = rotation_radians.cos();
    let sin = rotation_radians.sin();
    FreeformCanvasPoint {
        x: dx * cos - dy * sin,
        y: dx * sin + dy * cos,
    }
}

/// The mask's centre in canvas coordinates.
///
/// `center_x`/`center_y` are normalised offsets in the element's own width
/// and height; `bounds` is the element's box on the canvas.
fn freeform_center_canvas_point(
    center_x: f64,
    center_y: f64,
    bounds: &FreeformElementBounds,
) -> FreeformCanvasPoint {
    FreeformCanvasPoint {
        x: bounds.cx + center_x * bounds.width,
        y: bounds.cy + center_y * bounds.height,
    }
}

/// Project a point from the mask's local frame onto the canvas.
///
/// Scale is applied before rotation, matching the TS so an unrotated path
/// scales along its own axes.
fn freeform_local_point_to_canvas(
    point: FreeformCanvasPoint,
    center_x: f64,
    center_y: f64,
    rotation_degrees: f64,
    scale: f64,
    bounds: &FreeformElementBounds,
) -> FreeformCanvasPoint {
    let center = freeform_center_canvas_point(center_x, center_y, bounds);
    let scaled_local = FreeformCanvasPoint {
        x: point.x * bounds.width * scale,
        y: point.y * bounds.height * scale,
    };
    let rotated = rotate_offset(scaled_local.x, scaled_local.y, to_radians(rotation_degrees));
    FreeformCanvasPoint {
        x: center.x + rotated.x,
        y: center.y + rotated.y,
    }
}

/// Project a point from the canvas back into the mask's local frame.
///
/// Zero-sized bounds produce a zero coordinate rather than NaN, so a
/// degenerate element does not poison the result.
fn freeform_canvas_point_to_local_inner(
    point: FreeformCanvasPoint,
    center_x: f64,
    center_y: f64,
    rotation_degrees: f64,
    scale: f64,
    bounds: &FreeformElementBounds,
) -> FreeformCanvasPoint {
    let center = freeform_center_canvas_point(center_x, center_y, bounds);
    let translated = FreeformCanvasPoint {
        x: point.x - center.x,
        y: point.y - center.y,
    };
    let rotated = rotate_offset(
        translated.x,
        translated.y,
        to_radians(-rotation_degrees),
    );

    FreeformCanvasPoint {
        x: if bounds.width == 0.0 {
            0.0
        } else {
            rotated.x / (bounds.width * scale)
        },
        y: if bounds.height == 0.0 {
            0.0
        } else {
            rotated.y / (bounds.height * scale)
        },
    }
}

/// Map a canvas-space click back into the mask's local frame.
#[export]
pub fn freeform_canvas_point_to_local(
    FreeformTransformOptions {
        point,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    }: FreeformTransformOptions,
) -> FreeformCanvasPoint {
    freeform_canvas_point_to_local_inner(point, center_x, center_y, rotation, scale, &bounds)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetFreeformCanvasGeometryOptions {
    pub points: Vec<FreeformPathPoint>,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
}

/// AABB of a list of canvas points, with the same `max(1, …)` floor on each
/// dimension that the TS uses so a zero-width path is still drawable.
///
/// Empty input is `None`, mirroring the TS — `geometry.bounds` becomes `null`
/// and the caller falls back to "no overlay".
fn canvas_point_bounds(points: &[FreeformCanvasPoint]) -> Option<FreeformCanvasBounds> {
    let first = *points.first()?;
    let mut min_x = first.x;
    let mut max_x = first.x;
    let mut min_y = first.y;
    let mut max_y = first.y;
    for point in &points[1..] {
        min_x = min_x.min(point.x);
        max_x = max_x.max(point.x);
        min_y = min_y.min(point.y);
        max_y = max_y.max(point.y);
    }
    Some(FreeformCanvasBounds {
        min_x,
        max_x,
        min_y,
        max_y,
        width: (max_x - min_x).max(1.0),
        height: (max_y - min_y).max(1.0),
        center_x: (min_x + max_x) / 2.0,
        center_y: (min_y + max_y) / 2.0,
    })
}

/// The canvas-space projection of every anchor on the path.
///
/// An empty path returns `bounds: None`; every other path carries both the
/// per-anchor handles and an enclosing AABB.
#[export]
pub fn get_freeform_canvas_geometry(
    GetFreeformCanvasGeometryOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    }: GetFreeformCanvasGeometryOptions,
) -> FreeformCanvasGeometry {
    let anchors: Vec<FreeformCanvasAnchor> = points
        .iter()
        .map(|point| {
            let anchor = freeform_local_point_to_canvas(
                FreeformCanvasPoint { x: point.x, y: point.y },
                center_x,
                center_y,
                rotation,
                scale,
                &bounds,
            );
            let in_handle = freeform_local_point_to_canvas(
                FreeformCanvasPoint {
                    x: point.x + point.in_x,
                    y: point.y + point.in_y,
                },
                center_x,
                center_y,
                rotation,
                scale,
                &bounds,
            );
            let out_handle = freeform_local_point_to_canvas(
                FreeformCanvasPoint {
                    x: point.x + point.out_x,
                    y: point.y + point.out_y,
                },
                center_x,
                center_y,
                rotation,
                scale,
                &bounds,
            );

            FreeformCanvasAnchor {
                id: point.id.clone(),
                anchor,
                in_handle,
                out_handle,
            }
        })
        .collect();

    let geometry_points: Vec<FreeformCanvasPoint> = anchors
        .iter()
        .flat_map(|anchor| [anchor.anchor, anchor.in_handle, anchor.out_handle])
        .collect();

    let bounds = if geometry_points.is_empty() {
        None
    } else {
        canvas_point_bounds(&geometry_points)
    };

    FreeformCanvasGeometry { anchors, bounds }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FreeformSegmentCountOptions {
    pub points: Vec<FreeformPathPoint>,
    pub closed: bool,
}

/// How many bezier segments the path renders.
///
/// A single anchor has no segments; an open path of `n` anchors has `n - 1`;
/// a closed path has `n`.
#[export]
pub fn get_freeform_segment_count(
    FreeformSegmentCountOptions { points, closed }: FreeformSegmentCountOptions,
) -> i32 {
    if points.len() < 2 {
        return 0;
    }
    (points.len() as i32) - if closed { 0 } else { 1 }
}

/// Indices into `points` for the segment at `segment_index`, or `None` if the
/// index is out of range.
///
/// `end_index` wraps around for a closed path so the last segment runs from
/// the last anchor back to the first.
fn freeform_segment_indices(
    points: &[FreeformPathPoint],
    segment_index: i64,
    closed: bool,
) -> Option<(usize, usize)> {
    let segment_count = get_freeform_segment_count(FreeformSegmentCountOptions {
        points: points.to_vec(),
        closed,
    });
    if segment_index < 0 || segment_index >= segment_count as i64 {
        return None;
    }

    let start_index = segment_index as usize;
    let end_index = ((segment_index + 1) % points.len() as i64) as usize;
    Some((start_index, end_index))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetFreeformCanvasSegmentsOptions {
    pub points: Vec<FreeformPathPoint>,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
    pub closed: bool,
}

/// Every canvas-space bezier segment of the path, in order.
///
/// The path strings are emitted in the SVG-friendly form the overlay uses
/// directly, so nothing in the consumer needs to rebuild them.
#[export]
pub fn get_freeform_canvas_segments(
    GetFreeformCanvasSegmentsOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
        closed,
    }: GetFreeformCanvasSegmentsOptions,
) -> Vec<FreeformCanvasSegment> {
    let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
        points: points.clone(),
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    });
    let anchor_count = geometry.anchors.len();
    let segment_count = get_freeform_segment_count(FreeformSegmentCountOptions {
        points: points.clone(),
        closed,
    });

    (0..segment_count as usize)
        .map(|segment_index| {
            let start = &geometry.anchors[segment_index];
            let end_index = (segment_index + 1) % anchor_count;
            let end = &geometry.anchors[end_index];

            FreeformCanvasSegment {
                index: segment_index as i64,
                start_point_id: start.id.clone(),
                end_point_id: end.id.clone(),
                start: start.anchor,
                start_out: start.out_handle,
                end_in: end.in_handle,
                end: end.anchor,
                path_data: format!(
                    "M {},{} C {},{} {},{} {},{}",
                    start.anchor.x,
                    start.anchor.y,
                    start.out_handle.x,
                    start.out_handle.y,
                    end.in_handle.x,
                    end.in_handle.y,
                    end.anchor.x,
                    end.anchor.y
                ),
            }
        })
        .collect()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FindClosestPointOnFreeformSegmentOptions {
    pub points: Vec<FreeformPathPoint>,
    pub segment_index: i64,
    pub canvas_point: FreeformCanvasPoint,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
    pub closed: bool,
}

/// Squared distance, used in the closest-point search so the inner loop never
/// takes a square root it does not need.
fn distance_squared(a: FreeformCanvasPoint, b: FreeformCanvasPoint) -> f64 {
    let dx = a.x - b.x;
    let dy = a.y - b.y;
    dx * dx + dy * dy
}

/// Evaluate the cubic bezier `p0..p3` at `t` using the standard Bernstein form.
fn evaluate_cubic_bezier(
    p0: FreeformCanvasPoint,
    p1: FreeformCanvasPoint,
    p2: FreeformCanvasPoint,
    p3: FreeformCanvasPoint,
    t: f64,
) -> FreeformCanvasPoint {
    let one_minus_t = 1.0 - t;
    let one_minus_t_sq = one_minus_t * one_minus_t;
    let t_sq = t * t;
    let one_minus_t_cu = one_minus_t_sq * one_minus_t;
    let t_cu = t_sq * t;
    let weight_0 = one_minus_t_cu;
    let weight_1 = 3.0 * one_minus_t_sq * t;
    let weight_2 = 3.0 * one_minus_t * t_sq;
    let weight_3 = t_cu;

    FreeformCanvasPoint {
        x: weight_0 * p0.x + weight_1 * p1.x + weight_2 * p2.x + weight_3 * p3.x,
        y: weight_0 * p0.y + weight_1 * p1.y + weight_2 * p2.y + weight_3 * p3.y,
    }
}

/// Linear interpolation between two points. Used by De Casteljau subdivision.
fn lerp_point(from: FreeformCanvasPoint, to: FreeformCanvasPoint, progress: f64) -> FreeformCanvasPoint {
    FreeformCanvasPoint {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
    }
}

/// One De Casteljau subdivision step of the cubic bezier `p0..p3` at `t`.
///
/// The caller rebuilds the two halves from the intermediates: the left half is
/// `p0, p01, p012, point` and the right is `point, p123, p23, p3`.
fn subdivide_cubic_bezier(
    p0: FreeformCanvasPoint,
    p1: FreeformCanvasPoint,
    p2: FreeformCanvasPoint,
    p3: FreeformCanvasPoint,
    t: f64,
) -> (
    FreeformCanvasPoint,
    FreeformCanvasPoint,
    FreeformCanvasPoint,
    FreeformCanvasPoint,
    FreeformCanvasPoint,
    FreeformCanvasPoint,
) {
    let p01 = lerp_point(p0, p1, t);
    let p12 = lerp_point(p1, p2, t);
    let p23 = lerp_point(p2, p3, t);
    let p012 = lerp_point(p01, p12, t);
    let p123 = lerp_point(p12, p23, t);
    let point = lerp_point(p012, p123, t);
    (p01, p12, p23, p012, p123, point)
}

/// The point on a segment closest to a canvas-space query, or `None` if the
/// segment does not exist.
///
/// The TS samples `25` evenly-spaced points then does eight rounds of
/// ternary refinement. The Rust side mirrors both counts exactly so the
/// bracketed minimum lands on the same `t` modulo the libm gap.
#[export]
pub fn find_closest_point_on_freeform_segment(
    FindClosestPointOnFreeformSegmentOptions {
        points,
        segment_index,
        canvas_point,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
        closed,
    }: FindClosestPointOnFreeformSegmentOptions,
) -> Option<FreeformClosestPoint> {
    let segments = get_freeform_canvas_segments(GetFreeformCanvasSegmentsOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
        closed,
    });
    let segment = segments
        .into_iter()
        .find(|candidate| candidate.index == segment_index)?;

    const SAMPLE_COUNT: i64 = 24;
    let mut best_t = 0.0;
    let mut best_distance_squared = distance_squared(canvas_point, segment.start);

    for step in 0..=SAMPLE_COUNT {
        let t = step as f64 / SAMPLE_COUNT as f64;
        let point = evaluate_cubic_bezier(
            segment.start,
            segment.start_out,
            segment.end_in,
            segment.end,
            t,
        );
        let distance_squared = distance_squared(canvas_point, point);
        if distance_squared < best_distance_squared {
            best_distance_squared = distance_squared;
            best_t = t;
        }
    }

    let mut search_step = 1.0 / SAMPLE_COUNT as f64;
    for _ in 0..8 {
        for candidate_t in [best_t - search_step, best_t, best_t + search_step] {
            let candidate_t = candidate_t.clamp(0.0, 1.0);
            let point = evaluate_cubic_bezier(
                segment.start,
                segment.start_out,
                segment.end_in,
                segment.end,
                candidate_t,
            );
            let distance_squared = distance_squared(canvas_point, point);
            if distance_squared < best_distance_squared {
                best_distance_squared = distance_squared;
                best_t = candidate_t;
            }
        }
        search_step /= 2.0;
    }

    let clamped_t = best_t.clamp(0.001, 0.999);
    Some(FreeformClosestPoint {
        t: clamped_t,
        point: evaluate_cubic_bezier(
            segment.start,
            segment.start_out,
            segment.end_in,
            segment.end,
            clamped_t,
        ),
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InsertPointIntoFreeformSegmentOptions {
    pub points: Vec<FreeformPathPoint>,
    pub segment_index: i64,
    pub point_id: String,
    pub t: f64,
    pub closed: bool,
}

/// Insert a new anchor onto a bezier segment by De Casteljau subdivision.
///
/// The two surrounding anchors are rewritten with handles that continue the
/// original curve exactly, and the new anchor lands on the curve at `t`. An
/// out-of-range segment is a no-op, matching the TS — the caller treats that
/// as a signal to surface an error.
#[export]
pub fn insert_point_into_freeform_segment(
    InsertPointIntoFreeformSegmentOptions {
        points,
        segment_index,
        point_id,
        t,
        closed,
    }: InsertPointIntoFreeformSegmentOptions,
) -> Vec<FreeformPathPoint> {
    let Some((start_index, end_index)) = freeform_segment_indices(&points, segment_index, closed)
    else {
        return points;
    };

    let start_point = points[start_index].clone();
    let end_point = points[end_index].clone();
    let clamped_t = t.clamp(0.001, 0.999);

    let p0 = FreeformCanvasPoint {
        x: start_point.x,
        y: start_point.y,
    };
    let p1 = FreeformCanvasPoint {
        x: start_point.x + start_point.out_x,
        y: start_point.y + start_point.out_y,
    };
    let p2 = FreeformCanvasPoint {
        x: end_point.x + end_point.in_x,
        y: end_point.y + end_point.in_y,
    };
    let p3 = FreeformCanvasPoint {
        x: end_point.x,
        y: end_point.y,
    };
    let (p01, _p12, p23, p012, p123, split_point) =
        subdivide_cubic_bezier(p0, p1, p2, p3, clamped_t);

    let mut next_points = points;
    next_points[start_index] = FreeformPathPoint {
        out_x: p01.x - start_point.x,
        out_y: p01.y - start_point.y,
        ..start_point
    };
    next_points[end_index] = FreeformPathPoint {
        in_x: p23.x - end_point.x,
        in_y: p23.y - end_point.y,
        ..end_point
    };
    next_points.insert(
        end_index,
        FreeformPathPoint {
            id: point_id,
            x: split_point.x,
            y: split_point.y,
            in_x: p012.x - split_point.x,
            in_y: p012.y - split_point.y,
            out_x: p123.x - split_point.x,
            out_y: p123.y - split_point.y,
        },
    );
    next_points
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetFreeformLocalBoundsOptions {
    pub points: Vec<FreeformPathPoint>,
    pub bounds: FreeformElementBounds,
}

/// The local-frame AABB of the path — what the box-mask resize handles measure
/// against.
///
/// An empty path returns `None`, the same shape the TS produces.
#[export]
pub fn get_freeform_local_bounds(
    GetFreeformLocalBoundsOptions { points, bounds }: GetFreeformLocalBoundsOptions,
) -> Option<FreeformLocalBounds> {
    if points.is_empty() {
        return None;
    }

    let values: Vec<FreeformCanvasPoint> = points
        .iter()
        .flat_map(|point| {
            [
                FreeformCanvasPoint {
                    x: point.x * bounds.width,
                    y: point.y * bounds.height,
                },
                FreeformCanvasPoint {
                    x: (point.x + point.in_x) * bounds.width,
                    y: (point.y + point.in_y) * bounds.height,
                },
                FreeformCanvasPoint {
                    x: (point.x + point.out_x) * bounds.width,
                    y: (point.y + point.out_y) * bounds.height,
                },
            ]
        })
        .collect();

    let local = canvas_point_bounds(&values)?;
    Some(FreeformLocalBounds {
        width: local.width,
        height: local.height,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecenterFreeformPathOptions {
    pub points: Vec<FreeformPathPoint>,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
}

/// Re-anchor a path so its canvas-space centre lands on `(0, 0)` in the
/// element's local frame.
///
/// The point IDs survive the rewrite so the surrounding UI can keep its
/// selection. An empty path is a no-op.
#[export]
pub fn recenter_freeform_path(
    RecenterFreeformPathOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    }: RecenterFreeformPathOptions,
) -> FreeformRecenteredPath {
    if points.is_empty() {
        return FreeformRecenteredPath {
            center_x,
            center_y,
            points,
        };
    }

    let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
        points: points.clone(),
        center_x,
        center_y,
        rotation,
        scale,
        bounds: bounds.clone(),
    });
    let Some(geometry_bounds) = geometry.bounds else {
        return FreeformRecenteredPath {
            center_x,
            center_y,
            points,
        };
    };

    let next_center_canvas = FreeformCanvasPoint {
        x: geometry_bounds.center_x,
        y: geometry_bounds.center_y,
    };
    let next_center_local = FreeformCanvasPoint {
        x: if bounds.width == 0.0 {
            0.0
        } else {
            (next_center_canvas.x - bounds.cx) / bounds.width
        },
        y: if bounds.height == 0.0 {
            0.0
        } else {
            (next_center_canvas.y - bounds.cy) / bounds.height
        },
    };

    let next_points: Vec<FreeformPathPoint> = geometry
        .anchors
        .iter()
        .map(|anchor| {
            let anchor_local = freeform_canvas_point_to_local_inner(
                anchor.anchor,
                next_center_local.x,
                next_center_local.y,
                rotation,
                scale,
                &bounds,
            );
            let in_local = freeform_canvas_point_to_local_inner(
                anchor.in_handle,
                next_center_local.x,
                next_center_local.y,
                rotation,
                scale,
                &bounds,
            );
            let out_local = freeform_canvas_point_to_local_inner(
                anchor.out_handle,
                next_center_local.x,
                next_center_local.y,
                rotation,
                scale,
                &bounds,
            );

            FreeformPathPoint {
                id: anchor.id.clone(),
                x: anchor_local.x,
                y: anchor_local.y,
                in_x: in_local.x - anchor_local.x,
                in_y: in_local.y - anchor_local.y,
                out_x: out_local.x - anchor_local.x,
                out_y: out_local.y - anchor_local.y,
            }
        })
        .collect();

    FreeformRecenteredPath {
        center_x: next_center_local.x,
        center_y: next_center_local.y,
        points: next_points,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildFreeformPath2DOptions {
    pub points: Vec<FreeformPathPoint>,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
    pub closed: bool,
}

/// A `Path2D` of the canvas-space curve.
///
/// Mirrored as a String here rather than carrying a real `Path2D`, which is a
/// browser-only type and cannot cross the wasm boundary. The JS façade turns
/// this back into a `Path2D` with `new Path2D(pathData)` on the receiving
/// side.
#[export]
pub fn build_freeform_path_2d(
    BuildFreeformPath2DOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
        closed,
    }: BuildFreeformPath2DOptions,
) -> String {
    if points.is_empty() {
        return String::new();
    }

    let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    });
    let anchors = geometry.anchors;
    if anchors.is_empty() {
        return String::new();
    }

    let mut segments = Vec::with_capacity(anchors.len() + 1);
    segments.push(format!("M {},{}", anchors[0].anchor.x, anchors[0].anchor.y));

    for index in 1..anchors.len() {
        let previous = &anchors[index - 1];
        let current = &anchors[index];
        segments.push(format!(
            "C {},{} {},{} {},{}",
            previous.out_handle.x,
            previous.out_handle.y,
            current.in_handle.x,
            current.in_handle.y,
            current.anchor.x,
            current.anchor.y
        ));
    }

    if closed && anchors.len() > 1 {
        let last = &anchors[anchors.len() - 1];
        let first = &anchors[0];
        segments.push(format!(
            "C {},{} {},{} {},{}",
            last.out_handle.x,
            last.out_handle.y,
            first.in_handle.x,
            first.in_handle.y,
            first.anchor.x,
            first.anchor.y
        ));
        segments.push("Z".to_string());
    }

    segments.join(" ")
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildFreeformSvgPathOptions {
    pub points: Vec<FreeformPathPoint>,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
    pub bounds: FreeformElementBounds,
    pub closed: bool,
}

/// The SVG path string the overlay layer draws for the freeform path.
///
/// An empty path returns `""` — the same shape the TS returns, so the overlay
/// skips the path rather than drawing an empty one.
#[export]
pub fn build_freeform_svg_path(
    BuildFreeformSvgPathOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
        closed,
    }: BuildFreeformSvgPathOptions,
) -> String {
    if points.is_empty() {
        return String::new();
    }

    let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
        points,
        center_x,
        center_y,
        rotation,
        scale,
        bounds,
    });
    let anchors = geometry.anchors;
    if anchors.is_empty() {
        return String::new();
    }

    let mut segments = Vec::with_capacity(anchors.len() + 2);
    segments.push(format!("M {},{}", anchors[0].anchor.x, anchors[0].anchor.y));

    for index in 1..anchors.len() {
        let previous = &anchors[index - 1];
        let current = &anchors[index];
        segments.push(format!(
            "C {},{} {},{} {},{}",
            previous.out_handle.x,
            previous.out_handle.y,
            current.in_handle.x,
            current.in_handle.y,
            current.anchor.x,
            current.anchor.y
        ));
    }

    if closed && anchors.len() > 1 {
        let last = &anchors[anchors.len() - 1];
        let first = &anchors[0];
        segments.push(format!(
            "C {},{} {},{} {},{}",
            last.out_handle.x,
            last.out_handle.y,
            first.in_handle.x,
            first.in_handle.y,
            first.anchor.x,
            first.anchor.y
        ));
        segments.push("Z".to_string());
    }

    segments.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds() -> FreeformElementBounds {
        FreeformElementBounds {
            cx: 100.0,
            cy: 200.0,
            width: 400.0,
            height: 300.0,
            rotation: 0.0,
        }
    }

    fn point(id: &str, x: f64, y: f64) -> FreeformPathPoint {
        FreeformPathPoint {
            id: id.to_string(),
            x,
            y,
            in_x: 0.0,
            in_y: 0.0,
            out_x: 0.0,
            out_y: 0.0,
        }
    }

    /// Trig goes through libm here and through V8 in the parity test. The
    /// framework tolerates `1e-12` relative drift on leaves; we pin well below
    /// that so a real mistake in the math fails rather than hiding inside the
    /// ulp gap. `1e-9` is the same tolerance the box-mask module uses.
    fn assert_close(actual: f64, expected: f64) {
        let diff = (actual - expected).abs();
        let scale = actual.abs().max(expected.abs());
        let tolerance = if scale < 1.0 { 1e-9 } else { 1e-9 * scale };
        assert!(
            diff <= tolerance,
            "expected {expected}, got {actual} (diff {diff}, tolerance {tolerance})"
        );
    }

    #[test]
    fn removing_no_ids_is_a_no_op() {
        let input = vec![point("a", 0.0, 0.0), point("b", 1.0, 1.0)];
        let output = remove_freeform_path_points(RemoveFreeformPathPointsOptions {
            points: input.clone(),
            point_ids: vec![],
        });
        assert_eq!(output, input);
    }

    #[test]
    fn remove_freeform_path_points_drops_named_ids() {
        let output = remove_freeform_path_points(RemoveFreeformPathPointsOptions {
            points: vec![
                point("a", 0.0, 0.0),
                point("b", 1.0, 1.0),
                point("c", 2.0, 2.0),
            ],
            point_ids: vec!["a".to_string(), "c".to_string()],
        });
        assert_eq!(output, vec![point("b", 1.0, 1.0)]);
    }

    #[test]
    fn closed_state_after_removal_needs_three_remaining_points() {
        assert!(get_freeform_path_closed_state_after_point_removal(
            GetFreeformPathClosedStateAfterPointRemovalOptions {
                was_closed: true,
                remaining_point_count: 3
            }
        ));
        assert!(!get_freeform_path_closed_state_after_point_removal(
            GetFreeformPathClosedStateAfterPointRemovalOptions {
                was_closed: true,
                remaining_point_count: 2
            }
        ));
        assert!(!get_freeform_path_closed_state_after_point_removal(
            GetFreeformPathClosedStateAfterPointRemovalOptions {
                was_closed: true,
                remaining_point_count: 0
            }
        ));
        assert!(!get_freeform_path_closed_state_after_point_removal(
            GetFreeformPathClosedStateAfterPointRemovalOptions {
                was_closed: false,
                remaining_point_count: 10
            }
        ));
    }

    #[test]
    fn canvas_point_to_local_handles_zero_sized_bounds() {
        let degenerate = FreeformElementBounds {
            cx: 0.0,
            cy: 0.0,
            width: 0.0,
            height: 0.0,
            rotation: 0.0,
        };
        let result = freeform_canvas_point_to_local(FreeformTransformOptions {
            point: FreeformCanvasPoint { x: 1.0, y: 2.0 },
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: degenerate,
        });
        assert_eq!(result, FreeformCanvasPoint { x: 0.0, y: 0.0 });
    }

    #[test]
    fn canvas_point_to_local_inverts_local_to_canvas() {
        let original = FreeformCanvasPoint { x: 137.0, y: -42.0 };
        let local = freeform_canvas_point_to_local(FreeformTransformOptions {
            point: original,
            center_x: 0.25,
            center_y: -0.5,
            rotation: 37.0,
            scale: 1.5,
            bounds: bounds(),
        });
        let back = freeform_local_point_to_canvas(local, 0.25, -0.5, 37.0, 1.5, &bounds());
        assert_close(back.x, original.x);
        assert_close(back.y, original.y);
    }

    #[test]
    fn canvas_geometry_bounds_is_none_for_an_empty_path() {
        let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
            points: vec![],
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
        });
        assert!(geometry.anchors.is_empty());
        assert!(geometry.bounds.is_none());
    }

    #[test]
    fn canvas_geometry_projects_an_anchor_with_handles() {
        let mut p = point("a", 0.0, 0.0);
        p.in_x = -0.1;
        p.in_y = 0.0;
        p.out_x = 0.2;
        p.out_y = 0.0;
        let geometry = get_freeform_canvas_geometry(GetFreeformCanvasGeometryOptions {
            points: vec![p],
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
        });
        assert_eq!(geometry.anchors.len(), 1);
        let anchor = &geometry.anchors[0];
        // Bounds cx=100, cy=200, width=400, height=300: the anchor lands on the
        // element centre.
        assert_eq!(anchor.anchor, FreeformCanvasPoint { x: 100.0, y: 200.0 });
        // In-handle at local (-0.1, 0) -> canvas (-0.1 * 400, 0) = (-40, 0).
        assert_eq!(anchor.in_handle, FreeformCanvasPoint { x: 60.0, y: 200.0 });
        // Out-handle at local (0.2, 0) -> canvas (0.2 * 400, 0) = (80, 0).
        assert_eq!(anchor.out_handle, FreeformCanvasPoint { x: 180.0, y: 200.0 });
    }

    #[test]
    fn canvas_bounds_have_a_unit_floor_on_each_axis() {
        let collapse = canvas_point_bounds(&[
            FreeformCanvasPoint { x: 1.0, y: 1.0 },
            FreeformCanvasPoint { x: 1.0, y: 1.0 },
        ])
        .unwrap();
        assert_eq!(collapse.width, 1.0);
        assert_eq!(collapse.height, 1.0);
    }

    #[test]
    fn segment_count_distinguishes_open_and_closed() {
        let points = vec![point("a", 0.0, 0.0), point("b", 1.0, 0.0), point("c", 1.0, 1.0)];

        assert_eq!(
            get_freeform_segment_count(FreeformSegmentCountOptions {
                points: points.clone(),
                closed: false
            }),
            2
        );
        assert_eq!(
            get_freeform_segment_count(FreeformSegmentCountOptions {
                points: points.clone(),
                closed: true
            }),
            3
        );
        assert_eq!(
            get_freeform_segment_count(FreeformSegmentCountOptions {
                points: vec![point("solo", 0.0, 0.0)],
                closed: true
            }),
            0
        );
        assert_eq!(
            get_freeform_segment_count(FreeformSegmentCountOptions {
                points: vec![],
                closed: true
            }),
            0
        );
    }

    #[test]
    fn canvas_segments_wrap_around_when_closed() {
        let points = vec![
            point("a", -0.1, 0.0),
            point("b", 0.1, 0.0),
            point("c", 0.0, 0.1),
        ];
        let segments = get_freeform_canvas_segments(GetFreeformCanvasSegmentsOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: true,
        });
        assert_eq!(segments.len(), 3);
        // The last segment runs from `c` back to `a`, which is what the wrap
        // around is meant to do.
        assert_eq!(segments[2].start_point_id, "c");
        assert_eq!(segments[2].end_point_id, "a");
    }

    #[test]
    fn canvas_segments_omit_the_wrap_segment_when_open() {
        let points = vec![
            point("a", 0.0, 0.0),
            point("b", 0.5, 0.0),
            point("c", 1.0, 0.0),
        ];
        let segments = get_freeform_canvas_segments(GetFreeformCanvasSegmentsOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[1].end_point_id, "c");
    }

    #[test]
    fn find_closest_point_returns_none_for_an_unknown_segment() {
        let result = find_closest_point_on_freeform_segment(FindClosestPointOnFreeformSegmentOptions {
            points: vec![point("a", 0.0, 0.0), point("b", 1.0, 0.0)],
            segment_index: 5,
            canvas_point: FreeformCanvasPoint { x: 0.5, y: 0.0 },
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert!(result.is_none());
    }

    #[test]
    fn find_closest_point_lands_on_a_straight_line_segment() {
        // A straight segment from canvas (0, 0) to (100, 0). The query is at
        // (37.5, 5); the closest point lies on the segment at (37.5, 0).
        let mut a = point("a", 0.0, 0.0);
        a.out_x = 1.0 / 3.0;
        a.out_y = 0.0;
        let mut b = point("b", 1.0, 0.0);
        b.in_x = -1.0 / 3.0;
        b.in_y = 0.0;
        let closest = find_closest_point_on_freeform_segment(FindClosestPointOnFreeformSegmentOptions {
            points: vec![a, b],
            segment_index: 0,
            canvas_point: FreeformCanvasPoint { x: 37.5, y: 5.0 },
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: FreeformElementBounds {
                cx: 0.0,
                cy: 0.0,
                width: 100.0,
                height: 100.0,
                rotation: 0.0,
            },
            closed: false,
        })
        .unwrap();
        assert_close(closest.point.x, 37.5);
        assert_close(closest.point.y, 0.0);
    }

    #[test]
    fn insert_point_into_segment_preserves_the_curve_at_t_half() {
        // Symmetric bezier: anchor at (0,0), control points at (33, 50) and
        // (66, 50), end at (100, 0). Splitting at t=0.5 should land on
        // (50, 37.5) — the midpoint of the symmetric arc.
        let mut a = point("a", 0.0, 0.0);
        a.out_x = 1.0 / 3.0;
        a.out_y = 50.0 / 100.0;
        let mut b = point("b", 1.0, 0.0);
        b.in_x = -1.0 / 3.0;
        b.in_y = 50.0 / 100.0;
        let points = vec![a, b];
        let next = insert_point_into_freeform_segment(InsertPointIntoFreeformSegmentOptions {
            points: points.clone(),
            segment_index: 0,
            point_id: "split".to_string(),
            t: 0.5,
            closed: false,
        });
        assert_eq!(next.len(), 3);
        let split = &next[1];
        assert_eq!(split.id, "split");
        assert_close(split.x, 0.5);
        assert_close(split.y, 0.375);

        // The original segment's endpoint has not moved.
        assert_close(next[2].x, 1.0);
        assert_close(next[2].y, 0.0);
    }

    #[test]
    fn insert_point_out_of_range_segment_is_a_no_op() {
        let points = vec![point("a", 0.0, 0.0), point("b", 1.0, 0.0)];
        let next = insert_point_into_freeform_segment(InsertPointIntoFreeformSegmentOptions {
            points: points.clone(),
            segment_index: 99,
            point_id: "split".to_string(),
            t: 0.5,
            closed: false,
        });
        assert_eq!(next, points);
    }

    #[test]
    fn local_bounds_are_none_for_an_empty_path() {
        let result = get_freeform_local_bounds(GetFreeformLocalBoundsOptions {
            points: vec![],
            bounds: bounds(),
        });
        assert!(result.is_none());
    }

    #[test]
    fn local_bounds_use_the_handles_too() {
        let mut p = point("a", 0.0, 0.0);
        p.in_x = -0.25;
        p.in_y = -0.25;
        p.out_x = 0.25;
        p.out_y = 0.25;
        let result = get_freeform_local_bounds(GetFreeformLocalBoundsOptions {
            points: vec![p],
            bounds: bounds(),
        })
        .unwrap();
        // The anchor sits at local (0, 0) which scales to the bounds origin.
        // The handles at ±0.25 scale to ±100 (× bounds.width) and ±75 (×
        // bounds.height), so the AABB spans the full handle range.
        assert_close(result.width, 200.0);
        assert_close(result.height, 150.0);
    }

    #[test]
    fn local_bounds_with_two_separate_points_tracks_the_aabb() {
        let points = vec![
            point("a", -0.1, -0.1),
            point("b", 0.1, 0.1),
        ];
        let result = get_freeform_local_bounds(GetFreeformLocalBoundsOptions {
            points,
            bounds: bounds(),
        })
        .unwrap();
        // AABB in canvas units: width = 0.2 * 400 = 80, height = 0.2 * 300 = 60.
        assert_close(result.width, 80.0);
        assert_close(result.height, 60.0);
    }

    #[test]
    fn recenter_an_empty_path_is_a_no_op() {
        let result = recenter_freeform_path(RecenterFreeformPathOptions {
            points: vec![],
            center_x: 0.3,
            center_y: 0.4,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
        });
        assert_eq!(result.center_x, 0.3);
        assert_eq!(result.center_y, 0.4);
        assert!(result.points.is_empty());
    }

#[test]
    fn recenter_moves_the_local_center_to_the_canvas_centroid() {
        // Two anchors at local (-0.25, 0) and (0.5, 0) sitting in a mask with
        // local centre (0.1, 0). Their canvas-space midpoint is at local
        // (0.225, 0), which is what the recentre result should report.
        let points = vec![point("a", -0.25, 0.0), point("b", 0.5, 0.0)];
        let recentered = recenter_freeform_path(RecenterFreeformPathOptions {
            points: points.clone(),
            center_x: 0.1,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
        });
        assert_close(recentered.center_x, 0.225);
        assert_close(recentered.center_y, 0.0);
        // The relative spread of the anchors is preserved.
        assert_close(
            recentered.points[1].x - recentered.points[0].x,
            points[1].x - points[0].x,
        );
        assert_eq!(recentered.points[0].id, "a");
        assert_eq!(recentered.points[1].id, "b");
    }

    #[test]
    fn recenter_keeps_a_centred_path_in_place() {
        // Anchors whose canvas-space midpoint already lies at (cx, cy).
        // Recentring should not move the local centre.
        let points = vec![point("a", -0.25, 0.0), point("b", 0.25, 0.0)];
        let recentered = recenter_freeform_path(RecenterFreeformPathOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
        });
        assert_close(recentered.center_x, 0.0);
        assert_close(recentered.center_y, 0.0);
        // The anchors keep their local coordinates.
        assert_close(recentered.points[0].x, -0.25);
        assert_close(recentered.points[1].x, 0.25);
    }

    #[test]
    fn build_path_2d_is_empty_for_an_empty_path() {
        let path = build_freeform_path_2d(BuildFreeformPath2DOptions {
            points: vec![],
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert_eq!(path, "");
    }

    #[test]
    fn build_path_2d_appends_a_z_when_closed() {
        let points = vec![
            point("a", 0.0, 0.0),
            point("b", 0.5, 0.0),
            point("c", 0.5, 0.5),
        ];
        let path = build_freeform_path_2d(BuildFreeformPath2DOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: true,
        });
        // Closed paths end with a `Z` to seal the loop.
        assert!(path.ends_with('Z'));
    }

    #[test]
    fn build_path_2d_skips_the_z_when_open() {
        let points = vec![point("a", 0.0, 0.0), point("b", 1.0, 0.0)];
        let path = build_freeform_path_2d(BuildFreeformPath2DOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert!(!path.ends_with('Z'));
        // No closing segment: only one bezier command.
        assert_eq!(path.matches('C').count(), 1);
    }

    #[test]
    fn svg_path_is_empty_for_an_empty_path() {
        let path = build_freeform_svg_path(BuildFreeformSvgPathOptions {
            points: vec![],
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert_eq!(path, "");
    }

    #[test]
    fn svg_path_emits_m_then_one_c_per_segment() {
        let points = vec![
            point("a", 0.0, 0.0),
            point("b", 0.5, 0.0),
            point("c", 1.0, 0.0),
        ];
        let path = build_freeform_svg_path(BuildFreeformSvgPathOptions {
            points,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
            bounds: bounds(),
            closed: false,
        });
        assert_eq!(path.matches('M').count(), 1);
        assert_eq!(path.matches('C').count(), 2);
        assert!(!path.contains('Z'));
    }
}