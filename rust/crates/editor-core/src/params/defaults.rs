//! The values a newly created element starts at.
//!
//! One place, because the same numbers appear twice otherwise: once as a param
//! definition's `default` and once in whatever builds a fresh element. When they
//! disagree, a clip is created carrying values the panel then reports as
//! non-default.

use serde::Serialize;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransformDefaults {
    pub position_x: f64,
    pub position_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rotate: f64,
}

pub const TRANSFORM: TransformDefaults = TransformDefaults {
    position_x: 0.0,
    position_y: 0.0,
    scale_x: 1.0,
    scale_y: 1.0,
    rotate: 0.0,
};

pub const OPACITY: f64 = 1.0;
pub const BLEND_MODE: &str = "normal";
/// Decibels, so leaving a clip alone is zero rather than one.
pub const VOLUME: f64 = 0.0;

pub const TEXT_LETTER_SPACING: f64 = 0.0;
pub const TEXT_LINE_HEIGHT: f64 = 1.2;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextBackgroundDefaults {
    pub enabled: bool,
    pub color: String,
    pub corner_radius: f64,
    pub padding_x: f64,
    pub padding_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

pub fn text_background() -> TextBackgroundDefaults {
    TextBackgroundDefaults {
        enabled: false,
        color: "#000000".to_string(),
        corner_radius: 0.0,
        padding_x: 30.0,
        padding_y: 42.0,
        offset_x: 0.0,
        offset_y: 0.0,
    }
}

/// The smallest scale a transform may hold. Zero would collapse the layer to
/// nothing, which cannot be grabbed again in the preview.
pub const MIN_TRANSFORM_SCALE: f64 = 0.01;

pub const VOLUME_DB_MIN: f64 = -60.0;
pub const VOLUME_DB_MAX: f64 = 20.0;

pub const CORNER_RADIUS_MIN: f64 = 0.0;
pub const CORNER_RADIUS_MAX: f64 = 100.0;

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElementDefaults {
    pub transform: TransformDefaults,
    pub opacity: f64,
    pub blend_mode: String,
    pub volume: f64,
    pub text_letter_spacing: f64,
    pub text_line_height: f64,
    pub text_background: TextBackgroundDefaults,
    pub min_transform_scale: f64,
    pub volume_db_min: f64,
    pub volume_db_max: f64,
    pub corner_radius_min: f64,
    pub corner_radius_max: f64,
}

/// One accessor rather than a constant each: `#[export]` on a `const` only emits
/// an f64 getter, and half of these are strings or structs.
#[bridge::export]
pub fn get_element_defaults() -> ElementDefaults {
    ElementDefaults {
        transform: TRANSFORM,
        opacity: OPACITY,
        blend_mode: BLEND_MODE.to_string(),
        volume: VOLUME,
        text_letter_spacing: TEXT_LETTER_SPACING,
        text_line_height: TEXT_LINE_HEIGHT,
        text_background: text_background(),
        min_transform_scale: MIN_TRANSFORM_SCALE,
        volume_db_min: VOLUME_DB_MIN,
        volume_db_max: VOLUME_DB_MAX,
        corner_radius_min: CORNER_RADIUS_MIN,
        corner_radius_max: CORNER_RADIUS_MAX,
    }
}
