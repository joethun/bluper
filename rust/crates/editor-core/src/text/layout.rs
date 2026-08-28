//! Resolving a text element's declared style into the numbers a renderer draws
//! with: a canvas-scaled font size, the CSS `font` shorthand, line height in
//! pixels, and the ratio background padding is expressed in.
//!
//! This is the half of `apps/web/src/text/primitives.ts` that is arithmetic
//! over numbers and enums. Measuring glyphs stays in TypeScript: it needs a
//! live `CanvasRenderingContext2D`, and a measurement callback is
//! behaviour-as-data, which is the same thing that blocks `ParamChannelLayout`
//! from crossing. Nothing here reaches for one.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::clamp;

/// Canvas height, in pixels, that a declared font size is authored against.
///
/// A text element stores one `fontSize` but is rendered into projects of any
/// resolution, so the size is scaled by `canvasHeight / this`. The reference is
/// deliberately small — a higher value makes every rendered font smaller, a
/// lower one makes it larger — and 90 is what the editor's own preview and the
/// export path have both been tuned against. Changing it silently reflows
/// every existing project.
pub const FONT_SIZE_SCALE_REFERENCE: f64 = 90.0;

/// Smallest font size the panel will accept. The mask definition keys its
/// minimum to this so the panel and the canvas reject the same inputs.
#[export]
pub const MIN_FONT_SIZE: f64 = 5.0;

/// Largest font size the panel will accept. Same contract as
/// [`MIN_FONT_SIZE`], on the upper end.
#[export]
pub const MAX_FONT_SIZE: f64 = 300.0;

/// Font size that corresponds to a `fontSizeRatio` of exactly `1`.
///
/// Background padding, decoration thickness and the like are authored as
/// numbers that look right at the default 15px caption, then multiplied by
/// this ratio so they keep their proportion when the user resizes the text.
/// Note it divides the *declared* size, not the canvas-scaled one — the ratio
/// tracks the author's intent, and the canvas scale is applied separately, so
/// applying both would square the scaling.
const FONT_SIZE_RATIO_REFERENCE: f64 = 15.0;

/// Corner radius is stored as a percentage of the background box's half-height.
/// Mirrors `CORNER_RADIUS_MIN`/`CORNER_RADIUS_MAX` in
/// `apps/web/src/text/background.ts`.
pub const TEXT_CORNER_RADIUS_MIN: f64 = 0.0;
/// Upper end of the corner-radius percentage: a fully rounded pill.
pub const TEXT_CORNER_RADIUS_MAX: f64 = 100.0;

/// `DEFAULTS.text.letterSpacing`.
pub const DEFAULT_TEXT_LETTER_SPACING: f64 = 0.0;
/// `DEFAULTS.text.lineHeight`, as a multiple of the scaled font size.
pub const DEFAULT_TEXT_LINE_HEIGHT: f64 = 1.2;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextFontWeight {
    Normal,
    Bold,
}

impl TextFontWeight {
    /// The CSS keyword, which is also what the `font` shorthand takes.
    fn as_css(self) -> &'static str {
        match self {
            TextFontWeight::Normal => "normal",
            TextFontWeight::Bold => "bold",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextFontStyle {
    Normal,
    Italic,
}

impl TextFontStyle {
    fn as_css(self) -> &'static str {
        match self {
            TextFontStyle::Normal => "normal",
            TextFontStyle::Italic => "italic",
        }
    }
}

/// Kebab-case on the wire, because these are the CSS keywords the property
/// panel writes: `"line-through"`, not `"lineThrough"`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TextDecoration {
    None,
    Underline,
    LineThrough,
}

/// A text element's declared style, as far as resolution needs it.
///
/// The TypeScript `TextLayoutParams` also carries `content`. It is left out
/// here on purpose: resolution never reads it, and including it would push a
/// whole caption — which can be arbitrarily long, and changes on every
/// keystroke — across the boundary for nothing. The caller splits lines on the
/// TypeScript side, where the string already lives.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextLayoutParams {
    pub font_size: f64,
    pub font_family: String,
    pub font_weight: TextFontWeight,
    pub font_style: TextFontStyle,
    pub text_align: TextAlign,
    #[serde(default)]
    pub text_decoration: Option<TextDecoration>,
    #[serde(default)]
    pub letter_spacing: Option<f64>,
    #[serde(default)]
    pub line_height: Option<f64>,
}

