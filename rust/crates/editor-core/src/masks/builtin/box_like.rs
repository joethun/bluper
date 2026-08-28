//! Pure-math bits of `apps/web/src/masks/builtin/box-like.ts` and the helper in
//! `apps/web/src/masks/param-update.ts`.
//!
//! Every closed-over `MaskDefinition` in `box-like.ts` stays in TypeScript: only
//! the literal-returning, coordinate-arithmetic, and dispatch functions live
//! here. Nothing here reads or writes the DOM, the canvas, or any timeline
//! element — the inputs are plain numbers and the outputs are plain numbers
//! (or, for the dispatcher, a `Partial<RectangleMaskParams>` so callers spread
//! it onto the live params without cloning the rest of the tree).
//!
//! The TS uses `Math.round` for the feather projection; Rust's `f64::round`
//! disagrees on half-ties (away-from-zero vs toward-positive-infinity), so
//! this module calls `crate::math::js_round` instead. See [`crate::math`] for
//! why the sign of the zero matters.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::masks::handle_positions::{
    MaskHandleCornerX, MaskHandleCornerY, MaskHandleId, MaskHandleSide,
};
use crate::masks::snap::{BaseMaskParams, ElementBounds, RectangleMaskParams};
use crate::math::js_round;

/// Fraction of the element's short side that a freshly-drawn shape mask fills.
#[export]
pub const DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO: f64 = 0.6;

/// Normalised dimension the editor will not let a mask fall below. The mask is
/// considered degenerate past this, so `get_box_like_geometry` and the edge
/// resize handles clamp to it.
#[export]
pub const MIN_MASK_DIMENSION: f64 = 0.01;

/// Canvas units the feather handle moves per unit of feather, same constant
/// the handle position module uses for the handle's screen offset.
#[export]
pub const FEATHER_HANDLE_SCALE: f64 = 0.11;

/// Hard ceiling on the feather value, applied after `js_round`.
#[export]
pub const MAX_FEATHER: f64 = 1000.0;

/// Element-size probe passed to `buildDefault` for a mask. Mirrors the
/// `elementSize?` field of `MaskDefaultContext` in `apps/web/src/masks/types.ts`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BoxMaskDefaultElementSize {
    pub width: f64,
    pub height: f64,
}

/// Args to [`get_default_square_mask_params`]. `element_size` is optional to
/// match the TS, where an absent `elementSize` falls through to the
/// `DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO` for both axes.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetDefaultSquareMaskParamsOptions {
    #[serde(default)]
    pub element_size: Option<BoxMaskDefaultElementSize>,
}

/// The defaults every box-like mask builds on top of. Mirrors
/// `getDefaultBaseMaskParams` in `box-like.ts`. Type-only: the `#[export]`
/// return is the bridge; this is kept here so the function isn't forced to
/// borrow against the global.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseMaskParamsDefaults {
    pub feather: f64,
    pub inverted: bool,
    pub stroke_color: String,
    pub stroke_width: f64,
    pub stroke_align: String,
}

fn default_base_mask_params() -> BaseMaskParamsDefaults {
    BaseMaskParamsDefaults {
        feather: 0.0,
        inverted: false,
        stroke_color: "#ffffff".to_string(),
        stroke_width: 0.0,
        stroke_align: "center".to_string(),
    }
}

/// The shared defaults every box-like mask starts from. Mirrors
/// `getDefaultBaseMaskParams` in `apps/web/src/masks/builtin/box-like.ts`.
#[export]
pub fn get_default_base_mask_params() -> BaseMaskParamsDefaults {
    default_base_mask_params()
}

/// Stroke-align probe. Mirrors `getStrokeOffset` in
/// `apps/web/src/masks/builtin/box-like.ts`. "inside" pushes the stroke half
/// inward (`-strokeWidth / 2`), "outside" pushes it half outward
/// (`+strokeWidth / 2`), and "center" (or anything else) leaves it on the
/// path at zero.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
pub struct GetStrokeOffsetOptions {
    pub stroke_align: String,
    pub stroke_width: f64,
}

#[export]
pub fn get_stroke_offset(
    GetStrokeOffsetOptions {
        stroke_align,
        stroke_width,
    }: GetStrokeOffsetOptions,
) -> f64 {
    match stroke_align.as_str() {
        "inside" => -(stroke_width / 2.0),
        "outside" => stroke_width / 2.0,
        _ => 0.0,
    }
}

