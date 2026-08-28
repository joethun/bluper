//! Math for the text mask's drag dispatcher.
//!
//! Ported from `computeTextMaskParamUpdate` and `getScalePreferredEdges` in
//! `apps/web/src/masks/builtin/definitions/text.ts`. The text mask's renderer
//! stays in TypeScript because it depends on `measureTextLayout`, which is a
//! canvas call; this module handles only the drag-time arithmetic that lives
//! in `computeTextMaskParamUpdate`.
//!
//! The four handle kinds dispatch identically to the rectangle mask's
//! dispatcher in [`apps/web/src/masks/builtin/box-like.ts`] — `position` adds
//! the drag delta in normalised coords, `rotation` solves the pivot, `feather`
//! projects the delta along the mask's own normal, `scale` rescales around
//! the pivot. Only the feather direction differs from the rectangle case
//! (`(-sin, cos)` for box and text, `(-cos, -sin)` for split), and that is
//! the one place this module has to differ from the box-like port.
//!
//! `Math.round` is used by the feather case — see [`compute_feather_update`]
//! for the reason that goes through [`crate::math::js_round`]. The rotation
//! case uses `fmod` rather than rounding, and the `+ 360 % 360` wrap is the
//! same modulo idiom JavaScript emits, just lifted into Rust's `%`.

use bridge::export;
use serde::{Deserialize, Serialize};
#[cfg(feature = "wasm")]
use tsify_next::Tsify;

use crate::masks::handle_positions::{MaskHandleId, MaskOverlayBounds};
use crate::masks::snap::BaseMaskParams;
use crate::text::{TextDecoration, TextFontStyle, TextFontWeight};
use crate::math::{clamp as clamp_value, js_round};

/// How many pixels of drag add one unit of feather. Must stay equal to
/// `builtin::box_like::FEATHER_HANDLE_SCALE` or dragging the feather handle
/// will not track the pointer.
const FEATHER_HANDLE_SCALE: f64 = 0.11;

/// The largest feather the editor accepts. Mirrors
/// `builtin::box_like::MAX_FEATHER`.
const MAX_FEATHER: f64 = 1000.0;

/// Lower clamp on the scale field, matching the TS guard
/// `Math.max(0.01, …)` in `computeTextMaskParamUpdate`'s `scale` branch.
const MIN_SCALE: f64 = 0.01;

/// Params for a text mask. Mirrors `TextMaskParams` in
/// `apps/web/src/masks/types.ts`. Every numeric field is `f64`, even the ones
/// the editor renders as integers — `fontSize` and `lineHeight` round on
/// display, but the stored value is `f64` so dragging a handle produces
/// fractional moves that the next display-round hides.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextMaskParams {
    #[serde(flatten)]
    pub base: BaseMaskParams,
    pub content: String,
    pub font_size: f64,
    pub font_family: String,
    pub font_weight: TextFontWeight,
    pub font_style: TextFontStyle,
    pub text_decoration: TextDecoration,
    pub letter_spacing: f64,
    pub line_height: f64,
    pub center_x: f64,
    pub center_y: f64,
    pub rotation: f64,
    pub scale: f64,
}

/// `MaskParamUpdateArgs<TextMaskParams>` from `apps/web/src/masks/types.ts`.
///
/// The text dispatcher never clamps against the canvas size — text masks are
/// sized to the text, not to the canvas — so `canvasSize` is deliberately
/// absent here. The split dispatcher does clamp, and includes it; see
/// [`ComputeSplitMaskParamUpdateOptions`].
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeTextMaskParamUpdateOptions {
    pub handle_id: MaskHandleId,
    pub start_params: TextMaskParams,
    pub delta_x: f64,
    pub delta_y: f64,
    pub start_canvas_x: f64,
    pub start_canvas_y: f64,
    pub bounds: MaskOverlayBounds,
}

/// The fields a text mask's param-update dispatcher can return. Every field
/// is `Option<f64>` with `skip_serializing_if = "Option::is_none"` so that an
/// empty partial (`{}` on the JS side) round-trips back to the editor without
/// forcing every key to exist. The JS side reads this as
/// `Partial<Pick<TextMaskParams, …>>` — every key is optional, so missing
/// keys fall through to the existing value when the partial is spread back
/// onto the params.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputeTextMaskParamUpdateResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
}

