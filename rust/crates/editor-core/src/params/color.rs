//! CSS colour parsing, and the sRGB↔linear conversion the animation system
//! interpolates in.
//!
//! Colours are interpolated in *linear* light, not in the sRGB values a hex
//! string carries: blending two sRGB numbers directly darkens the midpoint,
//! which shows up as a muddy band halfway through a colour keyframe.
//!
//! Parsing covers what the editor actually produces and accepts — hex in all
//! four lengths, `rgb()`/`rgba()`, `hsl()`/`hsla()` and the CSS named colours.
//! Anything else answers `None`, which is what the JavaScript did for an
//! unparseable string.

use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearRgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

pub(super) fn clamp01(value: f64) -> f64 {
    value.max(0.0).min(1.0)
}

/// The sRGB transfer function, inverted. The linear segment near black is not a
/// rounding of the curve — it is part of the standard, and dropping it visibly
/// crushes shadows.
pub fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

pub fn linear_to_srgb(value: f64) -> f64 {
    let clamped = clamp01(value);
    if clamped <= 0.003_130_8 {
        clamped * 12.92
    } else {
        1.055 * clamped.powf(1.0 / 2.4) - 0.055
    }
}

pub(super) struct Srgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

fn parse_hex(text: &str) -> Option<Srgba> {
    let digits = text.strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |slice: &str| u8::from_str_radix(slice, 16).ok().map(f64::from);
    // The three- and four-digit forms double each digit, so `#f00` is `#ff0000`
    // rather than `#0f0000`.
    let nibble = |c: char| {
        u8::from_str_radix(&c.to_string(), 16)
            .ok()
            .map(|value| f64::from(value * 17))
    };
    let chars: Vec<char> = digits.chars().collect();

    let (r, g, b, a) = match chars.len() {
        3 => (nibble(chars[0])?, nibble(chars[1])?, nibble(chars[2])?, 255.0),
        4 => (
            nibble(chars[0])?,
            nibble(chars[1])?,
            nibble(chars[2])?,
            nibble(chars[3])?,
        ),
        6 => (
            byte(&digits[0..2])?,
            byte(&digits[2..4])?,
            byte(&digits[4..6])?,
            255.0,
        ),
        8 => (
            byte(&digits[0..2])?,
            byte(&digits[2..4])?,
            byte(&digits[4..6])?,
            byte(&digits[6..8])?,
        ),
        _ => return None,
    };

    Some(Srgba {
        r: r / 255.0,
        g: g / 255.0,
        b: b / 255.0,
        a: a / 255.0,
    })
}

