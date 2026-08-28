//! Display-side numeric helpers that mirror `apps/web/src/utils/math.ts`.
//!
//! Two things live here that are small but earn their own module:
//!
//! - [`clamp_round`] wraps the parent's [`crate::math::clamp`] in
//!   [`crate::math::js_round`]. The clamp is trivial; the rounding is not, because
//!   `Math.round` breaks ties toward positive infinity while `f64::round` breaks
//!   them away from zero. Calling `clamp` from a display label is fine; calling
//!   `js_round` on the same value and getting `-2` instead of `-1` is a
//!   user-visible shift.
//! - [`format_number_for_display`] reproduces `Number.prototype.toFixed` plus
//!   the trailing-zero trimming the TS module layers on top. The trap here is
//!   that JS's `toFixed` rounds half away from zero while Rust's `{:.N}` rounds
//!   half to even, so `(0.5).toFixed(0)` is `"1"` in JS and `"0"` under
//!   `format!("{:.0}", 0.5)`. The JS rule is hand-written in [`to_fixed`].
//!
//! [`evaluateMathExpression`] from the TS module is deliberately not ported —
//! its only caller is the property-draft UI input hook, which is slider text
//! parsing rather than domain logic. Keeping it in TS avoids burning a Rust
//! implementation on input handling that the editor itself does not depend on.

use bridge::export;
use serde::Deserialize;

use crate::math::{clamp as clamp_value, js_round};

