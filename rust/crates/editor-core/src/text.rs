//! Text elements.
//!
//! Only the parts that are arithmetic over numbers and enums live here.
//! Anything that needs a canvas to answer — glyph measurement above all —
//! stays on the TypeScript side, where the context is.

mod layout;

pub use layout::{
    DEFAULT_TEXT_LETTER_SPACING, DEFAULT_TEXT_LINE_HEIGHT, FONT_SIZE_SCALE_REFERENCE,
    MAX_FONT_SIZE, MIN_FONT_SIZE, TEXT_CORNER_RADIUS_MAX, TEXT_CORNER_RADIUS_MIN, TextAlign,
    TextBackgroundRadiusOptions, TextDecoration, TextFontStyle, TextFontWeight, TextLayoutOptions,
    TextLayoutParams, TextResolvedBackground, TextResolvedLayout, resolve_text_layout,
    resolve_text_layout_value, text_background_corner_radius, text_background_corner_radius_value,
};