/// Everything a draw call needs that does not depend on the glyphs themselves.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextResolvedLayout {
    pub scaled_font_size: f64,
    pub font_string: String,
    pub letter_spacing: f64,
    pub line_height_px: f64,
    pub font_size_ratio: f64,
    pub text_align: TextAlign,
    pub text_decoration: TextDecoration,
}

/// A text background with every optional field already filled in — the shape
/// the drawing code receives, not the shape the project file stores.
///
/// Nothing here consumes it yet: only [`text_background_corner_radius`] has
/// moved, and it reads a single field, so making it take the whole struct would
/// push six unread values across the boundary. The type moves now because it is
/// the value type the rest of the drawing code will be handed when it follows.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextResolvedBackground {
    pub enabled: bool,
    pub color: String,
    pub padding_x: f64,
    pub padding_y: f64,
    pub offset_x: f64,
    pub offset_y: f64,
    pub corner_radius: f64,
}

/// A font family, quoted for the CSS `font` shorthand.
///
/// Always quoted rather than only when it contains a space: an unquoted family
/// name is a sequence of CSS identifiers, so anything starting with a digit or
/// containing punctuation would be a parse error and the whole shorthand would
/// be dropped. Embedded quotes are backslash-escaped for the same reason.
fn quote_font_family(font_family: &str) -> String {
    format!("\"{}\"", font_family.replace('"', "\\\""))
}

/// The CSS `font` shorthand. `sans-serif` trails as the fallback for a family
/// that failed to load — without it the canvas falls back to its own default,
/// which is a serif face on most platforms and looks like a bug.
fn build_text_font_string(
    font_family: &str,
    font_weight: TextFontWeight,
    font_style: TextFontStyle,
    scaled_font_size: f64,
) -> String {
    format!(
        "{} {} {}px {}, sans-serif",
        font_style.as_css(),
        font_weight.as_css(),
        js_number_to_string(scaled_font_size),
        quote_font_family(font_family)
    )
}

/// A resolved layout for `text` rendered into a canvas `canvas_height` pixels
/// tall.
pub fn resolve_text_layout(text: &TextLayoutParams, canvas_height: f64) -> TextResolvedLayout {
    let scaled_font_size = text.font_size * (canvas_height / FONT_SIZE_SCALE_REFERENCE);
    let letter_spacing = text.letter_spacing.unwrap_or(DEFAULT_TEXT_LETTER_SPACING);
    let line_height_px = scaled_font_size * text.line_height.unwrap_or(DEFAULT_TEXT_LINE_HEIGHT);

    TextResolvedLayout {
        scaled_font_size,
        font_string: build_text_font_string(
            &text.font_family,
            text.font_weight,
            text.font_style,
            scaled_font_size,
        ),
        letter_spacing,
        line_height_px,
        font_size_ratio: text.font_size / FONT_SIZE_RATIO_REFERENCE,
        text_align: text.text_align,
        text_decoration: text.text_decoration.unwrap_or(TextDecoration::None),
    }
}

/// The pixel radius for a background box `width` x `height` whose stored
/// `corner_radius` is a percentage.
///
/// The percentage is taken of *half the shorter side*, so 100 is the largest
/// radius the box can hold — a pill — and never overflows into a shape the
/// canvas would have to clamp itself. The clamp guards a project file that was
/// written by an older build or edited by hand.
pub fn text_background_corner_radius(corner_radius: f64, width: f64, height: f64) -> f64 {
    let percent = clamp(
        corner_radius,
        TEXT_CORNER_RADIUS_MIN,
        TEXT_CORNER_RADIUS_MAX,
    ) / 100.0;
    (width.min(height) / 2.0) * percent
}

// `js_number_to_string` lived here first, for the font shorthand; it moved to
// `crate::math` when a second module needed JavaScript's number formatting.
use crate::math::js_number_to_string;

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextLayoutOptions {
    pub text: TextLayoutParams,
    pub canvas_height: f64,
}