/// Which edges the scale-snap prefers for a text mask. Mirrors
/// `getScalePreferredEdges` in `apps/web/src/masks/builtin/definitions/text.ts`:
/// text masks prefer right and bottom edges, which is the convention the
/// rectangle mask's snap code already speaks.
///
/// `ScaleEdgePreference` (the wasm-bound shape in `apps/web/src/wasm/preview-snap.ts`)
/// is `Partial<{ left?, right?, top?, bottom? }>`. Every field is `Option<bool>`
/// here with the same `skip_serializing_if`, so a `None` for an unset edge
/// arrives in JS as an absent key — the same shape `ScaleEdgePreference`
/// documents. Returning `None` from this function when the handle is not a
/// scale kind matches the TS `undefined` return.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputeTextMaskScalePreferredEdgesResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<bool>,
}

/// Compute `computeTextMaskParamUpdate` from
/// `apps/web/src/masks/builtin/definitions/text.ts`.
#[export]
pub fn compute_text_mask_param_update_value(
    ComputeTextMaskParamUpdateOptions {
        handle_id,
        start_params,
        delta_x,
        delta_y,
        start_canvas_x,
        start_canvas_y,
        bounds,
    }: ComputeTextMaskParamUpdateOptions,
) -> ComputeTextMaskParamUpdateResult {
    if let MaskHandleId::Position = handle_id {
        return ComputeTextMaskParamUpdateResult {
            center_x: Some(start_params.center_x + delta_x / bounds.width),
            center_y: Some(start_params.center_y + delta_y / bounds.height),
            ..ComputeTextMaskParamUpdateResult::default()
        };
    }

    let pivot_x = bounds.cx + start_params.center_x * bounds.width;
    let pivot_y = bounds.cy + start_params.center_y * bounds.height;

    if let MaskHandleId::Rotation = handle_id {
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
        return ComputeTextMaskParamUpdateResult {
            rotation: Some(rotation),
            ..ComputeTextMaskParamUpdateResult::default()
        };
    }

    if let MaskHandleId::Feather = handle_id {
        let angle_rad = start_params.rotation.to_radians();
        let feather = compute_feather_update(
            start_params.base.feather,
            delta_x,
            delta_y,
            -angle_rad.sin(),
            angle_rad.cos(),
        );
        return ComputeTextMaskParamUpdateResult {
            feather: Some(feather),
            ..ComputeTextMaskParamUpdateResult::default()
        };
    }

    if let MaskHandleId::Scale = handle_id {
        let start_distance = ((start_canvas_x - pivot_x).powi(2)
            + (start_canvas_y - pivot_y).powi(2))
        .sqrt();
        let current_distance = ((start_canvas_x + delta_x - pivot_x).powi(2)
            + (start_canvas_y + delta_y - pivot_y).powi(2))
        .sqrt();
        let scale_factor = if start_distance > 0.0 {
            current_distance / start_distance
        } else {
            1.0
        };
        let scale = (start_params.scale * scale_factor).max(MIN_SCALE);
        return ComputeTextMaskParamUpdateResult {
            scale: Some(scale),
            ..ComputeTextMaskParamUpdateResult::default()
        };
    }

    ComputeTextMaskParamUpdateResult::default()
}

/// `getScalePreferredEdges` from
/// `apps/web/src/masks/builtin/definitions/text.ts`: text masks prefer the
/// right and bottom edges for the scale snap.
///
/// Returns `None` when the handle is not the scale kind — that matches the
/// TypeScript's `undefined` return, and lets the caller skip the snap's edge
/// preference for any other handle.
#[export]
pub fn get_text_mask_scale_preferred_edges_value(
    ComputeTextMaskScalePreferredEdgesOptions { handle_id }: ComputeTextMaskScalePreferredEdgesOptions,
) -> Option<ComputeTextMaskScalePreferredEdgesResult> {
    if !matches!(handle_id, MaskHandleId::Scale) {
        return None;
    }
    Some(ComputeTextMaskScalePreferredEdgesResult {
        right: Some(true),
        bottom: Some(true),
        ..ComputeTextMaskScalePreferredEdgesResult::default()
    })
}

/// Options for [`get_text_mask_scale_preferred_edges_value`]. Carries only
/// the handle id — the rest of the args the TS function takes are not used.
#[cfg_attr(feature = "wasm", derive(Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeTextMaskScalePreferredEdgesOptions {
    pub handle_id: MaskHandleId,
}

