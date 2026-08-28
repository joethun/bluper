//! Numeric helpers whose exact rounding behaviour the editor depends on.
//!
//! JavaScript has two different rounding rules in play and they disagree on
//! ties, so both are written out here rather than reached for from `f64`:
//!
//! - `Math.round` rounds a tie toward **positive infinity** — `Math.round(-1.5)`
//!   is `-1`. Rust's `f64::round` rounds away from zero and would give `-2`.
//! - `toFixed` rounds a tie **away from zero**, on the magnitude.
//!
//! Using the wrong one shifts a snapped value by a whole step at every .5
//! boundary, which is exactly where a slider likes to land.

use bridge::export;
use serde::Deserialize;

pub mod display;
pub mod geometry;
pub use display::{ClampRoundOptions, FormatNumberForDisplayOptions, clamp_round_value, format_number_for_display_value};
pub use geometry::{
    DimensionToAspectRatioOptions, ExceedsDragThresholdOptions, GeometryPoint,
    dimension_to_aspect_ratio, dimension_to_aspect_ratio_value, exceeds_drag_threshold,
    exceeds_drag_threshold_value, rotate_offset, rotate_point_around,
};

/// `Math.round`: half toward positive infinity, negative zero included.
///
/// `(value + 0.5).floor()` gets the tie rule right but loses the sign of zero:
/// it answers `+0` across `[-0.5, -0)`, where `Math.round` answers `-0`. That
/// sign is not cosmetic here — it survives a later multiply, and `equalsExact`
/// compares with `Object.is` precisely because a `-0` that reaches stored data
/// is a real difference.
pub fn js_round(value: f64) -> f64 {
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value.is_sign_negative() {
        return -0.0;
    }
    rounded
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// `Number.prototype.toString()` for a float, digit for digit.
///
/// Anything that formats a number *into a string* the browser will compare or
/// display has to render it the way JavaScript renders it. Rust's `Display`
/// agrees on the digits — both pick the shortest form that round-trips — but
/// not on when to switch to exponential notation (`1e21` prints as twenty-two
/// digits) nor on negative zero (`-0` rather than `0`).
///
/// `{:e}` gives the shortest round-trip digits already; the rest is ECMA-262's
/// positional/exponential thresholds applied to them.
pub fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == 0.0 {
        // Covers -0.0, which JavaScript stringifies as "0".
        return "0".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value < 0.0 {
        return format!("-{}", js_number_to_string(-value));
    }

    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("LowerExp always emits an exponent");
    let digits: String = mantissa
        .chars()
        .filter(|character| *character != '.')
        .collect();
    let digit_count = digits.len() as i32;
    // `value == digits * 10^(point - digit_count)`: the decimal point sits
    // `point` digits from the left. This is the spec's `n`.
    let point = exponent
        .parse::<i32>()
        .expect("LowerExp always emits an integer exponent")
        + 1;

    if digit_count <= point && point <= 21 {
        return format!("{digits}{}", "0".repeat((point - digit_count) as usize));
    }
    if 0 < point && point <= 21 {
        let split = point as usize;
        return format!("{}.{}", &digits[..split], &digits[split..]);
    }
    if -6 < point && point <= 0 {
        return format!("0.{}{digits}", "0".repeat((-point) as usize));
    }

    let power = point - 1;
    let sign = if power < 0 { '-' } else { '+' };
    let magnitude = power.abs();
    if digit_count == 1 {
        format!("{digits}e{sign}{magnitude}")
    } else {
        format!("{}.{}e{sign}{magnitude}", &digits[..1], &digits[1..])
    }
}

/// How many fraction digits a step implies, read off the way JavaScript reads it
/// — from the number's own shortest string form, so `0.1` is one digit and
/// `1e-7` is seven.
pub fn fraction_digits_for_step(step: f64) -> i32 {
    let text = format!("{step}").to_ascii_lowercase();
    if let Some((_, exponent)) = text.split_once("e-") {
        return exponent.parse::<i32>().unwrap_or(0);
    }
    match text.split_once('.') {
        Some((_, fraction)) => fraction.len() as i32,
        None => 0,
    }
}

/// Round to `digits` fraction digits with `toFixed`'s rule: half away from zero.
fn to_fixed(value: f64, digits: i32) -> f64 {
    let factor = 10f64.powi(digits);
    let scaled = value.abs() * factor;
    // `f64::round` is already half-away-from-zero, which is the rule here.
    let rounded = scaled.round() / factor;
    if rounded == 0.0 {
        // Keep a negative zero out of stored data.
        return 0.0;
    }
    if value < 0.0 { -rounded } else { rounded }
}

/// Snap to the nearest multiple of `step`, then trim the float noise the
/// multiplication leaves behind — `0.30000000000000004` becomes `0.3`.
///
/// A step of zero or less means "no snapping", not "divide by zero".
pub fn snap_to_step(value: f64, step: f64) -> f64 {
    if step <= 0.0 {
        return value;
    }
    let snapped = js_round(value / step) * step;
    to_fixed(snapped, fraction_digits_for_step(step))
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapToStepOptions {
    pub value: f64,
    pub step: f64,
}

#[export]
pub fn snap_to_step_value(SnapToStepOptions { value, step }: SnapToStepOptions) -> f64 {
    snap_to_step(value, step)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepOptions {
    pub step: f64,
}

#[export]
pub fn get_fraction_digits_for_step(StepOptions { step }: StepOptions) -> f64 {
    f64::from(fraction_digits_for_step(step))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_keeps_the_sign_of_zero() {
        // `Math.round` answers `-0` across this range, and `equalsExact` compares
        // zeroes with `Object.is`, so `+0` here reads as drift in every parity
        // test downstream.
        assert!(js_round(-0.5).is_sign_negative());
        assert!(js_round(-0.3).is_sign_negative());
        assert!(js_round(-0.0).is_sign_negative());
        assert!(js_round(0.0).is_sign_positive());
        assert!(js_round(0.3).is_sign_positive());
    }

    #[test]
    fn js_round_breaks_ties_toward_positive_infinity() {
        // The difference from `f64::round`, which would give -2 and -1.
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(2.5), 3.0);
    }

    #[test]
    fn fraction_digits_come_from_the_steps_own_string_form() {
        assert_eq!(fraction_digits_for_step(1.0), 0);
        assert_eq!(fraction_digits_for_step(0.5), 1);
        assert_eq!(fraction_digits_for_step(0.01), 2);
        assert_eq!(fraction_digits_for_step(0.125), 3);
        assert_eq!(fraction_digits_for_step(1e-7), 7);
    }

    #[test]
    fn snapping_lands_on_a_multiple_of_the_step() {
        assert_eq!(snap_to_step(0.34, 0.1), 0.3);
        assert_eq!(snap_to_step(7.0, 5.0), 5.0);
        assert_eq!(snap_to_step(8.0, 5.0), 10.0);
    }

    #[test]
    fn a_tie_only_rounds_up_when_the_division_is_exact() {
        // `0.25 / 0.1` is exactly 2.5, so the tie rule applies and it rounds up.
        assert_eq!(snap_to_step(0.25, 0.1), 0.3);
        assert_eq!(snap_to_step(0.45, 0.1), 0.5);
        // `0.35 / 0.1` is 3.4999999999999996 in binary, so it is not a tie at
        // all and rounds *down*. Looks wrong, matches the original exactly, and
        // is the reason this is a division rather than a decimal algorithm.
        assert_eq!(snap_to_step(0.35, 0.1), 0.3);
    }

    #[test]
    fn snapping_trims_the_float_noise_the_multiply_leaves() {
        // 3 * 0.1 is 0.30000000000000004 in binary floating point; the point of
        // the trailing round is that the stored value is 0.3.
        assert_eq!(snap_to_step(0.3, 0.1), 0.3);
        assert_eq!(snap_to_step(0.7, 0.1), 0.7);
        assert_eq!(snap_to_step(2.9, 0.1), 2.9);
    }

    #[test]
    fn a_step_of_zero_or_less_means_no_snapping() {
        assert_eq!(snap_to_step(0.123456, 0.0), 0.123456);
        assert_eq!(snap_to_step(0.123456, -1.0), 0.123456);
    }

    #[test]
    fn negative_values_snap_the_way_javascript_does() {
        // Half toward positive infinity: -0.05 / 0.1 is -0.5, which rounds to 0.
        assert_eq!(snap_to_step(-0.05, 0.1), 0.0);
        assert_eq!(snap_to_step(-0.06, 0.1), -0.1);
        assert_eq!(snap_to_step(-1.5, 1.0), -1.0);
    }

    #[test]
    fn a_snapped_zero_is_never_negative() {
        let snapped = snap_to_step(-0.0001, 0.1);
        assert_eq!(snapped, 0.0);
        assert!(!snapped.is_sign_negative(), "negative zero reached the caller");
    }
}
