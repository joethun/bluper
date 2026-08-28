//! The colour picker's own conversions: hex to and from HSV and HSL, alpha
//! stitched onto a hex string, and the loose parsing a paste needs.
//!
//! These are separate from [`super::color`] because they work in *sRGB* rather
//! than linear light. A picker is a direct manipulation of the numbers a user
//! sees, so the hue ring, the saturation square and the hex field all have to
//! agree digit for digit; interpolation, which is what linear light exists for,
//! never happens here.
//!
//! Hex strings in this module carry **no** leading `#` — that is the form the
//! picker's text field holds.

use serde::{Deserialize, Serialize};

use super::color::{Srgba, clamp01, parse_srgba};
use crate::math::js_round;

/// `Math.round(clamp(v) * 255)`: a channel as the byte a hex pair spells.
fn byte(value: f64) -> u8 {
    js_round(clamp01(value) * 255.0) as u8
}

fn hex6(color: &Srgba) -> String {
    format!(
        "{:02x}{:02x}{:02x}",
        byte(color.r),
        byte(color.g),
        byte(color.b)
    )
}

/// `((h % 360) + 360) % 360` — a hue dragged past either end of the ring.
fn normalize_hue(hue: f64) -> f64 {
    let wrapped = hue % 360.0;
    if wrapped < 0.0 { wrapped + 360.0 } else { wrapped }
}

