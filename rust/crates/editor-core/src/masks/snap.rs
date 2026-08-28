//! How a mask snaps to canvas edges and centre lines while it's being dragged.
//!
//! Ported from `apps/web/src/masks/snap.ts`. The dispatcher there did three jobs:
//! decide which handle is being dragged, build the geometry the snap needs, and
//! apply the snapped position back onto the params. This module keeps that order
//! and follows the same branch tree — `position` snaps the centre, `rotation`
//! snaps the angle, and the rest is a size snap or a pass-through depending on
//! the handle.
//!
//! The two parameter shapes (`RectangleMaskParams` and `SplitMaskParams`) only
//! differ in whether they carry width/height/scale. Rust doesn't have function
//! overloads, so each TS overload becomes its own function — `snap_box_mask_*`
//! takes the rectangle params, `snap_split_mask_*` takes the split params — and
//! the dispatcher picks the right one.
//!
//! No `Math.round` is used here, so the JS rounding rules in [`crate::math`]
//! stay out of the picture. `Math.max` and `Math.sign` are exact on `f64` —
//! they only need to be lifted into the right Rust call.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::masks::handle_positions::{
    MaskHandleCornerX, MaskHandleCornerY, MaskHandleId, MaskHandleSide,
};
use crate::preview::{
    PreviewScaleEdgePreference, PreviewSnapLine, PreviewSnapLineKind, PreviewSnapPoint,
    PreviewSnapPositionOptions, PreviewSnapResult, PreviewSnapRotationOptions, PreviewSnapSize,
    preview_snap_position, preview_snap_rotation, preview_snap_scale, preview_snap_scale_axes,
    PreviewSnapScaleOptions, PreviewSnapScaleAxesOptions,
};

/// Minimum normalised dimension the editor accepts for a mask. Below this the
/// mask is degenerate and the snap helpers treat the input as if it were this
/// value, matching `builtin::box_like::MIN_MASK_DIMENSION`.
const MIN_MASK_DIMENSION: f64 = 0.01;

/// Canvas-space point. Reuses `PreviewSnapPoint`'s shape so the wasm types
/// stay consistent with the existing preview-snap module.
type Point = PreviewSnapPoint;

/// Canvas-space width/height pair.
type Size = PreviewSnapSize;

/// Bounds of the element a mask is attached to, in canvas coordinates. The
/// `rotation` field exists on `ElementBounds` but is not read here — a mask's
/// snapping operates in canvas space, not in the element's own rotated frame.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementBounds {
    pub cx: f64,
    pub cy: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

/// The base fields every mask param shape carries. Carried by value through
/// the snap call so a snapped result can be returned without cloning the
/// caller's tree.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseMaskParams {
    pub feather: f64,
    pub inverted: bool,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_align: String,
}

/// Params for a box-like mask (rectangle, ellipse, star, …). Carries
/// width/height/scale on top of the base fields, which is what
/// `getMaskSnapGeometry` keys off to recognise a rectangle.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RectangleMaskParams {
    #[serde(flatten)]
    pub base: BaseMaskParams,
    pub center_x: f64,
    pub center_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub scale: f64,
}

/// Params for a split mask. No width/height/scale — the line cuts the whole
/// frame — so `getMaskSnapGeometry` falls into the degenerate branch for
/// these.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitMaskParams {
    #[serde(flatten)]
    pub base: BaseMaskParams,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
}

/// Per-axis snap threshold, in canvas units. Matches the shape that flows
/// through from the UI's screen-pixel threshold.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskSnapThreshold {
    pub x: f64,
    pub y: f64,
}

impl From<MaskSnapThreshold> for PreviewSnapPoint {
    fn from(value: MaskSnapThreshold) -> Self {
        PreviewSnapPoint { x: value.x, y: value.y }
    }
}

/// The canvas size the user is dragging on. Distinct from `ElementBounds`
/// because the canvas can letterbox the element.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskCanvasSize {
    pub width: f64,
    pub height: f64,
}