/// Splits a functional colour's arguments, accepting both the comma form and the
/// space form with a slashed alpha (`rgb(1 2 3 / 0.5)`).
fn split_args(inner: &str) -> Vec<String> {
    inner
        .replace('/', " ")
        .replace(',', " ")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// A channel given either as a number or as a percentage of `full`.
fn channel(text: &str, full: f64) -> Option<f64> {
    match text.strip_suffix('%') {
        Some(percent) => percent.trim().parse::<f64>().ok().map(|v| v / 100.0),
        None => text.parse::<f64>().ok().map(|v| v / full),
    }
}

fn alpha(text: Option<&String>) -> Option<f64> {
    match text {
        None => Some(1.0),
        Some(text) => channel(text, 1.0),
    }
}

fn parse_rgb(inner: &str) -> Option<Srgba> {
    let args = split_args(inner);
    if args.len() < 3 {
        return None;
    }
    Some(Srgba {
        r: clamp01(channel(&args[0], 255.0)?),
        g: clamp01(channel(&args[1], 255.0)?),
        b: clamp01(channel(&args[2], 255.0)?),
        a: clamp01(alpha(args.get(3))?),
    })
}

fn hue_to_rgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 0.5 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

fn parse_hsl(inner: &str) -> Option<Srgba> {
    let args = split_args(inner);
    if args.len() < 3 {
        return None;
    }
    let hue_text = args[0].trim_end_matches("deg");
    let hue = hue_text.parse::<f64>().ok()? / 360.0;
    let saturation = clamp01(channel(&args[1], 100.0)?);
    let lightness = clamp01(channel(&args[2], 100.0)?);

    if saturation == 0.0 {
        return Some(Srgba {
            r: lightness,
            g: lightness,
            b: lightness,
            a: clamp01(alpha(args.get(3))?),
        });
    }

    let q = if lightness < 0.5 {
        lightness * (1.0 + saturation)
    } else {
        lightness + saturation - lightness * saturation
    };
    let p = 2.0 * lightness - q;
    let hue = hue.rem_euclid(1.0);

    Some(Srgba {
        r: hue_to_rgb(p, q, hue + 1.0 / 3.0),
        g: hue_to_rgb(p, q, hue),
        b: hue_to_rgb(p, q, hue - 1.0 / 3.0),
        a: clamp01(alpha(args.get(3))?),
    })
}

fn named(name: &str) -> Option<&'static str> {
    // The CSS named colours, as hex so they go through the same path as any
    // other hex string.
    const NAMES: &[(&str, &str)] = &[
        ("aliceblue", "#f0f8ff"), ("antiquewhite", "#faebd7"), ("aqua", "#00ffff"),
        ("aquamarine", "#7fffd4"), ("azure", "#f0ffff"), ("beige", "#f5f5dc"),
        ("bisque", "#ffe4c4"), ("black", "#000000"), ("blanchedalmond", "#ffebcd"),
        ("blue", "#0000ff"), ("blueviolet", "#8a2be2"), ("brown", "#a52a2a"),
        ("burlywood", "#deb887"), ("cadetblue", "#5f9ea0"), ("chartreuse", "#7fff00"),
        ("chocolate", "#d2691e"), ("coral", "#ff7f50"), ("cornflowerblue", "#6495ed"),
        ("cornsilk", "#fff8dc"), ("crimson", "#dc143c"), ("cyan", "#00ffff"),
        ("darkblue", "#00008b"), ("darkcyan", "#008b8b"), ("darkgoldenrod", "#b8860b"),
        ("darkgray", "#a9a9a9"), ("darkgreen", "#006400"), ("darkgrey", "#a9a9a9"),
        ("darkkhaki", "#bdb76b"), ("darkmagenta", "#8b008b"), ("darkolivegreen", "#556b2f"),
        ("darkorange", "#ff8c00"), ("darkorchid", "#9932cc"), ("darkred", "#8b0000"),
        ("darksalmon", "#e9967a"), ("darkseagreen", "#8fbc8f"), ("darkslateblue", "#483d8b"),
        ("darkslategray", "#2f4f4f"), ("darkslategrey", "#2f4f4f"), ("darkturquoise", "#00ced1"),
        ("darkviolet", "#9400d3"), ("deeppink", "#ff1493"), ("deepskyblue", "#00bfff"),
        ("dimgray", "#696969"), ("dimgrey", "#696969"), ("dodgerblue", "#1e90ff"),
        ("firebrick", "#b22222"), ("floralwhite", "#fffaf0"), ("forestgreen", "#228b22"),
        ("fuchsia", "#ff00ff"), ("gainsboro", "#dcdcdc"), ("ghostwhite", "#f8f8ff"),
        ("gold", "#ffd700"), ("goldenrod", "#daa520"), ("gray", "#808080"),
        ("green", "#008000"), ("greenyellow", "#adff2f"), ("grey", "#808080"),
        ("honeydew", "#f0fff0"), ("hotpink", "#ff69b4"), ("indianred", "#cd5c5c"),
        ("indigo", "#4b0082"), ("ivory", "#fffff0"), ("khaki", "#f0e68c"),
        ("lavender", "#e6e6fa"), ("lavenderblush", "#fff0f5"), ("lawngreen", "#7cfc00"),
        ("lemonchiffon", "#fffacd"), ("lightblue", "#add8e6"), ("lightcoral", "#f08080"),
        ("lightcyan", "#e0ffff"), ("lightgoldenrodyellow", "#fafad2"), ("lightgray", "#d3d3d3"),
        ("lightgreen", "#90ee90"), ("lightgrey", "#d3d3d3"), ("lightpink", "#ffb6c1"),
        ("lightsalmon", "#ffa07a"), ("lightseagreen", "#20b2aa"), ("lightskyblue", "#87cefa"),
        ("lightslategray", "#778899"), ("lightslategrey", "#778899"), ("lightsteelblue", "#b0c4de"),
        ("lightyellow", "#ffffe0"), ("lime", "#00ff00"), ("limegreen", "#32cd32"),
        ("linen", "#faf0e6"), ("magenta", "#ff00ff"), ("maroon", "#800000"),
        ("mediumaquamarine", "#66cdaa"), ("mediumblue", "#0000cd"), ("mediumorchid", "#ba55d3"),
        ("mediumpurple", "#9370db"), ("mediumseagreen", "#3cb371"), ("mediumslateblue", "#7b68ee"),
        ("mediumspringgreen", "#00fa9a"), ("mediumturquoise", "#48d1cc"),
        ("mediumvioletred", "#c71585"), ("midnightblue", "#191970"), ("mintcream", "#f5fffa"),
        ("mistyrose", "#ffe4e1"), ("moccasin", "#ffe4b5"), ("navajowhite", "#ffdead"),
        ("navy", "#000080"), ("oldlace", "#fdf5e6"), ("olive", "#808000"),
        ("olivedrab", "#6b8e23"), ("orange", "#ffa500"), ("orangered", "#ff4500"),
        ("orchid", "#da70d6"), ("palegoldenrod", "#eee8aa"), ("palegreen", "#98fb98"),
        ("paleturquoise", "#afeeee"), ("palevioletred", "#db7093"), ("papayawhip", "#ffefd5"),
        ("peachpuff", "#ffdab9"), ("peru", "#cd853f"), ("pink", "#ffc0cb"),
        ("plum", "#dda0dd"), ("powderblue", "#b0e0e6"), ("purple", "#800080"),
        ("rebeccapurple", "#663399"), ("red", "#ff0000"), ("rosybrown", "#bc8f8f"),
        ("royalblue", "#4169e1"), ("saddlebrown", "#8b4513"), ("salmon", "#fa8072"),
        ("sandybrown", "#f4a460"), ("seagreen", "#2e8b57"), ("seashell", "#fff5ee"),
        ("sienna", "#a0522d"), ("silver", "#c0c0c0"), ("skyblue", "#87ceeb"),
        ("slateblue", "#6a5acd"), ("slategray", "#708090"), ("slategrey", "#708090"),
        ("snow", "#fffafa"), ("springgreen", "#00ff7f"), ("steelblue", "#4682b4"),
        ("tan", "#d2b48c"), ("teal", "#008080"), ("thistle", "#d8bfd8"),
        ("tomato", "#ff6347"), ("turquoise", "#40e0d0"), ("violet", "#ee82ee"),
        ("wheat", "#f5deb3"), ("white", "#ffffff"), ("whitesmoke", "#f5f5f5"),
        ("yellow", "#ffff00"), ("yellowgreen", "#9acd32"),
    ];
    NAMES
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, hex)| *hex)
}