/// Hue, in degrees, of an RGB triple — or `None` when it is a shade of grey and
/// there is no hue to name.
fn hue_of(r: f64, g: f64, b: f64) -> Option<f64> {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let span = max - min;
    if span == 0.0 {
        return None;
    }
    let sixth = if max == r {
        (g - b) / span + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / span + 2.0
    } else {
        (r - g) / span + 4.0
    };
    Some(sixth * 60.0)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hsv {
    pub h: f64,
    pub s: f64,
    pub v: f64,
}

fn srgba_to_hsv(color: &Srgba) -> Hsv {
    let max = color.r.max(color.g).max(color.b);
    let min = color.r.min(color.g).min(color.b);
    Hsv {
        h: hue_of(color.r, color.g, color.b).unwrap_or(0.0),
        s: if max == 0.0 { 0.0 } else { 1.0 - min / max },
        v: max,
    }
}

fn hsv_to_srgba(h: f64, s: f64, v: f64) -> Srgba {
    let hue = normalize_hue(h);
    let f = ((hue / 60.0) % 2.0 - 1.0).abs();
    let (r, g, b) = match (hue / 60.0).floor() as i64 {
        0 => (v, v * (1.0 - s * f), v * (1.0 - s)),
        1 => (v * (1.0 - s * f), v, v * (1.0 - s)),
        2 => (v * (1.0 - s), v, v * (1.0 - s * f)),
        3 => (v * (1.0 - s), v * (1.0 - s * f), v),
        4 => (v * (1.0 - s * f), v * (1.0 - s), v),
        5 => (v, v * (1.0 - s), v * (1.0 - s * f)),
        _ => (v * (1.0 - s), v * (1.0 - s), v * (1.0 - s)),
    };
    Srgba { r, g, b, a: 1.0 }
}

struct Hsl {
    h: f64,
    s: f64,
    l: f64,
}

fn srgba_to_hsl(color: &Srgba) -> Hsl {
    let max = color.r.max(color.g).max(color.b);
    let min = color.r.min(color.g).min(color.b);
    Hsl {
        h: hue_of(color.r, color.g, color.b).unwrap_or(0.0),
        s: if max == min {
            0.0
        } else {
            (max - min) / (1.0 - (max + min - 1.0).abs())
        },
        l: 0.5 * (max + min),
    }
}

fn hsl_to_srgba(h: f64, s: f64, l: f64) -> Srgba {
    let hue = normalize_hue(h);
    let m1 = l + s * (if l < 0.5 { l } else { 1.0 - l });
    let m2 = m1 - (m1 - l) * 2.0 * ((hue / 60.0) % 2.0 - 1.0).abs();
    let far = 2.0 * l - m1;
    let (r, g, b) = match (hue / 60.0).floor() as i64 {
        0 => (m1, m2, far),
        1 => (m2, m1, far),
        2 => (far, m1, m2),
        3 => (far, m2, m1),
        4 => (m2, far, m1),
        5 => (m1, far, m2),
        _ => (far, far, far),
    };
    Srgba { r, g, b, a: 1.0 }
}

// JavaScript's number parsers, which stop at the first character they cannot
// use rather than refusing the whole string. `parseInt("12px")` is 12.

fn js_parse_int(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let mut chars = trimmed.char_indices();
    let mut end = 0;
    let mut seen_digit = false;
    for (index, ch) in chars.by_ref() {
        if index == 0 && (ch == '+' || ch == '-') {
            end = index + ch.len_utf8();
            continue;
        }
        if ch.is_ascii_digit() {
            seen_digit = true;
            end = index + ch.len_utf8();
            continue;
        }
        break;
    }
    if !seen_digit {
        return None;
    }
    trimmed[..end].parse::<f64>().ok()
}

fn js_parse_float(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let bytes = trimmed.as_bytes();
    let mut end = 0;
    let mut seen_digit = false;
    let mut seen_dot = false;
    while end < bytes.len() {
        let ch = bytes[end];
        match ch {
            b'+' | b'-' if end == 0 => {}
            b'0'..=b'9' => seen_digit = true,
            b'.' if !seen_dot => seen_dot = true,
            b'e' | b'E' if seen_digit => {
                // An exponent only counts when digits follow it, otherwise the
                // number ends before the `e`.
                let mut probe = end + 1;
                if probe < bytes.len() && (bytes[probe] == b'+' || bytes[probe] == b'-') {
                    probe += 1;
                }
                if probe < bytes.len() && bytes[probe].is_ascii_digit() {
                    while probe < bytes.len() && bytes[probe].is_ascii_digit() {
                        probe += 1;
                    }
                    end = probe;
                }
                break;
            }
            _ => break,
        }
        end += 1;
    }
    if !seen_digit {
        return None;
    }
    trimmed[..end].parse::<f64>().ok()
}

/// The hue, saturation and value of a bare hex string; black when it does not
/// parse, which is what the picker showed before.
pub fn hex_to_hsv(hex: &str) -> Hsv {
    match parse_srgba(&format!("#{hex}")) {
        Some(color) => srgba_to_hsv(&color),
        None => Hsv {
            h: 0.0,
            s: 0.0,
            v: 0.0,
        },
    }
}

pub fn hsv_to_hex(h: f64, s: f64, v: f64) -> String {
    hex6(&hsv_to_srgba(h, s, v))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HexAlpha {
    pub rgb: String,
    pub alpha: f64,
}

/// Split a hex string into its opaque part and its alpha. An unparseable string
/// keeps its first six characters rather than being thrown away, so a field
/// being typed into does not blank out between keystrokes.
pub fn parse_hex_alpha(hex: &str) -> HexAlpha {
    match parse_srgba(&format!("#{hex}")) {
        Some(color) => HexAlpha {
            rgb: hex6(&color),
            alpha: color.a,
        },
        None => HexAlpha {
            rgb: hex.chars().take(6).collect::<String>().to_lowercase(),
            alpha: 1.0,
        },
    }
}

/// Append an alpha pair, but only when the colour is not fully opaque — an
/// opaque colour stays in the `rrggbb` form the picker's field shows.
pub fn append_alpha(rgb_hex: &str, alpha: f64) -> String {
    if alpha >= 1.0 {
        return rgb_hex.to_string();
    }
    format!("{rgb_hex}{:02x}", byte(alpha))
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The first `#hex` in a string, subject to the same word boundary the
/// JavaScript regex required — so `#abcz` is not a colour.
fn first_embedded_hex(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    for (start, byte) in bytes.iter().enumerate() {
        if *byte != b'#' {
            continue;
        }
        let mut run = 0;
        while run < 8 && bytes.get(start + 1 + run).is_some_and(u8::is_ascii_hexdigit) {
            run += 1;
        }
        // Greedy, then backtracking, exactly as the regex did.
        for length in (3..=run).rev() {
            let after = start + 1 + length;
            let boundary = bytes.get(after).is_none_or(|next| !is_word_byte(*next));
            if boundary {
                return Some(&text[start + 1..after]);
            }
        }
    }
    None
}

/// Strip the punctuation a copied CSS declaration brings with it: an
/// `!important`, a trailing semicolon, and the `property:` in front of the
/// value.
fn strip_css_noise(text: &str) -> String {
    let mut cleaned = text.trim().to_string();

    // Case-insensitive `\s*!important\s*` — every occurrence.
    loop {
        let lowered = cleaned.to_lowercase();
        let Some(at) = lowered.find("!important") else {
            break;
        };
        let mut start = at;
        while start > 0
            && cleaned.as_bytes()[start - 1].is_ascii_whitespace()
        {
            start -= 1;
        }
        let mut end = at + "!important".len();
        while end < cleaned.len() && cleaned.as_bytes()[end].is_ascii_whitespace() {
            end += 1;
        }
        cleaned.replace_range(start..end, "");
    }

    // `;+\s*$`
    let trailing = cleaned.trim_end();
    let without_semicolons = trailing.trim_end_matches(';');
    if without_semicolons.len() != trailing.len() {
        cleaned = without_semicolons.to_string();
    } else {
        cleaned = trailing.to_string();
    }
    let cleaned = cleaned.trim().to_string();

    // A `property: value` pair, but not the `(` of a function — `rgb(1,2,3)`
    // has no colon, while `color: red` does.
    let colon = cleaned.find(':');
    let paren = cleaned.find('(');
    match (colon, paren) {
        (Some(colon_at), None) => cleaned[colon_at + 1..].trim().to_string(),
        (Some(colon_at), Some(paren_at)) if colon_at < paren_at => {
            cleaned[colon_at + 1..].trim().to_string()
        }
        _ => cleaned,
    }
}

fn hex_with_alpha(color: &Srgba) -> String {
    if color.a < 1.0 {
        format!("{}{:02x}", hex6(color), byte(color.a))
    } else {
        hex6(color)
    }
}

/// A colour out of pasted text — a declaration, a bare hex without its `#`, or
/// a hex buried in a longer string. `None` when there is no colour in it.
pub fn extract_color_from_text(text: &str) -> Option<String> {
    let cleaned = strip_css_noise(text);

    if let Some(color) = parse_srgba(&cleaned) {
        return Some(hex_with_alpha(&color));
    }

    let is_bare_hex = !cleaned.is_empty()
        && cleaned.len() >= 3
        && cleaned.len() <= 8
        && cleaned.bytes().all(|b| b.is_ascii_hexdigit());
    if is_bare_hex {
        if let Some(color) = parse_srgba(&format!("#{cleaned}")) {
            return Some(hex_with_alpha(&color));
        }
    }

    let embedded = first_embedded_hex(text)?;
    parse_srgba(&format!("#{embedded}")).map(|color| hex_with_alpha(&color))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorFormat {
    Hex,
    Rgb,
    Hsl,
    Hsv,
}

/// A hex colour written the way the picker's chosen format spells it — the
/// numbers only, without the `rgb(...)` wrapper, because the field supplies
/// that.
pub fn format_color_value(hex: &str, format: ColorFormat) -> String {
    if format == ColorFormat::Hex {
        return hex.to_string();
    }
    let Some(color) = parse_srgba(&format!("#{hex}")) else {
        return hex.to_string();
    };
    match format {
        ColorFormat::Hex => hex.to_string(),
        ColorFormat::Rgb => format!(
            "{}, {}, {}",
            js_round(color.r * 255.0),
            js_round(color.g * 255.0),
            js_round(color.b * 255.0)
        ),
        ColorFormat::Hsl => {
            let hsl = srgba_to_hsl(&color);
            format!(
                "{}, {}%, {}%",
                js_round(hsl.h),
                js_round(hsl.s * 100.0),
                js_round(hsl.l * 100.0)
            )
        }
        ColorFormat::Hsv => {
            let hsv = srgba_to_hsv(&color);
            format!(
                "{}, {}%, {}%",
                js_round(hsv.h),
                js_round(hsv.s * 100.0),
                js_round(hsv.v * 100.0)
            )
        }
    }
}

/// The reverse: what the user typed into a field, back to a bare hex string, or
/// `None` when it is not three numbers.
pub fn parse_color_input(input: &str, format: ColorFormat) -> Option<String> {
    if format == ColorFormat::Hex {
        // `replace("#", "")` in JavaScript takes only the first one.
        let cleaned = match input.find('#') {
            Some(at) => format!("{}{}", &input[..at], &input[at + 1..]),
            None => input.to_string(),
        };
        let valid = (3..=8).contains(&cleaned.len())
            && cleaned.bytes().all(|b| b.is_ascii_hexdigit());
        return valid.then_some(cleaned);
    }

    let parts: Vec<&str> = input.split(',').collect();
    if parts.len() < 3 {
        return None;
    }
    let numbers: Option<Vec<f64>> = parts
        .iter()
        .take(3)
        .map(|part| match format {
            ColorFormat::Rgb => js_parse_int(part),
            _ => js_parse_float(part),
        })
        .collect();
    let numbers = numbers?;

    let color = match format {
        ColorFormat::Hex => unreachable!("handled above"),
        ColorFormat::Rgb => Srgba {
            r: numbers[0] / 255.0,
            g: numbers[1] / 255.0,
            b: numbers[2] / 255.0,
            a: 1.0,
        },
        ColorFormat::Hsl => hsl_to_srgba(numbers[0], numbers[1] / 100.0, numbers[2] / 100.0),
        ColorFormat::Hsv => hsv_to_srgba(numbers[0], numbers[1] / 100.0, numbers[2] / 100.0),
    };
    Some(hex6(&color))
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HexOptions {
    pub hex: String,
}

#[bridge::export]
pub fn hex_to_hsv_value(HexOptions { hex }: HexOptions) -> Hsv {
    hex_to_hsv(&hex)
}

#[bridge::export]
pub fn parse_hex_alpha_value(HexOptions { hex }: HexOptions) -> HexAlpha {
    parse_hex_alpha(&hex)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HsvOptions {
    pub h: f64,
    pub s: f64,
    pub v: f64,
}

#[bridge::export]
pub fn hsv_to_hex_value(HsvOptions { h, s, v }: HsvOptions) -> String {
    hsv_to_hex(h, s, v)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppendAlphaOptions {
    pub rgb_hex: String,
    pub alpha: f64,
}

#[bridge::export]
pub fn append_alpha_value(AppendAlphaOptions { rgb_hex, alpha }: AppendAlphaOptions) -> String {
    append_alpha(&rgb_hex, alpha)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtractColorOptions {
    pub text: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedColor {
    pub hex: Option<String>,
}

#[bridge::export]
pub fn extract_color_from_text_value(
    ExtractColorOptions { text }: ExtractColorOptions,
) -> ExtractedColor {
    ExtractedColor {
        hex: extract_color_from_text(&text),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatColorValueOptions {
    pub hex: String,
    pub format: ColorFormat,
}

#[bridge::export]
pub fn format_color_value_string(
    FormatColorValueOptions { hex, format }: FormatColorValueOptions,
) -> String {
    format_color_value(&hex, format)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParseColorInputOptions {
    pub input: String,
    pub format: ColorFormat,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedColorInput {
    pub hex: Option<String>,
}

#[bridge::export]
pub fn parse_color_input_value(
    ParseColorInputOptions { input, format }: ParseColorInputOptions,
) -> ParsedColorInput {
    ParsedColorInput {
        hex: parse_color_input(&input, format),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_hex_through_hsv() {
        for hex in ["ff0000", "00ff00", "0000ff", "336699", "ffffff", "000000"] {
            let hsv = hex_to_hsv(hex);
            assert_eq!(hsv_to_hex(hsv.h, hsv.s, hsv.v), hex, "{hex}");
        }
    }

    #[test]
    fn a_grey_has_no_hue_and_reads_as_zero() {
        let hsv = hex_to_hsv("808080");
        assert_eq!(hsv.h, 0.0);
        assert_eq!(hsv.s, 0.0);
    }

    #[test]
    fn expands_a_short_hex_and_keeps_its_alpha() {
        assert_eq!(
            parse_hex_alpha("c93"),
            HexAlpha {
                rgb: "cc9933".to_string(),
                alpha: 1.0
            }
        );
        let with_alpha = parse_hex_alpha("ff000080");
        assert_eq!(with_alpha.rgb, "ff0000");
        assert!((with_alpha.alpha - 128.0 / 255.0).abs() < 1e-12);
    }

    #[test]
    fn a_half_typed_hex_keeps_its_first_six_characters() {
        assert_eq!(
            parse_hex_alpha("ff00zz"),
            HexAlpha {
                rgb: "ff00zz".to_string(),
                alpha: 1.0
            }
        );
    }

    #[test]
    fn appends_alpha_only_below_opaque() {
        assert_eq!(append_alpha("ff0000", 1.0), "ff0000");
        assert_eq!(append_alpha("ff0000", 0.5), "ff000080");
        assert_eq!(append_alpha("ff0000", 0.0), "ff000000");
    }

    #[test]
    fn reads_a_colour_out_of_a_pasted_declaration() {
        assert_eq!(
            extract_color_from_text("  background-color: #ff8800 !important; "),
            Some("ff8800".to_string())
        );
        assert_eq!(
            extract_color_from_text("rgb(255, 136, 0)"),
            Some("ff8800".to_string())
        );
        assert_eq!(
            extract_color_from_text("ff8800"),
            Some("ff8800".to_string())
        );
        assert_eq!(
            extract_color_from_text("the border is #ff8800 today"),
            Some("ff8800".to_string())
        );
    }

    #[test]
    fn a_hex_run_needs_a_word_boundary_to_end_on() {
        assert_eq!(extract_color_from_text("#abcz"), None);
        // Five hex digits is not a hex colour, and there is no shorter match
        // that ends on a boundary.
        assert_eq!(extract_color_from_text("#abcde"), None);
    }

    #[test]
    fn a_colon_inside_a_function_is_not_a_property_separator() {
        assert_eq!(
            extract_color_from_text("hsl(210, 50%, 40%)"),
            Some("336699".to_string())
        );
        assert!(extract_color_from_text("hsl(var(--background))").is_none());
    }

    #[test]
    fn formats_a_hex_into_each_field_the_picker_offers() {
        assert_eq!(format_color_value("ff8800", ColorFormat::Hex), "ff8800");
        assert_eq!(format_color_value("ff8800", ColorFormat::Rgb), "255, 136, 0");
        assert_eq!(format_color_value("zzz", ColorFormat::Rgb), "zzz");
    }

    #[test]
    fn parses_each_field_back_to_a_hex() {
        assert_eq!(
            parse_color_input("#ff8800", ColorFormat::Hex),
            Some("ff8800".to_string())
        );
        assert_eq!(parse_color_input("nope", ColorFormat::Hex), None);
        assert_eq!(
            parse_color_input("255, 136, 0", ColorFormat::Rgb),
            Some("ff8800".to_string())
        );
        assert_eq!(parse_color_input("255, 136", ColorFormat::Rgb), None);
        assert_eq!(parse_color_input("a, b, c", ColorFormat::Rgb), None);
    }

    #[test]
    fn javascripts_parsers_stop_at_the_first_unusable_character() {
        assert_eq!(js_parse_int("12px"), Some(12.0));
        assert_eq!(js_parse_int("  -7 "), Some(-7.0));
        assert_eq!(js_parse_int("px"), None);
        assert_eq!(js_parse_float("50%"), Some(50.0));
        assert_eq!(js_parse_float("1.5e2x"), Some(150.0));
        assert_eq!(js_parse_float("1.5e"), Some(1.5));
    }
}