impl From<MaskCanvasSize> for PreviewSnapSize {
    fn from(value: MaskCanvasSize) -> Self {
        PreviewSnapSize { width: value.width, height: value.height }
    }
}

impl From<ElementBounds> for PreviewSnapSize {
    fn from(value: ElementBounds) -> Self {
        PreviewSnapSize { width: value.width, height: value.height }
    }
}

/// Concrete result type for a box-mask snap. Two flavours exist because
/// `wasm-bindgen` cannot export a generic return type, so the box and split
/// dispatchers each name the params shape they carry.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskBoxSnapResult {
    pub params: RectangleMaskParams,
    pub active_lines: Vec<PreviewSnapLine>,
}

/// Concrete result type for a split-mask snap.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaskSplitSnapResult {
    pub params: SplitMaskParams,
    pub active_lines: Vec<PreviewSnapLine>,
}

/// Snap a ratio between two normalised dimensions, clamping each side to the
/// minimum mask dimension so a divide-by-zero is impossible.
///
/// Equivalent to `Math.max(next, MIN) / Math.max(base, MIN)` in the TS.
fn get_clamped_ratio(next: f64, base: f64) -> f64 {
    next.max(MIN_MASK_DIMENSION) / base.max(MIN_MASK_DIMENSION)
}

/// Which edges the gesture is dragging. An edge handle moves one; a corner
/// moves two. Returns `None` for handles that don't move an edge (position,
/// rotation, feather, freeform anchors), so the snap picks up every touching
/// guide instead of suppressing them.
fn get_preferred_edges(handle_id: &MaskHandleId) -> Option<PreviewScaleEdgePreference> {
    match handle_id {
        MaskHandleId::Edge { side } => Some(PreviewScaleEdgePreference {
            left: Some(*side == MaskHandleSide::Left),
            right: Some(*side == MaskHandleSide::Right),
            top: Some(*side == MaskHandleSide::Top),
            bottom: Some(*side == MaskHandleSide::Bottom),
        }),
        MaskHandleId::Corner { corner } => Some(PreviewScaleEdgePreference {
            left: Some(corner.x == MaskHandleCornerX::Left),
            right: Some(corner.x == MaskHandleCornerX::Right),
            top: Some(corner.y == MaskHandleCornerY::Top),
            bottom: Some(corner.y == MaskHandleCornerY::Bottom),
        }),
        _ => None,
    }
}

/// Translate the params into the canvas-space centre the snap operates on.
fn mask_local_center(params_center_x: f64, params_center_y: f64, bounds: ElementBounds) -> Point {
    Point {
        x: params_center_x * bounds.width,
        y: params_center_y * bounds.height,
    }
}

/// Pull the centre back into normalised coords. Mirrors `setMaskLocalCenter`
/// in `apps/web/src/masks/geometry.ts` — division by zero yields 0 rather
/// than `NaN`, which is what the TS guard produced.
fn set_mask_local_center(center: Point, bounds: ElementBounds) -> (f64, f64) {
    let center_x = if bounds.width == 0.0 { 0.0 } else { center.x / bounds.width };
    let center_y = if bounds.height == 0.0 { 0.0 } else { center.y / bounds.height };
    (center_x, center_y)
}

/// Move a list of snap lines from the element's centred frame into canvas
/// coordinates. The snap module works in an origin-at-the-element-centre
/// frame; the UI draws on the canvas, where the element sits at
/// `(bounds.cx, canvas_size / 2)`.
fn to_global_mask_snap_lines(
    lines: &[PreviewSnapLine],
    bounds: ElementBounds,
    canvas_size: MaskCanvasSize,
) -> Vec<PreviewSnapLine> {
    let center_x = bounds.cx - canvas_size.width / 2.0;
    let center_y = bounds.cy - canvas_size.height / 2.0;
    lines
        .iter()
        .map(|line| PreviewSnapLine {
            kind: line.kind,
            position: match line.kind {
                PreviewSnapLineKind::Vertical => center_x + line.position,
                PreviewSnapLineKind::Horizontal => center_y + line.position,
            },
        })
        .collect()
}