#[export]
pub fn resolve_text_layout_value(
    TextLayoutOptions {
        text,
        canvas_height,
    }: TextLayoutOptions,
) -> TextResolvedLayout {
    resolve_text_layout(&text, canvas_height)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextBackgroundRadiusOptions {
    pub corner_radius: f64,
    pub width: f64,
    pub height: f64,
}

#[export]
pub fn text_background_corner_radius_value(
    TextBackgroundRadiusOptions {
        corner_radius,
        width,
        height,
    }: TextBackgroundRadiusOptions,
) -> f64 {
    text_background_corner_radius(corner_radius, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> TextLayoutParams {
        TextLayoutParams {
            font_size: 15.0,
            font_family: "Inter".to_string(),
            font_weight: TextFontWeight::Normal,
            font_style: TextFontStyle::Normal,
            text_align: TextAlign::Left,
            text_decoration: None,
            letter_spacing: None,
            line_height: None,
        }
    }

    #[test]
    fn absent_optionals_fall_back_to_the_defaults() {
        let resolved = resolve_text_layout(&params(), FONT_SIZE_SCALE_REFERENCE);
        assert_eq!(resolved.letter_spacing, DEFAULT_TEXT_LETTER_SPACING);
        assert_eq!(resolved.line_height_px, 15.0 * DEFAULT_TEXT_LINE_HEIGHT);
        assert_eq!(resolved.text_decoration, TextDecoration::None);
    }

    #[test]
    fn present_optionals_win_over_the_defaults() {
        let text = TextLayoutParams {
            letter_spacing: Some(2.5),
            line_height: Some(2.0),
            text_decoration: Some(TextDecoration::Underline),
            ..params()
        };
        let resolved = resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE);
        assert_eq!(resolved.letter_spacing, 2.5);
        assert_eq!(resolved.line_height_px, 30.0);
        assert_eq!(resolved.text_decoration, TextDecoration::Underline);
    }

    #[test]
    fn a_zero_line_height_is_kept_rather_than_treated_as_absent() {
        // `?? ` in the TypeScript only replaces null/undefined, so an explicit
        // 0 collapses the lines on purpose.
        let text = TextLayoutParams {
            line_height: Some(0.0),
            letter_spacing: Some(0.0),
            ..params()
        };
        let resolved = resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE);
        assert_eq!(resolved.line_height_px, 0.0);
        assert_eq!(resolved.letter_spacing, 0.0);
    }

    #[test]
    fn font_size_scales_with_canvas_height_around_the_reference() {
        let text = TextLayoutParams {
            font_size: 30.0,
            ..params()
        };
        // At the reference the declared size is used as-is.
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).scaled_font_size,
            30.0
        );
        // A taller canvas scales it up...
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE * 2.0).scaled_font_size,
            60.0
        );
        // ...and a shorter one down.
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE / 3.0).scaled_font_size,
            10.0
        );
        // Line height is a multiple of the *scaled* size, not the declared one.
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE * 2.0).line_height_px,
            60.0 * DEFAULT_TEXT_LINE_HEIGHT
        );
    }

    #[test]
    fn font_size_ratio_is_against_the_declared_size_not_the_scaled_one() {
        let text = TextLayoutParams {
            font_size: 30.0,
            ..params()
        };
        // Canvas height moves `scaledFontSize` but must leave the ratio alone.
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).font_size_ratio,
            2.0
        );
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE * 4.0).font_size_ratio,
            2.0
        );
        assert_eq!(
            resolve_text_layout(&params(), FONT_SIZE_SCALE_REFERENCE).font_size_ratio,
            1.0
        );
    }

    #[test]
    fn every_alignment_passes_through_untouched() {
        for align in [TextAlign::Left, TextAlign::Center, TextAlign::Right] {
            let text = TextLayoutParams {
                text_align: align,
                ..params()
            };
            assert_eq!(
                resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).text_align,
                align
            );
        }
    }

    #[test]
    fn every_decoration_passes_through_untouched() {
        for decoration in [
            TextDecoration::None,
            TextDecoration::Underline,
            TextDecoration::LineThrough,
        ] {
            let text = TextLayoutParams {
                text_decoration: Some(decoration),
                ..params()
            };
            assert_eq!(
                resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).text_decoration,
                decoration
            );
        }
    }

    #[test]
    fn every_weight_and_style_reaches_the_font_shorthand() {
        for (weight, expected) in [
            (
                TextFontWeight::Normal,
                "normal normal 15px \"Inter\", sans-serif",
            ),
            (
                TextFontWeight::Bold,
                "normal bold 15px \"Inter\", sans-serif",
            ),
        ] {
            let text = TextLayoutParams {
                font_weight: weight,
                ..params()
            };
            assert_eq!(
                resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).font_string,
                expected
            );
        }
        for (style, expected) in [
            (
                TextFontStyle::Normal,
                "normal normal 15px \"Inter\", sans-serif",
            ),
            (
                TextFontStyle::Italic,
                "italic normal 15px \"Inter\", sans-serif",
            ),
        ] {
            let text = TextLayoutParams {
                font_style: style,
                ..params()
            };
            assert_eq!(
                resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).font_string,
                expected
            );
        }
    }

    #[test]
    fn the_decoration_wire_form_is_the_css_keyword() {
        assert_eq!(
            serde_json::to_string(&TextDecoration::LineThrough).unwrap(),
            "\"line-through\""
        );
        assert_eq!(
            serde_json::to_string(&TextDecoration::None).unwrap(),
            "\"none\""
        );
        assert_eq!(
            serde_json::to_string(&TextAlign::Center).unwrap(),
            "\"center\""
        );
    }

    #[test]
    fn a_quote_in_the_family_name_is_escaped() {
        let text = TextLayoutParams {
            font_family: "He said \"hi\"".to_string(),
            ..params()
        };
        assert_eq!(
            resolve_text_layout(&text, FONT_SIZE_SCALE_REFERENCE).font_string,
            "normal normal 15px \"He said \\\"hi\\\"\", sans-serif"
        );
    }

    #[test]
    fn corner_radius_clamps_at_both_ends() {
        // 0% is square, 100% is a pill: half the shorter side.
        assert_eq!(text_background_corner_radius(0.0, 200.0, 80.0), 0.0);
        assert_eq!(text_background_corner_radius(100.0, 200.0, 80.0), 40.0);
        // Below the minimum clamps up to square rather than inverting.
        assert_eq!(text_background_corner_radius(-50.0, 200.0, 80.0), 0.0);
        // Above the maximum clamps down to the pill rather than overflowing.
        assert_eq!(text_background_corner_radius(500.0, 200.0, 80.0), 40.0);
        // In between it is linear in the percentage.
        assert_eq!(text_background_corner_radius(50.0, 200.0, 80.0), 20.0);
        // The shorter side wins whichever one it is.
        assert_eq!(text_background_corner_radius(100.0, 30.0, 400.0), 15.0);
    }

    #[test]
    fn the_font_size_renders_the_way_javascript_renders_it() {
        assert_eq!(js_number_to_string(50.0), "50");
        assert_eq!(js_number_to_string(1.5), "1.5");
        assert_eq!(js_number_to_string(0.001), "0.001");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(-12.25), "-12.25");
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        // The two thresholds where JavaScript switches to exponential.
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e-6), "0.000001");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1.25e-7), "1.25e-7");
        // The shortest round-tripping digits, not a fixed precision.
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn the_constants_match_their_typescript_originals() {
        assert_eq!(FONT_SIZE_SCALE_REFERENCE, 90.0);
        assert_eq!(FONT_SIZE_RATIO_REFERENCE, 15.0);
        assert_eq!(TEXT_CORNER_RADIUS_MIN, 0.0);
        assert_eq!(TEXT_CORNER_RADIUS_MAX, 100.0);
        assert_eq!(DEFAULT_TEXT_LETTER_SPACING, 0.0);
        assert_eq!(DEFAULT_TEXT_LINE_HEIGHT, 1.2);
    }
}