/// `clampRound({ value, min, max })` from the TS module: clamp then
/// `Math.round`.
///
/// `Math.round` breaks a tie toward positive infinity, which `f64::round` does
/// not, so this is not a one-liner — it has to round through [`js_round`].
#[export]
pub fn clamp_round_value(ClampRoundOptions { value, min, max }: ClampRoundOptions) -> f64 {
    js_round(clamp_value(value, min, max))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClampRoundOptions {
    pub value: f64,
    pub min: f64,
    pub max: f64,
}

/// `formatNumberForDisplay` from the TS module — `toFixed` followed by trimming
/// trailing zeros down to `minFractionDigits`.
///
/// The JS tie rule (half away from zero) is implemented in [`to_fixed`] rather
/// than reached for from `format!`, because `format!("{:.N}", x)` rounds half
/// to even and would disagree with JS on every exact binary tie. `(0.5).toFixed(0)`
/// is `"1"`, `(0.125).toFixed(2)` is `"0.13"`; the test module pins both.
///
/// JS throws on `Infinity` and `NaN` here — `Number.prototype.toFixed` raises a
/// `RangeError` for either. Crossing the wasm boundary with a panic would crash
/// the renderer, so non-finite inputs fall through to the same string forms
/// [`crate::math::js_number_to_string`] already produces. That is a deliberate
/// divergence from JS, and is what the caller sees if a label is ever asked to
/// format a value that did not come from a real number.
#[export]
pub fn format_number_for_display_value(
    FormatNumberForDisplayOptions {
        value,
        fraction_digits,
        min_fraction_digits,
        max_fraction_digits,
    }: FormatNumberForDisplayOptions,
) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }

    let resolved_max_fraction_digits = resolve_digits(fraction_digits, max_fraction_digits);
    let resolved_min_fraction_digits =
        resolve_digits(fraction_digits, min_fraction_digits).min(resolved_max_fraction_digits);

    let fixed_value = to_fixed(value, resolved_max_fraction_digits);

    if resolved_max_fraction_digits == 0 {
        return if fixed_value == 0.0 { "0".to_string() } else { format!("{fixed_value}") };
    }

    let magnitude = fixed_value.abs();
    let integer_part = js_trimmed_integer_part(magnitude);
    let fraction_part = to_fixed_fraction_digits(magnitude, resolved_max_fraction_digits);

    let mut trimmed_fraction_part = fraction_part;
    while trimmed_fraction_part.len() > resolved_min_fraction_digits as usize
        && trimmed_fraction_part.ends_with('0')
    {
        trimmed_fraction_part.pop();
    }

    let signed_integer_part = if fixed_value < 0.0 {
        format!("-{integer_part}")
    } else {
        integer_part
    };

    if trimmed_fraction_part.is_empty() {
        signed_integer_part
    } else {
        format!("{signed_integer_part}.{trimmed_fraction_part}")
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatNumberForDisplayOptions {
    pub value: f64,
    pub fraction_digits: Option<f64>,
    pub min_fraction_digits: f64,
    pub max_fraction_digits: f64,
}

/// `Number.prototype.toFixed` for a single non-negative magnitude.
///
/// `format!("{:.N}", x)` rounds half to even, which disagrees with JavaScript
/// on every exact binary tie: `(0.5).toFixed(0)` is `"1"` in JS and `"0"` under
/// Rust. Scaling to `value.abs() * 10^digits`, rounding with `f64::round`
/// (already half away from zero), and dividing back gives the JS digits.
///
/// The `digits` argument is non-negative; callers resolve it from the options
/// struct before reaching here.
fn to_fixed(magnitude: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    let rounded = (magnitude * factor).round() / factor;
    if rounded == 0.0 {
        return 0.0;
    }
    rounded
}

/// Render the fractional digits of `magnitude` to exactly `digits` places,
/// with trailing zeros included. Returns the empty string when `digits == 0`.
///
/// Used by [`format_number_for_display_value`] to build the part after the
/// decimal point before it trims. We render the digits ourselves rather than
/// reaching for `format!` because the rounding rule has to stay aligned with
/// `to_fixed` above — splitting "compute the rounded digits" from "render them
/// as text" gives one place to keep the JS rule.
fn to_fixed_fraction_digits(magnitude: f64, digits: i32) -> String {
    if digits == 0 {
        return String::new();
    }
    let rounded = to_fixed(magnitude, digits);
    let divisor = 10f64.powi(digits);
    let divisor_u64 = 10u64.checked_pow(digits as u32).unwrap_or(0);
    let fraction = if divisor_u64 == 0 {
        0
    } else {
        ((rounded * divisor).round() as u64) % divisor_u64
    };
    format!("{fraction:0>width$}", width = digits as usize)
}

/// Integer part of `magnitude` as a string with no leading zeros except the
/// single `0` JS emits for values in `(-1, 1)`. `magnitude` is non-negative.
fn js_trimmed_integer_part(magnitude: f64) -> String {
    if magnitude < 1.0 {
        return "0".to_string();
    }
    let integer = magnitude.trunc() as u64;
    format!("{integer}")
}

/// Resolve a fractional-digits option to a non-negative `i32`. The TS module
/// treats these as integers and so does the wasm surface — the `Option<f64>`
/// type only exists because serde-wasm-bindgen carries JS numbers through as
/// `f64` and the `?` optional as `Option`. NaN/negative/non-integer values
/// clamp to 0 here, matching `Math.max(0, ...)` in the TS resolver.
fn resolve_digits(option: Option<f64>, fallback: f64) -> i32 {
    let raw = option.unwrap_or(fallback);
    if !raw.is_finite() || raw < 0.0 {
        return 0;
    }
    raw as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_round_passes_through_values_within_range() {
        assert_eq!(clamp_round_value(to_options(0.5, 0.0, 1.0)), 1.0);
        assert_eq!(clamp_round_value(to_options(0.4, 0.0, 1.0)), 0.0);
        assert_eq!(clamp_round_value(to_options(0.0, 0.0, 1.0)), 0.0);
        assert_eq!(clamp_round_value(to_options(1.0, 0.0, 1.0)), 1.0);
    }

    #[test]
    fn clamp_round_pulls_under_range_values_up_to_min() {
        assert_eq!(clamp_round_value(to_options(-0.5, 0.0, 1.0)), 0.0);
        assert_eq!(clamp_round_value(to_options(-100.0, -10.0, 10.0)), -10.0);
    }

    #[test]
    fn clamp_round_pushes_over_range_values_down_to_max() {
        assert_eq!(clamp_round_value(to_options(1.5, 0.0, 1.0)), 1.0);
        assert_eq!(clamp_round_value(to_options(100.0, -10.0, 10.0)), 10.0);
    }

    #[test]
    fn clamp_round_breaks_ties_toward_positive_infinity() {
        // The Math.round rule: half rounds up. f64::round would round away from
        // zero and produce -1 here instead of 0.
        assert_eq!(clamp_round_value(to_options(-0.5, -1.0, 1.0)), 0.0);
        assert_eq!(clamp_round_value(to_options(0.5, -1.0, 1.0)), 1.0);
        assert_eq!(clamp_round_value(to_options(1.5, 0.0, 2.0)), 2.0);
    }

    #[test]
    fn clamp_round_keeps_a_negative_zero_for_the_js_round_rule() {
        // `-0.3` rounds under `js_round` to `-0`; the equality check below
        // distinguishes signed zero through `is_sign_negative`.
        let result = clamp_round_value(to_options(-0.3, -1.0, 1.0));
        assert_eq!(result, 0.0);
        assert!(
            result.is_sign_negative(),
            "expected negative zero for js_round(-0.3), got {result:?}"
        );
    }

    fn to_options(value: f64, min: f64, max: f64) -> ClampRoundOptions {
        ClampRoundOptions { value, min, max }
    }

    fn fmt(value: f64) -> String {
        format_number_for_display_value(FormatNumberForDisplayOptions {
            value,
            fraction_digits: None,
            min_fraction_digits: 0.0,
            max_fraction_digits: 6.0,
        })
    }

    fn fmt_with(
        value: f64,
        fraction_digits: Option<f64>,
        min_fraction_digits: f64,
        max_fraction_digits: f64,
    ) -> String {
        format_number_for_display_value(FormatNumberForDisplayOptions {
            value,
            fraction_digits,
            min_fraction_digits,
            max_fraction_digits,
        })
    }

    // --- The toFixed parity cases pinned by the brief ---

    #[test]
    fn to_fixed_rounds_half_away_from_zero_like_javascript() {
        // `(0.5).toFixed(0) === "1"`. With `fraction_digits = 0`, no trimming
        // is applied so the output is the raw `toFixed` string.
        assert_eq!(fmt_with(0.5, Some(0.0), 0.0, 6.0), "1");
        assert_eq!(fmt_with(-0.5, Some(0.0), 0.0, 6.0), "-1");
        assert_eq!(fmt_with(1.5, Some(0.0), 0.0, 6.0), "2");
        // `(0.125).toFixed(2) === "0.13"`.
        assert_eq!(fmt_with(0.125, Some(2.0), 0.0, 6.0), "0.13");
        assert_eq!(fmt_with(-0.125, Some(2.0), 0.0, 6.0), "-0.13");
    }

    #[test]
    fn negative_zero_does_not_leak_into_the_output() {
        // `(-0).toFixed(2) === "0.00"` — negative zero formats as zero.
        assert_eq!(fmt_with(-0.0, Some(2.0), 0.0, 6.0), "0.00");
        assert_eq!(fmt_with(-0.0, Some(0.0), 0.0, 6.0), "0");
    }

    #[test]
    fn non_finite_inputs_do_not_panic() {
        // `Infinity.toFixed(2)` throws `RangeError` in JS; crossing the wasm
        // boundary with a panic would crash the renderer, so the wasm side
        // returns a stable string instead. The orchestrator can decide whether
        // the TS façade should mirror or pass through.
        assert_eq!(fmt(f64::INFINITY), "Infinity");
        assert_eq!(fmt(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(fmt(f64::NAN), "NaN");
    }

    // --- The display layer: trimming only happens when `fractionDigits` is
    // --- omitted (the TS resolver collapses `min` and `max` to the same
    // --- value otherwise). ---

    #[test]
    fn defaults_to_six_fraction_digits_when_unset() {
        assert_eq!(fmt(1.0), "1");
        assert_eq!(fmt(1.5), "1.5");
        assert_eq!(fmt(0.123456789), "0.123457");
        assert_eq!(fmt(-0.123456789), "-0.123457");
    }

    #[test]
    fn trailing_zeros_trim_only_when_fraction_digits_is_unset() {
        // With `fraction_digits = Some(3.0)`, the TS resolver collapses
        // `resolvedMax` and `resolvedMin` to `3`, so the trailing zeros survive
        // — `1.5.toFixed(3) === "1.500"` all the way through.
        assert_eq!(fmt_with(1.5, Some(3.0), 0.0, 3.0), "1.500");
        assert_eq!(fmt_with(1.0, Some(3.0), 0.0, 3.0), "1.000");
        assert_eq!(fmt_with(1.234, Some(3.0), 0.0, 3.0), "1.234");
        // With `fraction_digits` unset, the resolver uses `min/maxFractionDigits`
        // and trimming kicks in down to `min`.
        assert_eq!(fmt_with(1.5, None, 0.0, 3.0), "1.5");
        assert_eq!(fmt_with(1.5, None, 2.0, 3.0), "1.50");
        assert_eq!(fmt_with(1.0, None, 2.0, 3.0), "1.00");
    }

    #[test]
    fn min_fraction_digits_is_capped_by_max_fraction_digits() {
        // When `fractionDigits` is unset, `min` cannot exceed `max` — the TS
        // resolver writes `Math.min(resolvedMin, resolvedMax)` and the trim
        // loop respects it.
        assert_eq!(fmt_with(1.5, None, 5.0, 2.0), "1.50");
    }

    #[test]
    fn an_integer_renders_without_a_decimal_point() {
        assert_eq!(fmt(2.0), "2");
        assert_eq!(fmt_with(2.0, Some(3.0), 0.0, 3.0), "2.000");
        assert_eq!(fmt_with(2.0, None, 1.0, 3.0), "2.0");
    }

    #[test]
    fn negative_values_keep_their_sign_in_both_paths() {
        assert_eq!(fmt(-1.5), "-1.5");
        assert_eq!(fmt_with(-1.5, Some(0.0), 0.0, 6.0), "-2");
        assert_eq!(fmt_with(-1.5, Some(2.0), 0.0, 6.0), "-1.50");
        assert_eq!(fmt_with(-0.5, Some(2.0), 0.0, 6.0), "-0.50");
    }

    #[test]
    fn values_smaller_than_one_emit_a_leading_zero() {
        assert_eq!(fmt(0.0001), "0.0001");
        assert_eq!(fmt(0.0), "0");
    }

    #[test]
    fn large_values_render_through_to_fixed() {
        // A whole number renders without a decimal point.
        assert_eq!(fmt(1000000.0), "1000000");
        // `1234567890.5` is exact in `f64`, so it survives a six-digit round
        // unchanged — `toFixed(6)` returns "1234567890.500000" and the trim
        // loop strips the trailing zeros.
        assert_eq!(fmt(1234567890.5), "1234567890.5");
    }
}