/// Pull position/rotation out of a split mask's params. A split mask has no
/// size of its own — the line cuts the whole frame — so the snap is
/// positioned against a zero-size element.
fn get_split_mask_snap_geometry(
    params: &SplitMaskParams,
    bounds: ElementBounds,
) -> SplitSnapGeometry {
    SplitSnapGeometry {
        position: mask_local_center(params.center_x, params.center_y, bounds),
        size: Size { width: 0.0, height: 0.0 },
        rotation: params.rotation,
    }
}

struct BoxSnapGeometry {
    position: Point,
    size: Size,
    rotation: f64,
}

impl BoxSnapGeometry {
    fn new(params: &RectangleMaskParams, bounds: ElementBounds) -> Self {
        BoxSnapGeometry {
            position: mask_local_center(params.center_x, params.center_y, bounds),
            size: Size {
                width: params.width.max(MIN_MASK_DIMENSION) * bounds.width,
                height: params.height.max(MIN_MASK_DIMENSION) * bounds.height,
            },
            rotation: params.rotation,
        }
    }
}

struct SplitSnapGeometry {
    position: Point,
    size: Size,
    rotation: f64,
}

fn snap_box_mask_position(
    proposed_params: &RectangleMaskParams,
    bounds: ElementBounds,
    canvas_size: MaskCanvasSize,
    snap_threshold: MaskSnapThreshold,
) -> MaskBoxSnapResult {
    let geometry = BoxSnapGeometry::new(proposed_params, bounds);
    let PreviewSnapResult {
        snapped_position,
        active_lines,
    } = preview_snap_position(PreviewSnapPositionOptions {
        proposed_position: geometry.position,
        canvas_size: bounds.into(),
        element_size: geometry.size,
        rotation: Some(geometry.rotation),
        snap_threshold: snap_threshold.into(),
    });
    let (center_x, center_y) = set_mask_local_center(snapped_position, bounds);
    let mut snapped = proposed_params.clone();
    snapped.center_x = center_x;
    snapped.center_y = center_y;
    MaskBoxSnapResult {
        params: snapped,
        active_lines: to_global_mask_snap_lines(&active_lines, bounds, canvas_size),
    }
}

fn snap_split_mask_position(
    proposed_params: &SplitMaskParams,
    bounds: ElementBounds,
    canvas_size: MaskCanvasSize,
    snap_threshold: MaskSnapThreshold,
) -> MaskSplitSnapResult {
    let geometry = get_split_mask_snap_geometry(proposed_params, bounds);
    let PreviewSnapResult {
        snapped_position,
        active_lines,
    } = preview_snap_position(PreviewSnapPositionOptions {
        proposed_position: geometry.position,
        canvas_size: bounds.into(),
        element_size: geometry.size,
        rotation: Some(geometry.rotation),
        snap_threshold: snap_threshold.into(),
    });
    let (center_x, center_y) = set_mask_local_center(snapped_position, bounds);
    let mut snapped = proposed_params.clone();
    snapped.center_x = center_x;
    snapped.center_y = center_y;
    MaskSplitSnapResult {
        params: snapped,
        active_lines: to_global_mask_snap_lines(&active_lines, bounds, canvas_size),
    }
}

fn snap_box_mask_rotation(proposed_params: &RectangleMaskParams) -> MaskBoxSnapResult {
    let result = preview_snap_rotation(PreviewSnapRotationOptions {
        proposed_rotation: proposed_params.rotation,
    });
    let mut snapped = proposed_params.clone();
    snapped.rotation = result.snapped_rotation;
    MaskBoxSnapResult {
        params: snapped,
        active_lines: Vec::new(),
    }
}

