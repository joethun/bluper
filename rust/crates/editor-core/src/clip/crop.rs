//! How much of a clip's source it throws away.
//!
//! Insets rather than a rect, because that is what the four controls in the panel
//! are, and because it keeps the value meaningful when the same crop is copied
//! onto a clip of a different size.

use serde::{Deserialize, Serialize};

use crate::math::{clamp, js_round};
use crate::model::{ParamValue, ParamValues};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CropInsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const NO_CROP: CropInsets = CropInsets {
    left: 0.0,
    top: 0.0,
    right: 0.0,
    bottom: 0.0,
};

pub const CROP_PARAM_KEYS: &[&str] = &["crop.left", "crop.right", "crop.top", "crop.bottom"];

/// The least of an axis a crop may leave behind. A clip cropped to nothing has no
/// pixels to composite and no box to grab in the preview, so the pair of insets
/// on an axis is scaled back to leave this much rather than being allowed to
/// meet.
const MIN_CROP_SPAN: f64 = 0.02;

/// Which source edge a crop inset trims.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CropEdge {
    Left,
    Right,
    Top,
    Bottom,
}

impl CropEdge {
    fn opposite(self) -> Self {
        match self {
            Self::Left => Self::Right,
            Self::Right => Self::Left,
            Self::Top => Self::Bottom,
            Self::Bottom => Self::Top,
        }
    }

    fn read(self, crop: &CropInsets) -> f64 {
        match self {
            Self::Left => crop.left,
            Self::Right => crop.right,
            Self::Top => crop.top,
            Self::Bottom => crop.bottom,
        }
    }

    fn write(self, crop: &mut CropInsets, value: f64) {
        match self {
            Self::Left => crop.left = value,
            Self::Right => crop.right = value,
            Self::Top => crop.top = value,
            Self::Bottom => crop.bottom = value,
        }
    }
}

/// Moves one edge to `value`, holding the opposite edge still and stopping before
/// the two would leave less than `MIN_CROP_SPAN` between them. Dragging past the
/// far edge pins rather than inverting, which is what a crop handle should do.
pub fn set_crop_edge(crop: &CropInsets, edge: CropEdge, value: f64) -> CropInsets {
    let limit = 1.0 - MIN_CROP_SPAN - edge.opposite().read(crop);
    let mut next = *crop;
    edge.write(&mut next, clamp(value, 0.0, limit.max(0.0)));
    next
}

fn read_inset(params: &ParamValues, key: &str) -> f64 {
    match params.get(key) {
        Some(ParamValue::Number(value)) if value.is_finite() => clamp(*value, 0.0, 1.0),
        _ => 0.0,
    }
}

pub fn read_crop_from_params(params: &ParamValues) -> CropInsets {
    CropInsets {
        left: read_inset(params, "crop.left"),
        right: read_inset(params, "crop.right"),
        top: read_inset(params, "crop.top"),
        bottom: read_inset(params, "crop.bottom"),
    }
}

fn is_crop_active(crop: &CropInsets) -> bool {
    crop.left > 0.0 || crop.right > 0.0 || crop.top > 0.0 || crop.bottom > 0.0
}

/// Pulls a pair of opposing insets back until they leave `MIN_CROP_SPAN` between
/// them, keeping their ratio so the kept region stays where the user put it.
fn normalize_axis(start: f64, end: f64) -> (f64, f64) {
    let clamped_start = clamp(start, 0.0, 1.0);
    let clamped_end = clamp(end, 0.0, 1.0);
    let total = clamped_start + clamped_end;
    let max_total = 1.0 - MIN_CROP_SPAN;

    if total <= max_total || total == 0.0 {
        return (clamped_start, clamped_end);
    }

    let scale = max_total / total;
    (clamped_start * scale, clamped_end * scale)
}

fn normalize_crop(crop: &CropInsets) -> CropInsets {
    let (left, right) = normalize_axis(crop.left, crop.right);
    let (top, bottom) = normalize_axis(crop.top, crop.bottom);
    CropInsets {
        left,
        right,
        top,
        bottom,
    }
}