/// The full default param shape a square shape mask starts with. Mirrors
/// `getDefaultSquareMaskParams` in `apps/web/src/masks/builtin/box-like.ts`.
#[export]
pub fn get_default_square_mask_params(
    GetDefaultSquareMaskParamsOptions { element_size }: GetDefaultSquareMaskParamsOptions,
) -> RectangleMaskParams {
    let element_size = element_size.unwrap_or(BoxMaskDefaultElementSize {
        width: 0.0,
        height: 0.0,
    });

    let abs_width = element_size.width.abs();
    let abs_height = element_size.height.abs();
    let short_side = abs_width.min(abs_height);
    let square_side = if short_side > 0.0 {
        short_side * DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO
    } else {
        0.0
    };
    let width = if abs_width > 0.0 {
        square_side / abs_width
    } else {
        DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO
    };
    let height = if abs_height > 0.0 {
        square_side / abs_height
    } else {
        DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO
    };

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
        width,
        height,
        rotation: 0.0,
        scale: 1.0,
    }
}

/// The mask's placement in canvas units: where the centre sits, how wide and
/// tall the inscribed box is (clamped so it never collapses), and the rotation
/// converted to radians. Mirrors `getBoxLikeGeometry` in
/// `apps/web/src/masks/builtin/box-like.ts`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetBoxLikeGeometryOptions {
    pub params: RectangleMaskParams,
    pub width: f64,
    pub height: f64,
}

/// Canvas-space geometry derived from the mask's normalised params. Width and
/// height are clamped to `MIN_MASK_DIMENSION` so a degenerate input still
/// yields a drawable box.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoxLikeCanvasGeometry {
    pub center_x: f64,
    pub center_y: f64,
    pub mask_width: f64,
    pub mask_height: f64,
    pub rotation_rad: f64,
}

#[export]
pub fn get_box_like_geometry(
    GetBoxLikeGeometryOptions {
        params,
        width,
        height,
    }: GetBoxLikeGeometryOptions,
) -> BoxLikeCanvasGeometry {
    BoxLikeCanvasGeometry {
        center_x: width / 2.0 + params.center_x * width,
        center_y: height / 2.0 + params.center_y * height,
        mask_width: params.width.max(MIN_MASK_DIMENSION) * width,
        mask_height: params.height.max(MIN_MASK_DIMENSION) * height,
        rotation_rad: (params.rotation * std::f64::consts::PI) / 180.0,
    }
}

/// Internal helper: the feather update formula from
/// `apps/web/src/masks/param-update.ts`. Called by
/// [`compute_box_mask_param_update`] for the `feather` handle case, and
/// re-used by the split/freeform/text mask dispatchers via the bridge.
fn compute_feather_update_inner(
    start_feather: f64,
    delta_x: f64,
    delta_y: f64,
    direction_x: f64,
    direction_y: f64,
) -> f64 {
    let projection = delta_x * direction_x + delta_y * direction_y;
    let updated = js_round(start_feather + projection / FEATHER_HANDLE_SCALE);
    updated.max(0.0).min(MAX_FEATHER)
}

/// Args to the feather helper, kept public so the same shape can come back
/// across the bridge when the split or freeform mask ports want it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeFeatherUpdateOptions {
    pub start_feather: f64,
    pub delta_x: f64,
    pub delta_y: f64,
    pub direction_x: f64,
    pub direction_y: f64,
}

/// Public feather helper. Mirrors `computeFeatherUpdate` in
/// `apps/web/src/masks/param-update.ts` and is shaped so the other mask
/// dispatchers can call it through the same bridge.
#[export]
pub fn compute_feather_update(
    ComputeFeatherUpdateOptions {
        start_feather,
        delta_x,
        delta_y,
        direction_x,
        direction_y,
    }: ComputeFeatherUpdateOptions,
) -> f64 {
    compute_feather_update_inner(start_feather, delta_x, delta_y, direction_x, direction_y)
}

/// A `Partial<RectangleMaskParams>` returned from the box-mask drag
/// dispatcher. Every field is `None` when the corresponding handle does not
/// set it; the JS caller spreads the result, so absent fields stay at their
/// previous values.
///
/// The `BaseMaskParams` carries `feather`, `inverted`, and the stroke fields
/// — none of the resize handles touch `inverted` or the stroke fields, and the
/// `feather` case is the only base-layer writer — so the partial flattens
/// `feather` onto the top level rather than wrapping it in a `base` object.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BoxMaskParamUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
}

/// Args to [`compute_box_mask_param_update`]. Mirrors the relevant subset of
/// `MaskParamUpdateArgs<RectangleMaskParams>` from
/// `apps/web/src/masks/types.ts`: the dispatcher does not read
/// `startCanvasX` / `startCanvasY` / `canvasSize`, so those are left off the
/// bridge surface to avoid having the caller round-trip data that nothing
/// here will look at.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeBoxMaskParamUpdateOptions {
    pub handle_id: MaskHandleId,
    pub start_params: RectangleMaskParams,
    pub delta_x: f64,
    pub delta_y: f64,
    pub bounds: ElementBounds,
}