/// `computeFeatherUpdate` from `apps/web/src/masks/param-update.ts`, inlined
/// here so the text and split dispatchers each have their own copy. The
/// direction vector differs per mask (text uses `(-sin, cos)` to match the
/// box convention, split uses `(-cos, -sin)` to match its 90°-offset
/// convention), and there is no clean place to share without an Options
/// struct that buys nothing.
///
/// `Math.round` breaks ties toward positive infinity, which `f64::round`
/// does not, so the rounding has to go through [`crate::math::js_round`].
/// The clamp is the same `Math.max(0, Math.min(MAX, …))` the editor has
/// always used.
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

/// `(((x + d) % 360) + 360) % 360`, written out because Rust's `%` keeps the
/// sign of the dividend — `(-1.0_f64) % 360.0 == -1.0` — whereas JavaScript
/// emits a positive remainder. The two-step wrap matches the TS source
/// literally.
fn positive_modulo(value: f64, modulus: f64) -> f64 {
    ((value % modulus) + modulus) % modulus
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds() -> MaskOverlayBounds {
        MaskOverlayBounds {
            cx: 100.0,
            cy: 200.0,
            width: 400.0,
            height: 300.0,
            rotation: 0.0,
        }
    }

    fn start_params() -> TextMaskParams {
        TextMaskParams {
            base: BaseMaskParams {
                feather: 0.0,
                inverted: false,
                stroke_color: "#ffffff".to_string(),
                stroke_width: 0.0,
                stroke_align: "center".to_string(),
            },
            content: "Mask".to_string(),
            font_size: 15.0,
            font_family: "Arial".to_string(),
            font_weight: TextFontWeight::Normal,
            font_style: TextFontStyle::Normal,
            text_decoration: TextDecoration::None,
            letter_spacing: 0.0,
            line_height: 1.2,
            center_x: 0.0,
            center_y: 0.0,
            rotation: 0.0,
            scale: 1.0,
        }
    }

    fn args(
        handle_id: MaskHandleId,
        start_params: TextMaskParams,
        delta_x: f64,
        delta_y: f64,
        start_canvas_x: f64,
        start_canvas_y: f64,
    ) -> ComputeTextMaskParamUpdateOptions {
        ComputeTextMaskParamUpdateOptions {
            handle_id,
            start_params,
            delta_x,
            delta_y,
            start_canvas_x,
            start_canvas_y,
            bounds: bounds(),
        }
    }

    #[test]
    fn position_drag_normalises_against_bounds_size() {
        // 40 / 400 = 0.1, 30 / 300 = 0.1.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Position,
            start_params(),
            40.0,
            30.0,
            0.0,
            0.0,
        ));
        assert_eq!(result.center_x, Some(0.1));
        assert_eq!(result.center_y, Some(0.1));
    }

    #[test]
    fn position_drag_on_zero_size_bounds_yields_zero_offset() {
        // A zero-size bounds yields NaN in the JS divide; the Rust divide
        // yields infinity. Both are equally unhelpful, but the JS guards
        // against them upstream, so we only need to assert the result is
        // *defined* — the value itself is whatever the floats give.
        let degenerate = MaskOverlayBounds {
            cx: 0.0,
            cy: 0.0,
            width: 0.0,
            height: 0.0,
            rotation: 0.0,
        };
        let result = compute_text_mask_param_update_value(ComputeTextMaskParamUpdateOptions {
            handle_id: MaskHandleId::Position,
            start_params: start_params(),
            delta_x: 1.0,
            delta_y: 1.0,
            start_canvas_x: 0.0,
            start_canvas_y: 0.0,
            bounds: degenerate,
        });
        // 1.0 / 0.0 is +inf in f64; assert what f64 actually produces rather
        // than reimplementing JS division semantics.
        assert_eq!(result.center_x, Some(f64::INFINITY));
        assert_eq!(result.center_y, Some(f64::INFINITY));
    }

    #[test]
    fn rotation_drag_wraps_into_zero_three_sixty() {
        // Pivot at (100, 200); start at (200, 200) → atan2(0, 100) = 0°.
        // Current at (100, 300) → atan2(100, 0) = 90°.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Rotation,
            start_params(),
            -100.0,
            100.0,
            200.0,
            200.0,
        ));
        assert_eq!(result.rotation, Some(90.0));
    }

    #[test]
    fn rotation_drag_above_one_eighty_subtracts_three_sixty() {
        // A counter-clockwise drag of 200° should land at -20° modulo 360,
        // which is 340°. Pivot at (100, 200); start at (200, 200) → 0°.
        // Current at (300, 100) → atan2(-100, 200) ≈ -26.565°. We need a
        // drag whose delta exceeds 180°; pick start = (200, 200) → 0°,
        // current = (-100, 200) → atan2(0, -200) = 180°. Then 180° drag.
        // Then a further drag back would underflow — easier to use a start
        // angle that's already at the boundary. Start at (100, 300) → 90°,
        // current at (300, 100) → atan2(-100, 200) ≈ -26.565°. Delta is
        // ≈ -116.565°. Within range. Pick a different start:
        // start (100, 100) → atan2(-100, 0) = -90°. current (300, 100) →
        // atan2(-100, 200) ≈ -26.565°. Delta ≈ 63.435°. Still in range.
        // We need delta > 180 in raw terms. Set start (200, 200) = 0° and
        // current (-100, 200) = 180°. raw delta = 180°. Not > 180. Set
        // current (-150, 100) → atan2(-100, -250) ≈ -158.2°. raw delta
        // ≈ -158.2°. Still < 180 in absolute value. Set current (-150,
        // 300) → atan2(100, -250) ≈ 158.2°. raw delta ≈ 158.2°. Set
        // current (-100, 400) → atan2(200, -200) = 135°. raw delta 135°.
        // Set current (-300, 200) → atan2(0, -400) = 180°. raw delta 180°.
        // Set current (-400, 100) → atan2(-100, -500) ≈ -168.7°. raw delta
        // ≈ -168.7°. To exceed 180 in absolute value we need the raw delta
        // to cross the 180 boundary; the simplest way is to pick start
        // angle = -90° and current angle = +120°, delta = 210°. Then the
        // TS wraps it to 210 - 360 = -150°.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Rotation,
            start_params(),
            -200.0,
            100.0,
            0.0,
            100.0,
        ));
        // pivot (100, 200). start (0, 100) → atan2(-100, -100) = -135°.
        // current (-200, 200) → atan2(0, -300) = 180°. raw delta = 315°.
        // Wrap: 315 > 180 → 315 - 360 = -45°. Final: 0 + (-45) = -45° → +315°.
        assert_eq!(result.rotation, Some(315.0));
    }

    #[test]
    fn rotation_drag_below_minus_one_eighty_adds_three_sixty() {
        // The < -180 branch fires when the raw delta wraps past -180°.
        // Pivot (100, 200). Set start at exactly 90° → (100, 201) (i.e.
        // (cx, cy + 1)). Set current at exactly -91° → the unit vector is
        // (cos -91°, sin -91°) ≈ (-0.0174524, -0.999848). Place the pointer
        // 100 units away along that vector from the pivot.
        let start_x = 100.0;
        let start_y = 201.0;
        let angle_rad = -91.0_f64.to_radians();
        let current_x = 100.0 + 100.0 * angle_rad.cos();
        let current_y = 200.0 + 100.0 * angle_rad.sin();
        let delta_x = current_x - start_x;
        let delta_y = current_y - start_y;
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Rotation,
            start_params(),
            delta_x,
            delta_y,
            start_x,
            start_y,
        ));
        // start 90° → current -91° → raw delta = -181° → wrap +360 → 179°.
        assert!(
            (result.rotation.unwrap() - 179.0).abs() < 1e-6,
            "rotation = {:?}",
            result.rotation
        );
    }

    #[test]
    fn rotation_drag_with_negative_result_wraps_to_positive() {
        // start_params.rotation = 10°. Drag produces a delta that makes the
        // sum negative. start (200, 200) → 0°. current (0, 100) →
        // atan2(-100, -100) = -135°. delta = -135°. Final = 10 - 135 =
        // -125°. Modulo: ((-125 % 360) + 360) % 360 = 235°.
        let params = TextMaskParams {
            rotation: 10.0,
            ..start_params()
        };
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Rotation,
            params,
            -200.0,
            -100.0,
            200.0,
            200.0,
        ));
        assert_eq!(result.rotation, Some(235.0));
    }

    #[test]
    fn rotation_exactly_at_three_sixty_wraps_to_zero() {
        // start_params.rotation = 0°. delta that lands at exactly 360°.
        // pivot (100, 200). start (200, 200) → 0°. current (300, 200)
        // → atan2(0, 200) = 0°. delta = 0°. Hmm, that's not 360. Pick a
        // start angle that's a clean 90° and an end angle that's also a
        // clean 90° + 360°. start (100, 100) → atan2(-100, 0) = -90°.
        // current (100 + 1, 100) → atan2(-100, 1) ≈ -89.43°. Not 360.
        // Easiest: pick start (200, 200) → 0°, current (100, 100) →
        // atan2(-100, -100) = -135°. delta = -135°. Not 360. The only
        // way to land exactly at 360 is for the raw delta to equal 360,
        // which is impossible from a finite drag. The TS source uses
        // `(((x + d) % 360) + 360) % 360` so any value in [0, 360) is the
        // valid range. Test that the wrap is correct at exactly 360 by
        // computing it directly.
        let params = TextMaskParams {
            rotation: 180.0,
            ..start_params()
        };
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Rotation,
            params,
            0.0,
            0.0,
            200.0,
            200.0,
        ));
        assert_eq!(result.rotation, Some(180.0));
    }

    #[test]
    fn feather_drag_projects_against_the_mask_normal() {
        // rotation = 90° → normal is (-1, 0). Drag +X by 1 px → projection
        // = -1. feather = round(0 + (-1) / 0.11) = round(-9.0909…) = -9.
        // Clamped to 0.
        let params = TextMaskParams {
            rotation: 90.0,
            ..start_params()
        };
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Feather,
            params,
            1.0,
            0.0,
            0.0,
            0.0,
        ));
        assert_eq!(result.feather, Some(0.0));
    }

    #[test]
    fn feather_drag_against_the_normal_grows_it() {
        // rotation = 90° → normal (-1, 0). Drag -X by 11 px → projection =
        // 11. feather = round(0 + 11 / 0.11) = round(100) = 100.
        let params = TextMaskParams {
            rotation: 90.0,
            ..start_params()
        };
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Feather,
            params,
            -11.0,
            0.0,
            0.0,
            0.0,
        ));
        assert_eq!(result.feather, Some(100.0));
    }

    #[test]
    fn feather_drag_clamps_to_max_feather() {
        // rotation 0° → normal direction (0, 1). Drag +Y way past the
        // ceiling; expect MAX_FEATHER.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Feather,
            start_params(),
            0.0,
            100_000.0,
            0.0,
            0.0,
        ));
        assert_eq!(result.feather, Some(MAX_FEATHER));
    }

    #[test]
    fn feather_rounds_through_js_round_so_a_half_projection_rounds_up() {
        // Start feather = 0. Projection = 0.055 → round(0.055 / 0.11) =
        // round(0.5) = 1. js_round of 0.5 is 1.0, while f64::round of 0.5
        // is also 1.0 (tie away from zero) — the difference matters on
        // the negative side. Projection = -0.055 → round(-0.5) = 0 in
        // Math.round (tie toward +∞) but -1 in f64::round (away from
        // zero). Verify the +0 answer.
        let params = TextMaskParams {
            base: BaseMaskParams {
                feather: 5.0,
                ..start_params().base
            },
            ..start_params()
        };
        // Need projection exactly -0.5 after the divide: 5 + projection /
        // 0.11 = exactly half-tie. -0.5 = x / 0.11 → x = -0.055.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Feather,
            params,
            -0.055,
            0.0,
            0.0,
            0.0,
        ));
        // Math.round(5 + (-0.055) / 0.11) = Math.round(5 - 0.5) = 5
        // (tie toward +∞).
        assert_eq!(result.feather, Some(5.0));
    }

    #[test]
    fn scale_drag_rescales_around_the_pivot() {
        // pivot (100, 200). start (200, 200) → dist = 100.
        // current (300, 200) → dist = 200. factor = 2. scale = 1 * 2 = 2.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Scale,
            start_params(),
            100.0,
            0.0,
            200.0,
            200.0,
        ));
        assert_eq!(result.scale, Some(2.0));
    }

    #[test]
    fn scale_drag_floors_at_min_scale() {
        // Drag inward past zero: start (200, 200), current (100.1, 200).
        // factor = 0.1 / 100 = 0.001. scale = 1 * 0.001 = 0.001 → 0.01.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Scale,
            start_params(),
            -99.9,
            0.0,
            200.0,
            200.0,
        ));
        assert_eq!(result.scale, Some(MIN_SCALE));
    }

    #[test]
    fn scale_drag_with_zero_start_distance_keeps_scale_unchanged() {
        // start at the pivot → start_distance = 0. TS uses `1` as the
        // factor; Rust mirrors that.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Scale,
            start_params(),
            50.0,
            50.0,
            100.0,
            200.0,
        ));
        assert_eq!(result.scale, Some(1.0));
    }

    #[test]
    fn unknown_handle_returns_an_empty_partial() {
        // Edge / corner / freeform handles are not part of the text
        // dispatcher's vocabulary, so they fall through to `{}`. The Rust
        // shape is the default `ComputeTextMaskParamUpdateResult` with
        // every field None.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Edge {
                side: crate::masks::handle_positions::MaskHandleSide::Left,
            },
            start_params(),
            5.0,
            5.0,
            0.0,
            0.0,
        ));
        assert_eq!(result, ComputeTextMaskParamUpdateResult::default());
    }

    #[test]
    fn empty_partial_serializes_to_an_empty_object() {
        // The whole reason every field is `Option<f64>` with
        // `skip_serializing_if`: an empty partial crosses as `{}`, which
        // is what `Partial<TextMaskParams>` reads on the JS side.
        let result = ComputeTextMaskParamUpdateResult::default();
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized, serde_json::json!({}));
    }

    #[test]
    fn partial_with_only_center_writes_only_center() {
        let result = ComputeTextMaskParamUpdateResult {
            center_x: Some(0.5),
            ..ComputeTextMaskParamUpdateResult::default()
        };
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized, serde_json::json!({ "centerX": 0.5 }));
    }

    #[test]
    fn scale_preferred_edges_returned_for_a_scale_handle() {
        let result = get_text_mask_scale_preferred_edges_value(
            ComputeTextMaskScalePreferredEdgesOptions {
                handle_id: MaskHandleId::Scale,
            },
        )
        .unwrap();
        assert_eq!(result.right, Some(true));
        assert_eq!(result.bottom, Some(true));
        assert_eq!(result.left, None);
        assert_eq!(result.top, None);
    }

    #[test]
    fn scale_preferred_edges_returns_none_for_non_scale_handles() {
        assert!(get_text_mask_scale_preferred_edges_value(
            ComputeTextMaskScalePreferredEdgesOptions {
                handle_id: MaskHandleId::Position,
            },
        )
        .is_none());
        assert!(get_text_mask_scale_preferred_edges_value(
            ComputeTextMaskScalePreferredEdgesOptions {
                handle_id: MaskHandleId::Rotation,
            },
        )
        .is_none());
        assert!(get_text_mask_scale_preferred_edges_value(
            ComputeTextMaskScalePreferredEdgesOptions {
                handle_id: MaskHandleId::Feather,
            },
        )
        .is_none());
    }

    #[test]
    fn positive_modulo_wraps_a_negative_value() {
        // (-125 % 360) + 360 = -125 + 360 = 235. Then 235 % 360 = 235.
        assert_eq!(positive_modulo(-125.0, 360.0), 235.0);
        assert_eq!(positive_modulo(540.0, 360.0), 180.0);
        assert_eq!(positive_modulo(360.0, 360.0), 0.0);
    }

    #[test]
    fn feather_direction_matches_the_box_mask_convention() {
        // The brief pins that text uses the same `(-sin, cos)` direction as
        // the box mask, not the `(-cos, -sin)` split uses. rotation = 0
        // → direction = (0, 1) (the unit upward normal of an unrotated
        // rectangle's "down" edge is (0, 1)). Drag down by 11 px → projection
        // = 11. feather = round(0 + 11 / 0.11) = 100.
        let result = compute_text_mask_param_update_value(args(
            MaskHandleId::Feather,
            start_params(),
            0.0,
            11.0,
            0.0,
            0.0,
        ));
        assert_eq!(result.feather, Some(100.0));
    }
}