/// The region of the source the clip keeps, in source pixels. `None` when nothing
/// is cropped, which is the signal for every caller to stay on its uncropped fast
/// path rather than blitting a full-size copy for no reason.
pub fn resolve_crop_rect(
    crop: Option<&CropInsets>,
    width: f64,
    height: f64,
) -> Option<CropRect> {
    let crop = crop.filter(|crop| is_crop_active(crop))?;
    if width <= 0.0 || height <= 0.0 {
        return None;
    }

    let normalized = normalize_crop(crop);
    // Rounded to whole pixels: a fractional source rect resamples the frame on
    // every draw, which softens a picture the user only asked to trim.
    let x = js_round(normalized.left * width);
    let y = js_round(normalized.top * height);
    let right = js_round((1.0 - normalized.right) * width);
    let bottom = js_round((1.0 - normalized.bottom) * height);

    Some(CropRect {
        x,
        y,
        width: (right - x).max(1.0),
        height: (bottom - y).max(1.0),
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CropPlacement {
    pub kept_fraction_x: f64,
    pub kept_fraction_y: f64,
    pub center_fraction_x: f64,
    pub center_fraction_y: f64,
}

/// Where the kept region sits inside the layer's box, as fractions of it.
///
/// Cropping never changes how big the clip is drawn: the box is still fitted from
/// the whole frame, and the crop takes a sub-rectangle of it. `keptFraction` is
/// how much of each axis survives; `centerFraction` is how far the kept region's
/// middle sits from the box's middle, signed towards positive x/y. Fitting the
/// cropped region to the canvas instead would zoom the shot on every edge drag,
/// which reads as the picture stretching.
///
/// Taken from the rounded rect the texture was actually cut to, so the quad and
/// its pixels agree to the pixel rather than to the param.
pub fn get_crop_placement(
    crop_rect: Option<&CropRect>,
    width: f64,
    height: f64,
) -> CropPlacement {
    let Some(rect) = crop_rect.filter(|_| width > 0.0 && height > 0.0) else {
        return CropPlacement {
            kept_fraction_x: 1.0,
            kept_fraction_y: 1.0,
            center_fraction_x: 0.0,
            center_fraction_y: 0.0,
        };
    };

    CropPlacement {
        kept_fraction_x: rect.width / width,
        kept_fraction_y: rect.height / height,
        center_fraction_x: (rect.x + rect.width / 2.0) / width - 0.5,
        center_fraction_y: (rect.y + rect.height / 2.0) / height - 0.5,
    }
}

/// A texture cache key. The empty string means "not cropped", so an uncropped
/// clip shares one entry however its params are written.
pub fn hash_crop(crop: Option<&CropInsets>) -> String {
    let Some(crop) = crop.filter(|crop| is_crop_active(crop)) else {
        return String::new();
    };
    let normalized = normalize_crop(crop);
    format!(
        "{}:{}:{}:{}",
        normalized.left, normalized.top, normalized.right, normalized.bottom
    )
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetCropEdgeOptions {
    pub crop: CropInsets,
    pub edge: CropEdge,
    pub value: f64,
}

#[bridge::export]
pub fn set_crop_edge_value(
    SetCropEdgeOptions { crop, edge, value }: SetCropEdgeOptions,
) -> CropInsets {
    set_crop_edge(&crop, edge, value)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadCropOptions {
    pub params: ParamValues,
}

#[bridge::export]
pub fn read_crop_from_params_value(ReadCropOptions { params }: ReadCropOptions) -> CropInsets {
    read_crop_from_params(&params)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveCropOptions {
    #[serde(default)]
    pub crop: Option<CropInsets>,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeCropRect {
    pub rect: Option<CropRect>,
}

#[bridge::export]
pub fn resolve_crop_rect_value(
    ResolveCropOptions {
        crop,
        width,
        height,
    }: ResolveCropOptions,
) -> MaybeCropRect {
    MaybeCropRect {
        rect: resolve_crop_rect(crop.as_ref(), width, height),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CropPlacementOptions {
    #[serde(default)]
    pub crop_rect: Option<CropRect>,
    pub width: f64,
    pub height: f64,
}

#[bridge::export]
pub fn get_crop_placement_value(
    CropPlacementOptions {
        crop_rect,
        width,
        height,
    }: CropPlacementOptions,
) -> CropPlacement {
    get_crop_placement(crop_rect.as_ref(), width, height)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HashCropOptions {
    #[serde(default)]
    pub crop: Option<CropInsets>,
}

#[bridge::export]
pub fn hash_crop_value(HashCropOptions { crop }: HashCropOptions) -> String {
    hash_crop(crop.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insets(left: f64, top: f64, right: f64, bottom: f64) -> CropInsets {
        CropInsets {
            left,
            top,
            right,
            bottom,
        }
    }

    #[test]
    fn nothing_cropped_answers_no_rect() {
        assert_eq!(resolve_crop_rect(Some(&NO_CROP), 100.0, 100.0), None);
        assert_eq!(resolve_crop_rect(None, 100.0, 100.0), None);
        assert_eq!(hash_crop(Some(&NO_CROP)), "");
    }

    #[test]
    fn a_zero_sized_source_answers_no_rect() {
        let crop = insets(0.1, 0.1, 0.1, 0.1);
        assert_eq!(resolve_crop_rect(Some(&crop), 0.0, 100.0), None);
        assert_eq!(resolve_crop_rect(Some(&crop), 100.0, 0.0), None);
    }

    #[test]
    fn the_rect_lands_on_whole_pixels() {
        let crop = insets(0.1, 0.2, 0.1, 0.2);
        let rect = resolve_crop_rect(Some(&crop), 100.0, 100.0).expect("cropped");
        assert_eq!(
            rect,
            CropRect {
                x: 10.0,
                y: 20.0,
                width: 80.0,
                height: 60.0
            }
        );
    }

    #[test]
    fn an_edge_stops_before_it_would_cross_its_opposite() {
        let crop = insets(0.0, 0.0, 0.5, 0.0);
        // 1 - 0.02 - 0.5 leaves the left edge 0.48 of the axis.
        let next = set_crop_edge(&crop, CropEdge::Left, 0.9);
        assert!((next.left - 0.48).abs() < 1e-12);
        assert_eq!(next.right, 0.5);
    }

    #[test]
    fn an_edge_already_past_its_limit_pins_at_zero_rather_than_inverting() {
        let crop = insets(0.0, 0.0, 0.99, 0.0);
        assert_eq!(set_crop_edge(&crop, CropEdge::Left, 0.5).left, 0.0);
    }

    #[test]
    fn two_insets_that_would_meet_are_scaled_back_keeping_their_ratio() {
        // 0.6 + 0.6 leaves nothing; scaled to 0.98 total they keep 1:1.
        let crop = insets(0.6, 0.0, 0.6, 0.0);
        let rect = resolve_crop_rect(Some(&crop), 100.0, 100.0).expect("cropped");
        assert_eq!(rect.x, 49.0);
        assert_eq!(rect.width, 2.0);
    }

    #[test]
    fn a_kept_region_is_at_least_a_pixel_on_each_axis() {
        let crop = insets(0.499, 0.499, 0.499, 0.499);
        let rect = resolve_crop_rect(Some(&crop), 2.0, 2.0).expect("cropped");
        assert_eq!(rect.width, 1.0);
        assert_eq!(rect.height, 1.0);
    }

    #[test]
    fn params_that_are_not_finite_numbers_read_as_uncropped() {
        let mut params = ParamValues::new();
        params.insert("crop.left".to_string(), ParamValue::Number(f64::NAN));
        params.insert("crop.right".to_string(), ParamValue::Text("0.3".to_string()));
        params.insert("crop.top".to_string(), ParamValue::Number(0.25));
        assert_eq!(read_crop_from_params(&params), insets(0.0, 0.25, 0.0, 0.0));
    }

    #[test]
    fn a_param_beyond_the_axis_is_clamped_to_it() {
        let mut params = ParamValues::new();
        params.insert("crop.left".to_string(), ParamValue::Number(4.0));
        params.insert("crop.bottom".to_string(), ParamValue::Number(-1.0));
        assert_eq!(read_crop_from_params(&params), insets(1.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn the_placement_reads_off_the_rounded_rect() {
        let crop = insets(0.1, 0.2, 0.1, 0.2);
        let rect = resolve_crop_rect(Some(&crop), 100.0, 100.0);
        let placement = get_crop_placement(rect.as_ref(), 100.0, 100.0);
        assert_eq!(placement.kept_fraction_x, 0.8);
        assert_eq!(placement.kept_fraction_y, 0.6);
        assert_eq!(placement.center_fraction_x, 0.0);
        assert_eq!(placement.center_fraction_y, 0.0);
    }

    #[test]
    fn an_uncropped_clip_keeps_its_whole_box() {
        let placement = get_crop_placement(None, 100.0, 100.0);
        assert_eq!(placement.kept_fraction_x, 1.0);
        assert_eq!(placement.center_fraction_x, 0.0);
    }

    #[test]
    fn an_off_centre_crop_shifts_the_kept_region() {
        let crop = insets(0.5, 0.0, 0.0, 0.0);
        let rect = resolve_crop_rect(Some(&crop), 100.0, 100.0);
        let placement = get_crop_placement(rect.as_ref(), 100.0, 100.0);
        assert_eq!(placement.kept_fraction_x, 0.5);
        assert_eq!(placement.center_fraction_x, 0.25);
    }

    #[test]
    fn the_hash_is_taken_after_normalising_so_equivalent_crops_share_a_key() {
        let a = insets(0.6, 0.0, 0.6, 0.0);
        let b = insets(0.7, 0.0, 0.7, 0.0);
        // Both scale to the same 0.49/0.49 pair.
        assert_eq!(hash_crop(Some(&a)), hash_crop(Some(&b)));
        assert_eq!(hash_crop(Some(&a)), "0.49:0:0.49:0");
    }
}