fn snap_split_mask_rotation(proposed_params: &SplitMaskParams) -> MaskSplitSnapResult {
    let result = preview_snap_rotation(PreviewSnapRotationOptions {
        proposed_rotation: proposed_params.rotation,
    });
    let mut snapped = proposed_params.clone();
    snapped.rotation = result.snapped_rotation;
    MaskSplitSnapResult {
        params: snapped,
        active_lines: Vec::new(),
    }
}

/// Snap the resize handle that's being dragged. Width/height handles snap
/// per-axis through `preview_snap_scale_axes`; the uniform scale handle and
/// the corner handles snap uniformly through `preview_snap_scale`. Anything
/// else (the unhandled `kind`s: `feather`, freeform anchors and segments)
/// falls through with `params` untouched.
fn snap_box_mask_size(
    handle_id: &MaskHandleId,
    start_params: &RectangleMaskParams,
    proposed_params: &RectangleMaskParams,
    bounds: ElementBounds,
    canvas_size: MaskCanvasSize,
    snap_threshold: MaskSnapThreshold,
) -> MaskBoxSnapResult {
    let geometry = BoxSnapGeometry::new(proposed_params, bounds);
    let local_canvas_size = bounds;
    let base_width = start_params.width.max(MIN_MASK_DIMENSION) * bounds.width;
    let base_height = start_params.height.max(MIN_MASK_DIMENSION) * bounds.height;
    let preferred_edges = get_preferred_edges(handle_id);

    if let MaskHandleId::Edge { side } = handle_id {
        if side == &MaskHandleSide::Right || side == &MaskHandleSide::Left {
            let proposed_scale_x = get_clamped_ratio(proposed_params.width, start_params.width);
            let result = preview_snap_scale_axes(
                PreviewSnapScaleAxesOptions {
                    proposed_scale_x,
                    proposed_scale_y: 1.0,
                    position: geometry.position,
                    base_width,
                    base_height,
                    rotation: Some(proposed_params.rotation),
                    canvas_size: local_canvas_size.into(),
                    snap_threshold: snap_threshold.into(),
                    preferred_edges,
                },
            );
            let mut snapped = proposed_params.clone();
            snapped.width = MIN_MASK_DIMENSION.max(start_params.width * result.x.snapped_scale);
            return MaskBoxSnapResult {
                params: snapped,
                active_lines: to_global_mask_snap_lines(&result.x.active_lines, bounds, canvas_size),
            };
        }
        if side == &MaskHandleSide::Top || side == &MaskHandleSide::Bottom {
            let proposed_scale_y = get_clamped_ratio(proposed_params.height, start_params.height);
            let result = preview_snap_scale_axes(
                PreviewSnapScaleAxesOptions {
                    proposed_scale_x: 1.0,
                    proposed_scale_y,
                    position: geometry.position,
                    base_width,
                    base_height,
                    rotation: Some(proposed_params.rotation),
                    canvas_size: local_canvas_size.into(),
                    snap_threshold: snap_threshold.into(),
                    preferred_edges,
                },
            );
            let mut snapped = proposed_params.clone();
            snapped.height =
                MIN_MASK_DIMENSION.max(start_params.height * result.y.snapped_scale);
            return MaskBoxSnapResult {
                params: snapped,
                active_lines: to_global_mask_snap_lines(&result.y.active_lines, bounds, canvas_size),
            };
        }
    }

    if matches!(handle_id, MaskHandleId::Scale) {
        let base_scale = start_params.scale.max(MIN_MASK_DIMENSION);
        let proposed_scale = get_clamped_ratio(proposed_params.scale, start_params.scale);
        let result = preview_snap_scale(
            PreviewSnapScaleOptions {
                proposed_scale,
                position: geometry.position,
                base_width: base_width * base_scale,
                base_height: base_height * base_scale,
                rotation: Some(proposed_params.rotation),
                canvas_size: local_canvas_size.into(),
                snap_threshold: snap_threshold.into(),
                preferred_edges,
            },
        );
        let mut snapped = proposed_params.clone();
        snapped.scale = MIN_MASK_DIMENSION.max(start_params.scale * result.snapped_scale);
        return MaskBoxSnapResult {
            params: snapped,
            active_lines: to_global_mask_snap_lines(&result.active_lines, bounds, canvas_size),
        };
    }

    if matches!(handle_id, MaskHandleId::Corner { .. }) {
        let proposed_scale = get_clamped_ratio(proposed_params.width, start_params.width);
        let result = preview_snap_scale(
            PreviewSnapScaleOptions {
                proposed_scale,
                position: geometry.position,
                base_width,
                base_height,
                rotation: Some(proposed_params.rotation),
                canvas_size: local_canvas_size.into(),
                snap_threshold: snap_threshold.into(),
                preferred_edges,
            },
        );
        let mut snapped = proposed_params.clone();
        snapped.width = MIN_MASK_DIMENSION.max(start_params.width * result.snapped_scale);
        snapped.height = MIN_MASK_DIMENSION.max(start_params.height * result.snapped_scale);
        return MaskBoxSnapResult {
            params: snapped,
            active_lines: to_global_mask_snap_lines(&result.active_lines, bounds, canvas_size),
        };
    }

    MaskBoxSnapResult {
        params: proposed_params.clone(),
        active_lines: Vec::new(),
    }
}