/// Update a box-mask's params from a pointer delta, given which handle is
/// being dragged. Mirrors `computeBoxMaskParamUpdate` in
/// `apps/web/src/masks/builtin/box-like.ts`. The dispatcher branches the
/// same way the TS does — `position`, `rotation`, `feather`, `edge`, then
/// `corner`, then `scale`, with the rotated feather direction sourced from
/// the start rotation.
///
/// Handle kinds the box mask does not own (`anchor`, `segment`) fall through
/// to the default branch and produce an empty update, identical to the TS's
/// `return {}`.
#[export]
pub fn compute_box_mask_param_update(
    ComputeBoxMaskParamUpdateOptions {
        handle_id,
        start_params,
        delta_x,
        delta_y,
        bounds,
    }: ComputeBoxMaskParamUpdateOptions,
) -> BoxMaskParamUpdate {
    match &handle_id {
        MaskHandleId::Position => {
            let center_x = start_params.center_x + delta_x / bounds.width;
            let center_y = start_params.center_y + delta_y / bounds.height;
            BoxMaskParamUpdate {
                center_x: Some(center_x),
                center_y: Some(center_y),
                ..Default::default()
            }
        }
MaskHandleId::Rotation => {
            // `Math.atan2(dy, dx) * 180 / PI` is the TS unchanged. The
            // bounds here carry the element's centre; the angle is computed
            // from the raw delta on the assumption the pointer is in the
            // mask's own frame, which is what the snap module calls
            // `MaskHandleId::Rotation` for.
            let current_angle = (delta_y.atan2(delta_x) * 180.0) / std::f64::consts::PI;
            let raw = start_params.rotation + current_angle;
            // The TS writes `(raw) % 360` (sign of the dividend), then
            // adds 360 only when the result is strictly negative. That
            // mirror does *not* match `rem_euclid`: `(-360) % 360` in JS
            // is `-0`, and the `newRotation < 0 ? + 360 : newRotation`
            // check sees `-0` as not strictly less than zero and so
            // returns `-0` unchanged. `rem_euclid` would have folded that
            // to `+0`, which `equalsExact` (`Object.is`) treats as drift.
            // Lift the TS path verbatim to keep the sign bit intact.
            let modulo = raw % 360.0;
            let rotation = if modulo < 0.0 { modulo + 360.0 } else { modulo };
            BoxMaskParamUpdate {
                rotation: Some(rotation),
                ..Default::default()
            }
        }
        MaskHandleId::Feather => {
            // The feather direction is the mask's local up vector: rotate
            // `(0, 1)` by the start rotation, which lands on
            // `(-sin, cos)`. The TS writes it as such directly.
            let angle_rad = (start_params.rotation * std::f64::consts::PI) / 180.0;
            let feather =
                compute_feather_update_inner(start_params.base.feather, delta_x, delta_y, -angle_rad.sin(), angle_rad.cos());
            BoxMaskParamUpdate {
                feather: Some(feather),
                ..Default::default()
            }
        }
        MaskHandleId::Edge {
            side: side @ (MaskHandleSide::Right | MaskHandleSide::Left),
        } => {
            let sign = if matches!(side, MaskHandleSide::Right) { 1.0 } else { -1.0 };
            let width = MIN_MASK_DIMENSION.max(start_params.width + (sign * delta_x * 2.0) / bounds.width);
            BoxMaskParamUpdate {
                width: Some(width),
                ..Default::default()
            }
        }
        MaskHandleId::Edge {
            side: side @ (MaskHandleSide::Top | MaskHandleSide::Bottom),
        } => {
            let sign = if matches!(side, MaskHandleSide::Bottom) { 1.0 } else { -1.0 };
            let height =
                MIN_MASK_DIMENSION.max(start_params.height + (sign * delta_y * 2.0) / bounds.height);
            BoxMaskParamUpdate {
                height: Some(height),
                ..Default::default()
            }
        }
        MaskHandleId::Corner { corner } => {
            let sign_x = if corner.x == MaskHandleCornerX::Right { 1.0 } else { -1.0 };
            let sign_y = if corner.y == MaskHandleCornerY::Bottom { 1.0 } else { -1.0 };
            let half_width = start_params.width * bounds.width;
            let half_height = start_params.height * bounds.height;
            let distance =
                ((sign_x * delta_x + half_width).powi(2) + (sign_y * delta_y + half_height).powi(2)).sqrt();
            let original_distance = (half_width.powi(2) + half_height.powi(2)).sqrt();
            let scale = if original_distance > 0.0 {
                distance / original_distance
            } else {
                1.0
            };
            BoxMaskParamUpdate {
                width: Some(MIN_MASK_DIMENSION.max(start_params.width * scale)),
                height: Some(MIN_MASK_DIMENSION.max(start_params.height * scale)),
                ..Default::default()
            }
        }
        MaskHandleId::Scale => {
            let half_width = start_params.width * bounds.width;
            let half_height = start_params.height * bounds.height;
            let distance = (delta_x.powi(2) + delta_y.powi(2)).sqrt();
            let original_distance = (half_width.powi(2) + half_height.powi(2)).sqrt();
            let scale = if original_distance > 0.0 {
                1.0 + distance / original_distance
            } else {
                1.0
            };
            BoxMaskParamUpdate {
                scale: Some(MIN_MASK_DIMENSION.max(start_params.scale * scale)),
                ..Default::default()
            }
        }
        // Freeform handles (`anchor` / `segment`) don't touch box-mask
        // params; pass through with no update, matching the TS's fallback
        // `return {}`.
        MaskHandleId::PathAnchor { .. } | MaskHandleId::Segment { .. } => BoxMaskParamUpdate::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::masks::handle_positions::{
        MaskHandleCorner, MaskHandleCornerX as X, MaskHandleCornerY as Y, MaskHandleSide as Side,
    };

    const PI: f64 = std::f64::consts::PI;

    fn rect_params() -> RectangleMaskParams {
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

    fn bounds() -> ElementBounds {
        ElementBounds {
            cx: 100.0,
            cy: 200.0,
            width: 400.0,
            height: 300.0,
            rotation: 0.0,
        }
    }

    fn assert_close(actual: f64, expected: f64, context: &str) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "{context}: expected {expected}, got {actual}"
        );
    }

    #[test]
    fn constants_match_the_typescript_values() {
        // Pinned so the JS and Rust never silently disagree — a drifted
        // `MIN_MASK_DIMENSION` would let one side's clamp accept what the
        // other's refuses.
        assert_eq!(DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO, 0.6);
        assert_eq!(MIN_MASK_DIMENSION, 0.01);
        assert_eq!(FEATHER_HANDLE_SCALE, 0.11);
        assert_eq!(MAX_FEATHER, 1000.0);
    }

    #[test]
    fn get_default_base_mask_params_returns_the_canonical_defaults() {
        let defaults = get_default_base_mask_params();
        assert_eq!(defaults.feather, 0.0);
        assert!(!defaults.inverted);
        assert_eq!(defaults.stroke_color, "#ffffff");
        assert_eq!(defaults.stroke_width, 0.0);
        assert_eq!(defaults.stroke_align, "center");
    }

    #[test]
    fn get_stroke_offset_handles_inside_outside_and_center() {
        assert_eq!(
            get_stroke_offset(GetStrokeOffsetOptions {
                stroke_align: "inside".to_string(),
                stroke_width: 10.0,
            }),
            -5.0
        );
        assert_eq!(
            get_stroke_offset(GetStrokeOffsetOptions {
                stroke_align: "outside".to_string(),
                stroke_width: 10.0,
            }),
            5.0
        );
        assert_eq!(
            get_stroke_offset(GetStrokeOffsetOptions {
                stroke_align: "center".to_string(),
                stroke_width: 10.0,
            }),
            0.0
        );
        // Any unrecognised align falls through to centre.
        assert_eq!(
            get_stroke_offset(GetStrokeOffsetOptions {
                stroke_align: "weird".to_string(),
                stroke_width: 10.0,
            }),
            0.0
        );
    }

    #[test]
    fn get_default_square_mask_params_uses_the_short_side_ratio() {
        // 400x300 element → short side 300 → square side 300 * 0.6 = 180.
        // width = 180 / 400 = 0.45, height = 180 / 300 = 0.6.
        let params = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: 400.0,
                height: 300.0,
            }),
        });
        assert_close(params.width, 0.45, "width");
        assert_close(params.height, 0.6, "height");
        assert_eq!(params.center_x, 0.0);
        assert_eq!(params.center_y, 0.0);
        assert_eq!(params.rotation, 0.0);
        assert_eq!(params.scale, 1.0);
        // The base defaults come along too, identical to
        // `getDefaultBaseMaskParams`.
        assert_eq!(params.base.feather, 0.0);
        assert!(!params.base.inverted);
        assert_eq!(params.base.stroke_color, "#ffffff");
        assert_eq!(params.base.stroke_width, 0.0);
        assert_eq!(params.base.stroke_align, "center");
    }

    #[test]
    fn get_default_square_mask_params_handles_a_square_element() {
        // short side == 300 == 300, square side = 180.
        // width = 180 / 300 = 0.6, height = 180 / 300 = 0.6.
        let params = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: 300.0,
                height: 300.0,
            }),
        });
        assert_close(params.width, 0.6, "width");
        assert_close(params.height, 0.6, "height");
    }

    #[test]
    fn get_default_square_mask_params_uses_the_ratio_when_either_axis_is_zero() {
        // Zero width axis: `abs_width > 0` is false, so width falls through
        // to the ratio. `abs_height > 0` is true, so height uses the
        // square-side formula — but `square_side` is 0 (the short side is
        // 0), so height also collapses to 0.
        let degenerate_w = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: 0.0,
                height: 400.0,
            }),
        });
        assert_eq!(degenerate_w.width, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);
        assert_eq!(degenerate_w.height, 0.0);

        // Zero height axis: symmetric — height falls through to the ratio,
        // width collapses.
        let degenerate_h = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: 400.0,
                height: 0.0,
            }),
        });
        assert_eq!(degenerate_h.width, 0.0);
        assert_eq!(degenerate_h.height, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);

        // Both axes zero: every branch hits its short-circuit to the ratio.
        let degenerate_both = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: 0.0,
                height: 0.0,
            }),
        });
        assert_eq!(degenerate_both.width, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);
        assert_eq!(degenerate_both.height, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);

        // Abs is taken, so negatives follow the same path.
        let negative = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: Some(BoxMaskDefaultElementSize {
                width: -400.0,
                height: -300.0,
            }),
        });
        assert_close(negative.width, 0.45, "width");
        assert_close(negative.height, 0.6, "height");
    }

    #[test]
    fn get_default_square_mask_params_treats_a_missing_element_size_as_zero() {
        let params = get_default_square_mask_params(GetDefaultSquareMaskParamsOptions {
            element_size: None,
        });
        assert_eq!(params.width, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);
        assert_eq!(params.height, DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO);
    }

    #[test]
    fn get_box_like_geometry_uses_the_element_size_for_canvas_units() {
        // params at the centre: 0.5 of 400x200 → centred at (200, 100), size
        // (200, 100). 90° rotation → pi/2 radians.
        let params = RectangleMaskParams {
            rotation: 90.0,
            ..rect_params()
        };
        let geometry = get_box_like_geometry(GetBoxLikeGeometryOptions {
            params,
            width: 400.0,
            height: 200.0,
        });
        assert_close(geometry.center_x, 200.0, "center_x");
        assert_close(geometry.center_y, 100.0, "center_y");
        assert_close(geometry.mask_width, 200.0, "mask_width");
        assert_close(geometry.mask_height, 100.0, "mask_height");
        assert_close(geometry.rotation_rad, PI / 2.0, "rotation_rad");
    }

    #[test]
    fn get_box_like_geometry_clamps_a_tiny_width_to_the_minimum() {
        let params = RectangleMaskParams {
            width: 0.0,
            height: 0.5,
            ..rect_params()
        };
        let geometry = get_box_like_geometry(GetBoxLikeGeometryOptions {
            params,
            width: 400.0,
            height: 300.0,
        });
        // width 0.0 < MIN_MASK_DIMENSION → clamped to MIN_MASK_DIMENSION.
        assert_close(geometry.mask_width, MIN_MASK_DIMENSION * 400.0, "mask_width");
        // height 0.5 passes the clamp untouched.
        assert_close(geometry.mask_height, 0.5 * 300.0, "mask_height");
    }

    #[test]
    fn get_box_like_geometry_clamps_both_axes_when_both_are_tiny() {
        let params = RectangleMaskParams {
            width: 0.001,
            height: 0.001,
            ..rect_params()
        };
        let geometry = get_box_like_geometry(GetBoxLikeGeometryOptions {
            params,
            width: 400.0,
            height: 300.0,
        });
        assert_close(geometry.mask_width, MIN_MASK_DIMENSION * 400.0, "mask_width");
        assert_close(geometry.mask_height, MIN_MASK_DIMENSION * 300.0, "mask_height");
    }

    #[test]
    fn get_box_like_geometry_offsets_the_centre_by_the_normalised_position() {
        // centreX 0.1 * 400 = 40 → canvas centre 200 + 40 = 240.
        let params = RectangleMaskParams {
            center_x: 0.1,
            center_y: -0.2,
            ..rect_params()
        };
        let geometry = get_box_like_geometry(GetBoxLikeGeometryOptions {
            params,
            width: 400.0,
            height: 300.0,
        });
        assert_close(geometry.center_x, 240.0, "center_x");
        assert_close(geometry.center_y, 150.0 + -0.2 * 300.0, "center_y");
    }

    #[test]
    fn compute_feather_update_round_trips_a_zero_delta_into_a_zero_feather() {
        let updated = compute_feather_update_inner(0.0, 0.0, 0.0, 1.0, 0.0);
        assert_eq!(updated, 0.0);
    }

    #[test]
    fn compute_feather_update_projects_onto_the_direction() {
        // direction (1, 0), delta (10, 0) → projection 10; 10 / 0.11 ≈ 90.9.
        let updated = compute_feather_update_inner(0.0, 10.0, 0.0, 1.0, 0.0);
        assert_close(updated, (10.0_f64 / FEATHER_HANDLE_SCALE).round(), "projection");
    }

    #[test]
    fn compute_feather_update_rounds_through_js_round() {
        // 5.5 / 0.11 is exactly 50.0 in IEEE-754, so js_round breaks the
        // tie and answers 50. The TS uses Math.round here, which is the
        // same direction.
        let updated = compute_feather_update_inner(0.0, 5.5, 0.0, 1.0, 0.0);
        assert_eq!(updated, 50.0);
    }

    #[test]
    fn compute_feather_update_js_round_differs_from_f64_round_on_negative_ties() {
        // -5.5 / 0.11 is exactly -50.0 in IEEE-754, so js_round (which
        // breaks ties toward +∞) answers -50, matching `Math.round(-50)`.
        // f64::round would also be -50 here — the divergence only matters
        // on the *tie* value (e.g. -0.5 → -0 in js_round, -1 in f64::round),
        // and the only path that lands there in this dispatcher is the
        // sign-of-zero check on `Math.round` itself, which the
        // math::js_round helper handles.
        let negative = compute_feather_update_inner(0.0, -5.5, 0.0, 1.0, 0.0);
        // -50 is below the floor; the dispatcher's clamp drops it to 0.
        // The interesting check is that we don't go to +1 (which would
        // require breaking the tie *away* from zero on a negative value).
        assert_eq!(negative, 0.0);
    }

    #[test]
    fn compute_feather_update_caps_at_max_feather() {
        // delta large enough to project past 1000 — must clamp at the cap.
        let updated = compute_feather_update_inner(900.0, 200.0, 0.0, 1.0, 0.0);
        assert_eq!(updated, MAX_FEATHER);
    }

    #[test]
    fn compute_feather_update_floors_at_zero() {
        let updated = compute_feather_update_inner(100.0, -200.0, 0.0, 1.0, 0.0);
        assert_eq!(updated, 0.0);
    }

    #[test]
    fn position_handle_adds_a_normalised_delta() {
        // delta of 80 across bounds.width 400 → 0.2.
        let mut start = rect_params();
        start.center_x = 0.1;
        start.center_y = -0.25;
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Position,
            start_params: start,
            delta_x: 80.0,
            delta_y: -90.0,
            bounds: bounds(),
        });
        assert_close(update.center_x.unwrap(), 0.3, "center_x");
        assert_close(update.center_y.unwrap(), -0.55, "center_y");
        // No other field should be touched.
        assert!(update.feather.is_none());
        assert!(update.width.is_none());
        assert!(update.height.is_none());
        assert!(update.rotation.is_none());
        assert!(update.scale.is_none());
    }

    #[test]
    fn position_handle_with_zero_bounds_size_propagates_nan_like_the_typescript() {
        // The TS divides by zero — `0 / 0` is `NaN` in JS too — and the
        // editor guards against it upstream, so the dispatcher mirrors the
        // TS literally rather than paper over the divide. The test pins
        // what `f64` actually produces so a future "helpfully guard the
        // divide" change has to call it out in code review.
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Position,
            start_params: rect_params(),
            // 5 / 0 = +inf, added to 0 = +inf.
            delta_x: 5.0,
            // 0 / 0 = NaN, added to 0 = NaN.
            delta_y: 0.0,
            bounds: ElementBounds {
                width: 0.0,
                height: 0.0,
                ..bounds()
            },
        });
        assert_eq!(update.center_x, Some(f64::INFINITY));
        assert!(update.center_y.unwrap().is_nan());
    }

    #[test]
    fn rotation_handle_wraps_into_zero_three_sixty() {
        // Negative-wrapping case: start 350, current angle 80 → raw 430.
        // The TS does (430) % 360 = 70 (since JS's % keeps the sign of the
        // dividend, 430 % 360 = 70 anyway, but 350 + (-80) = 270 also
        // works). The Rust side uses `rem_euclid`, which always lands in
        // `[0, 360)`. Both come out equivalent for non-negative raw values.
        let start = RectangleMaskParams {
            rotation: 350.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Rotation,
            start_params: start,
            // deltaX=1, deltaY=0 → atan2(0, 1) = 0 → current angle 0.
            delta_x: 1.0,
            delta_y: 0.0,
            bounds: bounds(),
        });
        assert_close(update.rotation.unwrap(), 350.0, "rotation");
    }

    #[test]
    fn rotation_handle_wraps_a_negative_total_back_into_range() {
        // start 10, current angle -80 (delta_y negative, delta_x positive but
        // small) → raw -70. The TS path: (10 + (-80)) % 360 = -70, then
        // negative branch adds 360 → 290. The Rust `rem_euclid` lands at
        // 290 directly. Both end up at the same value, which is the part
        // that matters.
        let start = RectangleMaskParams {
            rotation: 10.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Rotation,
            start_params: start,
            // atan2(-0.174, 0.985) * 180 / PI = -10° approx; pick a delta
            // that lands exactly at -80°.
            delta_x: (80.0_f64).to_radians().cos(),
            delta_y: -(80.0_f64).to_radians().sin(),
            bounds: bounds(),
        });
        // current_angle = atan2(dy, dx) * 180 / PI = -80; start + angle =
        // -70 → 290.
        let rotation = update.rotation.unwrap();
        assert!(
            (rotation - 290.0).abs() < 1e-9,
            "expected ~290, got {rotation}"
        );
    }

    #[test]
    fn feather_handle_projects_onto_the_local_up_vector_at_zero_rotation() {
        // At rotation 0, direction is (-sin 0, cos 0) = (0, 1); the
        // "into the mask" direction is +y. A positive delta_y therefore
        // grows the feather.
        let start = rect_params();
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Feather,
            start_params: start,
            delta_x: 0.0,
            delta_y: 5.5,
            bounds: bounds(),
        });
        // 5.5 / 0.11 = 50 → js_round → 50.
        assert_eq!(update.feather, Some(50.0));
    }

    #[test]
    fn feather_handle_projects_onto_the_local_up_vector_at_ninety_degrees() {
        // At rotation 90, direction is (-sin π/2, cos π/2) = (-1, 0); the
        // "into the mask" direction is -x. A negative delta_x grows the
        // feather.
        let start = RectangleMaskParams {
            rotation: 90.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Feather,
            start_params: start,
            delta_x: -5.5,
            delta_y: 0.0,
            bounds: bounds(),
        });
        assert_eq!(update.feather, Some(50.0));
    }

    #[test]
    fn edge_right_handle_grows_width_by_two_deltas_and_clamps() {
        let start = RectangleMaskParams {
            width: 0.3,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Edge { side: Side::Right },
            start_params: start,
            delta_x: 40.0,
            delta_y: 0.0,
            bounds: bounds(),
        });
        // sign +1; new width = max(MIN, 0.3 + 2 * 40 / 400) = max(0.01, 0.5) = 0.5.
        assert_close(update.width.unwrap(), 0.5, "width");
        assert!(update.height.is_none());
    }

    #[test]
    fn edge_left_handle_shrinks_width_and_clamps_at_min() {
        // Negative direction shrinks width. The clamp at MIN_MASK_DIMENSION
        // must keep the result non-negative even when the delta would push
        // it past the lower bound.
        let start = RectangleMaskParams {
            width: 0.05,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Edge { side: Side::Left },
            start_params: start,
            delta_x: 100.0,
            delta_y: 0.0,
            bounds: bounds(),
        });
        // sign -1; new = 0.05 + (-1 * 100 * 2 / 400) = 0.05 - 0.5 = -0.45
        // → clamped to MIN_MASK_DIMENSION (0.01).
        assert_eq!(update.width, Some(MIN_MASK_DIMENSION));
    }

    #[test]
    fn edge_top_and_bottom_handle_height() {
        let start = RectangleMaskParams {
            height: 0.3,
            ..rect_params()
        };
        let bottom = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Edge { side: Side::Bottom },
            start_params: start.clone(),
            delta_x: 0.0,
            delta_y: 60.0,
            bounds: bounds(),
        });
        // sign +1; new = max(0.01, 0.3 + 2 * 60 / 300) = max(0.01, 0.7) = 0.7.
        assert_close(bottom.height.unwrap(), 0.7, "height");

        let start_low = RectangleMaskParams {
            height: 0.05,
            ..rect_params()
        };
        let top = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Edge { side: Side::Top },
            start_params: start_low,
            delta_x: 0.0,
            delta_y: 100.0,
            bounds: bounds(),
        });
        // sign -1; new = max(0.01, 0.05 - 2 * 100 / 300) = max(0.01, -0.6166..) = 0.01.
        assert_eq!(top.height, Some(MIN_MASK_DIMENSION));
    }

    #[test]
    fn corner_handle_scales_both_dimensions_uniformly() {
        // half_w = 0.5 * 400 = 200; half_h = 0.5 * 300 = 150.
        // originalDistance = sqrt(200² + 150²) = 250.
        // Pull the bottom-right handle: sign_x +1, sign_y +1.
        // Pulling delta (40, 60) → new half (240, 210); newDistance =
        // sqrt(240² + 210²) ≈ 318.0. Scale ≈ 318.0 / 250 ≈ 1.272.
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Corner {
                corner: MaskHandleCorner { x: X::Right, y: Y::Bottom },
            },
            start_params: rect_params(),
            delta_x: 40.0,
            delta_y: 60.0,
            bounds: bounds(),
        });
        let new_w = update.width.unwrap();
        let new_h = update.height.unwrap();
        // The closed form: scale = sqrt((240)² + (210)²) / sqrt((200)² + (150)²)
        // = sqrt(57600 + 44100) / 250 = sqrt(101700) / 250.
        let expected = (101700.0_f64).sqrt() / 250.0;
        assert_close(new_w, 0.5 * expected, "width");
        assert_close(new_h, 0.5 * expected, "height");
    }

    #[test]
    fn corner_handle_keeps_dimensions_equal_when_the_delta_is_uniform() {
        // Pull by the same amount on each axis; the scale must come out the
        // same for width and height because the start is square.
        let start = RectangleMaskParams {
            width: 1.0,
            height: 1.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Corner {
                corner: MaskHandleCorner { x: X::Right, y: Y::Bottom },
            },
            start_params: start,
            delta_x: 10.0,
            delta_y: 10.0,
            bounds: ElementBounds {
                width: 200.0,
                height: 200.0,
                ..bounds()
            },
        });
        assert_close(update.width.unwrap(), update.height.unwrap(), "uniform");
    }

    #[test]
    fn corner_handle_with_zero_start_dimensions_falls_back_to_unit_scale() {
        let start = RectangleMaskParams {
            width: 0.0,
            height: 0.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Corner {
                corner: MaskHandleCorner { x: X::Right, y: Y::Bottom },
            },
            start_params: start,
            delta_x: 100.0,
            delta_y: 100.0,
            bounds: bounds(),
        });
        // originalDistance 0 → scale = 1.0; new width = 0.0 * 1 = 0.0 →
        // clamped to MIN_MASK_DIMENSION.
        assert_eq!(update.width, Some(MIN_MASK_DIMENSION));
        assert_eq!(update.height, Some(MIN_MASK_DIMENSION));
    }

    #[test]
    fn scale_handle_grows_scale_by_one_plus_the_distance_ratio() {
        // half_w = 0.5 * 400 = 200; half_h = 0.5 * 300 = 150.
        // originalDistance = 250. Pull by (40, 60) → distance = sqrt(40² +
        // 60²) = sqrt(5200) ≈ 72.11. Scale = 1 + sqrt(5200)/250 ≈ 1.288.
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Scale,
            start_params: rect_params(),
            delta_x: 40.0,
            delta_y: 60.0,
            bounds: bounds(),
        });
        let expected = 1.0 + 5200.0_f64.sqrt() / 250.0;
        assert_close(update.scale.unwrap(), expected, "scale");
        assert!(update.width.is_none());
        assert!(update.height.is_none());
    }

    #[test]
    fn scale_handle_with_zero_start_dimensions_keeps_scale_unchanged() {
        let start = RectangleMaskParams {
            width: 0.0,
            height: 0.0,
            scale: 0.7,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Scale,
            start_params: start,
            delta_x: 100.0,
            delta_y: 100.0,
            bounds: bounds(),
        });
        // originalDistance 0 → scale = 1.0 → new scale = 0.7 * 1.0 = 0.7.
        assert_close(update.scale.unwrap(), 0.7, "scale");
    }

    #[test]
    fn scale_handle_clamps_at_min_when_the_drag_would_shrink_it() {
        // Distance > 0 → scale > 1, but if start.scale is 0 the clamp pulls
        // it back. Bounds pulled so originalDistance is positive so the
        // branch doesn't fall back to scale = 1.
        let start = RectangleMaskParams {
            width: 0.1,
            height: 0.1,
            scale: 0.0,
            ..rect_params()
        };
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Scale,
            start_params: start,
            delta_x: -1000.0,
            delta_y: -1000.0,
            bounds: bounds(),
        });
        // delta would give a negative distance ratio, so scale = 1 - |delta|/originalDistance
        // < 0; clamp at MIN_MASK_DIMENSION.
        assert_eq!(update.scale, Some(MIN_MASK_DIMENSION));
    }

    #[test]
    fn freeform_handle_kinds_produce_an_empty_update() {
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::PathAnchor { point_id: "a".to_string() },
            start_params: rect_params(),
            delta_x: 999.0,
            delta_y: 999.0,
            bounds: bounds(),
        });
        assert_eq!(update, BoxMaskParamUpdate::default());

        let segment = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::Segment { index: 3 },
            start_params: rect_params(),
            delta_x: 999.0,
            delta_y: 999.0,
            bounds: bounds(),
        });
        assert_eq!(segment, BoxMaskParamUpdate::default());
    }

    #[test]
    fn empty_update_serialises_with_no_undefined_fields() {
        // The orchestrator relies on the partial omitting `None`s so the JS
        // can spread it without tripping over `undefined`. Verify the JSON
        // shape directly via serde_json — this is the same path `tsify`
        // walks under the feature flag.
        let update = compute_box_mask_param_update(ComputeBoxMaskParamUpdateOptions {
            handle_id: MaskHandleId::PathAnchor { point_id: "a".to_string() },
            start_params: rect_params(),
            delta_x: 0.0,
            delta_y: 0.0,
            bounds: bounds(),
        });
        let value = serde_json::to_value(&update).unwrap();
        let object = value.as_object().expect("an object");
        assert!(
            object.is_empty(),
            "expected an empty partial, got {object:?}"
        );
    }

    #[test]
    fn a_single_field_partial_only_serialises_that_field() {
        let update = BoxMaskParamUpdate {
            width: Some(0.42),
            ..Default::default()
        };
        let value = serde_json::to_value(&update).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 1);
        assert_eq!(object.get("width"), Some(&serde_json::json!(0.42)));
    }
}