pub(super) fn parse_srgba(color: &str) -> Option<Srgba> {
    let text = color.trim();
    if text.starts_with('#') {
        return parse_hex(text);
    }

    let lowered = text.to_ascii_lowercase();
    if let Some(inner) = lowered
        .strip_prefix("rgba(")
        .or_else(|| lowered.strip_prefix("rgb("))
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return parse_rgb(inner);
    }
    if let Some(inner) = lowered
        .strip_prefix("hsla(")
        .or_else(|| lowered.strip_prefix("hsl("))
        .and_then(|rest| rest.strip_suffix(')'))
    {
        return parse_hsl(inner);
    }
    if lowered == "transparent" {
        return Some(Srgba {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.0,
        });
    }

    named(&lowered).and_then(parse_hex)
}

/// A CSS colour in linear light, or `None` when the string is not a colour this
/// understands — a `var()` reference, say, which the JavaScript also refused.
pub fn parse_color_to_linear_rgba(color: &str) -> Option<LinearRgba> {
    let srgb = parse_srgba(color)?;
    Some(LinearRgba {
        r: srgb_to_linear(srgb.r),
        g: srgb_to_linear(srgb.g),
        b: srgb_to_linear(srgb.b),
        a: clamp01(srgb.a),
    })
}

/// Back to a hex string — with an alpha pair only when it is not fully opaque,
/// so an opaque colour round-trips to the `#rrggbb` form it came in as.
pub fn format_linear_rgba(color: &LinearRgba) -> String {
    let byte = |value: f64| (clamp01(value) * 255.0).round() as u8;
    let r = byte(linear_to_srgb(color.r));
    let g = byte(linear_to_srgb(color.g));
    let b = byte(linear_to_srgb(color.b));
    let a = clamp01(color.a);
    if a < 1.0 {
        format!("#{r:02x}{g:02x}{b:02x}{:02x}", byte(a))
    } else {
        format!("#{r:02x}{g:02x}{b:02x}")
    }
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParseColorOptions {
    pub color: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedColor {
    pub color: Option<LinearRgba>,
}

#[bridge::export]
pub fn parse_color_to_linear_rgba_value(
    ParseColorOptions { color }: ParseColorOptions,
) -> ParsedColor {
    ParsedColor {
        color: parse_color_to_linear_rgba(&color),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatColorOptions {
    pub color: LinearRgba,
}

#[bridge::export]
pub fn format_linear_rgba_value(FormatColorOptions { color }: FormatColorOptions) -> String {
    format_linear_rgba(&color)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_round_trip(color: &str) -> String {
        format_linear_rgba(&parse_color_to_linear_rgba(color).expect("parses"))
    }

    #[test]
    fn hex_survives_a_round_trip_through_linear_light() {
        for color in ["#000000", "#ffffff", "#00d21e", "#c0c0c0", "#123456"] {
            assert_eq!(hex_round_trip(color), color, "for {color}");
        }
    }

    #[test]
    fn the_short_hex_forms_double_each_digit() {
        // `#f00` is `#ff0000`, not `#0f0000`.
        assert_eq!(hex_round_trip("#f00"), "#ff0000");
        assert_eq!(hex_round_trip("#fff"), "#ffffff");
        assert_eq!(hex_round_trip("#0000"), "#00000000");
    }

    #[test]
    fn alpha_is_only_written_when_it_is_not_opaque() {
        assert_eq!(hex_round_trip("#ff000080"), "#ff000080");
        assert_eq!(hex_round_trip("#ff0000ff"), "#ff0000");
    }

    #[test]
    fn the_rgb_functions_parse_in_both_syntaxes() {
        assert_eq!(hex_round_trip("rgb(255, 0, 0)"), "#ff0000");
        assert_eq!(hex_round_trip("rgba(255,255,255,1)"), "#ffffff");
        assert_eq!(hex_round_trip("rgb(64, 64, 64)"), "#404040");
        assert_eq!(hex_round_trip("rgb(255 0 0 / 0.5)"), "#ff000080");
        assert_eq!(hex_round_trip("rgb(100%, 0%, 0%)"), "#ff0000");
    }

    #[test]
    fn a_fully_transparent_colour_keeps_its_alpha() {
        assert_eq!(hex_round_trip("rgba(255,255,255,0)"), "#ffffff00");
        assert_eq!(hex_round_trip("transparent"), "#00000000");
    }

    #[test]
    fn hsl_lands_on_the_expected_corners() {
        assert_eq!(hex_round_trip("hsl(0, 100%, 50%)"), "#ff0000");
        assert_eq!(hex_round_trip("hsl(120, 100%, 50%)"), "#00ff00");
        assert_eq!(hex_round_trip("hsl(240, 100%, 50%)"), "#0000ff");
        // No saturation is a grey, whatever the hue says.
        assert_eq!(hex_round_trip("hsl(200, 0%, 50%)"), "#808080");
    }

    #[test]
    fn named_colours_resolve_and_are_case_insensitive() {
        assert_eq!(hex_round_trip("red"), "#ff0000");
        assert_eq!(hex_round_trip("RebeccaPurple"), "#663399");
        assert_eq!(hex_round_trip("grey"), hex_round_trip("gray"));
    }

    #[test]
    fn something_that_is_not_a_colour_is_refused() {
        // The editor does hand this in — a themed CSS variable — and the
        // JavaScript refused it too.
        for text in ["hsl(var(--background))", "", "not-a-colour", "#12345"] {
            assert!(
                parse_color_to_linear_rgba(text).is_none(),
                "should not parse: {text:?}"
            );
        }
    }

    #[test]
    fn interpolating_in_linear_light_is_not_the_srgb_midpoint() {
        // The whole reason the conversion is here: the midpoint of black and
        // white in linear light is well above the sRGB halfway value, and
        // blending the raw numbers instead is what makes a colour keyframe look
        // muddy in the middle.
        let black = parse_color_to_linear_rgba("#000000").unwrap();
        let white = parse_color_to_linear_rgba("#ffffff").unwrap();
        let midpoint = LinearRgba {
            r: (black.r + white.r) / 2.0,
            g: (black.g + white.g) / 2.0,
            b: (black.b + white.b) / 2.0,
            a: 1.0,
        };
        assert_eq!(format_linear_rgba(&midpoint), "#bcbcbc");
    }
}