/// Args passed to the box-mask dispatcher. Mirror of
/// `MaskSnapArgs<RectangleMaskParams>` in `apps/web/src/masks/types.ts`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapBoxMaskInteractionOptions {
    pub handle_id: MaskHandleId,
    pub start_params: RectangleMaskParams,
    pub proposed_params: RectangleMaskParams,
    pub bounds: ElementBounds,
    pub canvas_size: MaskCanvasSize,
    pub snap_threshold: MaskSnapThreshold,
}

/// Args passed to the split-mask dispatcher. Mirror of
/// `MaskSnapArgs<SplitMaskParams>`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapSplitMaskInteractionOptions {
    pub handle_id: MaskHandleId,
    pub proposed_params: SplitMaskParams,
    pub bounds: ElementBounds,
    pub canvas_size: MaskCanvasSize,
    pub snap_threshold: MaskSnapThreshold,
}

/// Box-mask snap entry point. Dispatches by `handle_id.kind` to the position,
/// rotation, or size snap.
#[export]
pub fn snap_box_mask_interaction(
    SnapBoxMaskInteractionOptions {
        handle_id,
        start_params,
        proposed_params,
        bounds,
        canvas_size,
        snap_threshold,
    }: SnapBoxMaskInteractionOptions,
) -> MaskBoxSnapResult {
    match &handle_id {
        MaskHandleId::Position => {
            snap_box_mask_position(&proposed_params, bounds, canvas_size, snap_threshold)
        }
        MaskHandleId::Rotation => snap_box_mask_rotation(&proposed_params),
        _ => snap_box_mask_size(
            &handle_id,
            &start_params,
            &proposed_params,
            bounds,
            canvas_size,
            snap_threshold,
        ),
    }
}

/// Split-mask snap entry point. A split mask only has position and rotation
/// handles, so the rest of the kinds are a no-op pass-through.
#[export]
pub fn snap_split_mask_interaction(
    SnapSplitMaskInteractionOptions {
        handle_id,
        proposed_params,
        bounds,
        canvas_size,
        snap_threshold,
    }: SnapSplitMaskInteractionOptions,
) -> MaskSplitSnapResult {
    match &handle_id {
        MaskHandleId::Position => {
            snap_split_mask_position(&proposed_params, bounds, canvas_size, snap_threshold)
        }
        MaskHandleId::Rotation => snap_split_mask_rotation(&proposed_params),
        _ => MaskSplitSnapResult {
            params: proposed_params.clone(),
            active_lines: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masks::handle_positions::{MaskHandleCorner, MaskHandleCornerX, MaskHandleCornerY};

    fn bounds() -> ElementBounds {
        ElementBounds {
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

    fn threshold() -> MaskSnapThreshold {
        MaskSnapThreshold { x: 8.0, y: 8.0 }
    }

    fn rectangle_params() -> RectangleMaskParams {
        RectangleMaskParams {
            base: BaseMaskParams {
                feather: 0.0,
                inverted: false,
                stroke_color: "#ffffff".to_string(),
                stroke_width: 0.0,
                stroke_align: "center".to_string(),
            },
            center_x: 0.0,
            center_y: 0.0,
            width: 0.5,
            height: 0.5,
            rotation: 0.0,
            scale: 1.0,
        }
    }

    fn split_params() -> SplitMaskParams {
        SplitMaskParams {
            base: BaseMaskParams {
                feather: 0.0,
                inverted: false,
                stroke_color: "#ffffff".to_string(),
                stroke_width: 0.0,
                stroke_align: "center".to_string(),
            },
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
        }
    }

    #[test]
    fn get_clamped_ratio_caps_zero_inputs_to_min_mask_dimension() {
        assert_eq!(get_clamped_ratio(0.0, 0.5), MIN_MASK_DIMENSION / 0.5);
        assert_eq!(get_clamped_ratio(0.5, 0.0), 0.5 / MIN_MASK_DIMENSION);
        assert_eq!(get_clamped_ratio(0.5, 0.5), 1.0);
    }

    #[test]
    fn get_preferred_edges_returns_none_for_position() {
        assert!(get_preferred_edges(&MaskHandleId::Position).is_none());
        assert!(get_preferred_edges(&MaskHandleId::Rotation).is_none());
        assert!(get_preferred_edges(&MaskHandleId::Scale).is_none());
    }

    #[test]
    fn get_preferred_edges_names_the_dragged_edge_only() {
        let left = get_preferred_edges(&MaskHandleId::Edge {
            side: MaskHandleSide::Left,
        })
        .unwrap();
        assert_eq!(left.left, Some(true));
        assert_eq!(left.right, Some(false));
        assert_eq!(left.top, Some(false));
        assert_eq!(left.bottom, Some(false));

        let right = get_preferred_edges(&MaskHandleId::Edge {
            side: MaskHandleSide::Right,
        })
        .unwrap();
        assert_eq!(right.left, Some(false));
        assert_eq!(right.right, Some(true));
        assert_eq!(right.top, Some(false));
        assert_eq!(right.bottom, Some(false));

        let top = get_preferred_edges(&MaskHandleId::Edge {
            side: MaskHandleSide::Top,
        })
        .unwrap();
        assert_eq!(top.top, Some(true));
        assert_eq!(top.left, Some(false));

        let bottom = get_preferred_edges(&MaskHandleId::Edge {
            side: MaskHandleSide::Bottom,
        })
        .unwrap();
        assert_eq!(bottom.bottom, Some(true));
        assert_eq!(bottom.right, Some(false));
    }

    #[test]
    fn get_preferred_edges_for_a_corner_names_both_axes() {
        let bottom_right = get_preferred_edges(&MaskHandleId::Corner {
            corner: MaskHandleCorner {
                x: MaskHandleCornerX::Right,
                y: MaskHandleCornerY::Bottom,
            },
        })
        .unwrap();
        assert_eq!(bottom_right.left, Some(false));
        assert_eq!(bottom_right.right, Some(true));
        assert_eq!(bottom_right.top, Some(false));
        assert_eq!(bottom_right.bottom, Some(true));
    }

    #[test]
    fn snap_box_mask_position_snaps_a_centre_offset_to_the_canvas_centre() {
        // Element-centred coords: 0.02 * 400 = 8 (inside x threshold 8) and
        // -0.01 * 300 = -3 (inside y threshold 8), so both snap to the canvas
        // centre at (0, 0) in element-centred coords.
        let proposed = RectangleMaskParams {
            center_x: 0.02,
            center_y: -0.01,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            start_params: rectangle_params(),
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.center_x, 0.0);
        assert_eq!(result.params.center_y, 0.0);
        assert_eq!(result.params.width, proposed.width);
        assert_eq!(result.params.height, proposed.height);
        assert_eq!(result.params.rotation, proposed.rotation);
        assert_eq!(result.params.scale, proposed.scale);
        assert_eq!(result.active_lines.len(), 2);
    }

    #[test]
    fn snap_box_mask_position_leaves_the_params_alone_outside_the_threshold() {
        // Element-centred: 0.1 * 400 = 40 (x) and -0.1 * 300 = -30 (y),
        // both outside the 8-unit threshold for every candidate.
        let proposed = RectangleMaskParams {
            center_x: 0.1,
            center_y: -0.1,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            start_params: rectangle_params(),
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.center_x, proposed.center_x);
        assert_eq!(result.params.center_y, proposed.center_y);
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn snap_box_mask_position_translates_active_lines_into_canvas_coordinates() {
        // A vertical guide at x=0 in element-centred coords lands at canvas
        // x = bounds.cx - canvas_width/2 = 100 - 400 = -300.
        let proposed = RectangleMaskParams {
            center_x: 0.0,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            start_params: rectangle_params(),
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        let line = result.active_lines.first().expect("a vertical guide");
        assert_eq!(line.kind, PreviewSnapLineKind::Vertical);
        assert_eq!(line.position, bounds().cx - canvas_size().width / 2.0);
    }

    #[test]
    fn snap_box_mask_rotation_snaps_to_the_nearest_right_angle() {
        let proposed = RectangleMaskParams {
            rotation: 88.0,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Rotation,
            start_params: rectangle_params(),
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.rotation, 90.0);
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn snap_box_mask_rotation_leaves_an_off_axis_rotation_alone() {
        let proposed = RectangleMaskParams {
            rotation: 45.0,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Rotation,
            start_params: rectangle_params(),
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.rotation, proposed.rotation);
    }

    #[test]
    fn snap_box_mask_size_snaps_a_right_edge_to_the_canvas_right() {
        // With element bounds (cx=100, cy=200, w=400, h=300), the canvas right
        // edge sits at element-centred x = +200 (canvas_width/2 = 400/2 = 200).
        // proposed_width=0.5 puts the mask's right edge at element x = 0 + 0.5
        // * 400 / 2 = 100, but the proposed centre at center_x=0.25 → local
        // centre at element x = 0.25 * 400 = 100. Mask right edge = 100 + 0.5
        // * 400 / 2 = 200 = canvas right. proposed_scale_x = 0.5/0.5 = 1.0
        // puts the edge at 100 + 0.5*400 = 300 in canvas coords which is
        // element-centred 200. So the snap is at the boundary.
        let proposed = RectangleMaskParams {
            center_x: 0.25,
            width: 0.5,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Edge {
                side: MaskHandleSide::Right,
            },
            start_params: rectangle_params(),
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        // Snapped width comes out exactly to 0.5 (the input), because the
        // proposed right edge was already on the canvas-right target.
        assert_eq!(result.params.width, 0.5);
        assert_eq!(result.active_lines.len(), 1);
        assert_eq!(result.active_lines[0].kind, PreviewSnapLineKind::Vertical);
    }

    #[test]
    fn snap_box_mask_size_returns_untouched_params_for_unknown_handles() {
        let proposed = RectangleMaskParams {
            width: 0.6,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Feather,
            start_params: rectangle_params(),
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.width, proposed.width);
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn snap_split_mask_position_snaps_to_the_canvas_centre() {
        let proposed = SplitMaskParams {
            center_x: 0.02,
            center_y: -0.01,
            ..split_params()
        };
        let result = snap_split_mask_interaction(SnapSplitMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.center_x, 0.0);
        assert_eq!(result.params.center_y, 0.0);
        assert_eq!(result.params.rotation, proposed.rotation);
    }

    #[test]
    fn snap_split_mask_position_leaves_params_unchanged_outside_threshold() {
        let proposed = SplitMaskParams {
            center_x: 1.0,
            center_y: 1.0,
            ..split_params()
        };
        let result = snap_split_mask_interaction(SnapSplitMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.center_x, proposed.center_x);
        assert_eq!(result.params.center_y, proposed.center_y);
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn snap_split_mask_rotation_snaps_to_the_nearest_right_angle() {
        let proposed = SplitMaskParams {
            rotation: 178.0,
            ..split_params()
        };
        let result = snap_split_mask_interaction(SnapSplitMaskInteractionOptions {
            handle_id: MaskHandleId::Rotation,
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.rotation, 180.0);
    }

    #[test]
    fn snap_split_mask_interaction_is_a_pass_through_for_size_handles() {
        let proposed = SplitMaskParams {
            rotation: 45.0,
            ..split_params()
        };
        let result = snap_split_mask_interaction(SnapSplitMaskInteractionOptions {
            handle_id: MaskHandleId::Feather,
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.rotation, proposed.rotation);
        assert!(result.active_lines.is_empty());

        let segment_result = snap_split_mask_interaction(SnapSplitMaskInteractionOptions {
            handle_id: MaskHandleId::Segment { index: 3 },
            proposed_params: proposed.clone(),
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(segment_result.params, proposed);
    }

    #[test]
    fn snap_box_mask_threshold_boundary_includes_the_edge() {
        // A 3-unit offset on x is inside the 8-unit threshold; 8 units is on
        // the boundary and snaps; 8.0001 does not.
        let snap_at = |dx: f64| {
            snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
                handle_id: MaskHandleId::Position,
                start_params: rectangle_params(),
                proposed_params: RectangleMaskParams {
                    center_x: dx / bounds().width,
                    ..rectangle_params()
                },
                bounds: bounds(),
                canvas_size: canvas_size(),
                snap_threshold: threshold(),
            })
        };
        assert_eq!(snap_at(3.0).params.center_x, 0.0);
        assert_eq!(snap_at(8.0).params.center_x, 0.0);
        assert!(snap_at(8.0001).params.center_x > 0.0);
    }

    #[test]
    fn snap_box_mask_uniform_scale_with_no_candidate_in_range_keeps_proposed_scale() {
        // Element is centred in an 800x600 canvas; canvas edges in
        // element-centred coords are +/-400 (x) and +/-300 (y). The mask is
        // 0.5*400=200 wide and 0.5*300=150 tall. Scale 1.1 puts every AABB
        // edge well inside the frame with no candidate within 8 units.
        let proposed = RectangleMaskParams {
            scale: 1.1,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Scale,
            start_params: rectangle_params(),
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        assert_eq!(result.params.scale, 1.1);
        assert!(result.active_lines.is_empty());
    }

    #[test]
    fn snap_box_mask_picks_the_nearest_target_when_two_are_in_range() {
        // Position a mask so its centre sits 3 units from the canvas centre
        // and 4 units from the canvas left — both within the 8-unit
        // threshold. The nearest target wins.
        let proposed = RectangleMaskParams {
            center_x: 0.0075,
            ..rectangle_params()
        };
        let result = snap_box_mask_interaction(SnapBoxMaskInteractionOptions {
            handle_id: MaskHandleId::Position,
            start_params: rectangle_params(),
            proposed_params: proposed,
            bounds: bounds(),
            canvas_size: canvas_size(),
            snap_threshold: threshold(),
        });
        // 3 units from the centre beats 397 from the left.
        assert_eq!(result.params.center_x, 0.0);
    }
}
