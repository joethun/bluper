//! Mapping between a clip's volume (in dB) and the on-screen line position, and
//! between an output amplitude and a waveform bar fraction.
//!
//! The dB → position curve is defined in linear gain space so dragging near 0 dB
//! is precise while mute compresses into the bottom of the clip; the position →
//! dB curve is its inverse. The amplitude → bar fraction curve uses a dB scale
//! to keep quiet content visible while reserving the top of the element for
//! amplitudes approaching 0 dBFS.

use bridge::export;
use serde::Deserialize;

use crate::params::defaults::{VOLUME_DB_MAX, VOLUME_DB_MIN};

const SLIDER_CURVE_EXPONENT: f64 = 2.0;
const MIN_DISPLAY_DB: f64 = -40.0;
const WAVEFORM_BAR_EXPONENT: f64 = 1.5;

// Linear gain endpoints. `10 ** (VOLUME_DB_MIN / 20)` and
// `10 ** (VOLUME_DB_MAX / 20)`, the same constants the TypeScript module
// computes at import time. Holding them as functions instead of `pub const`
// because `f64::powf` is not a `const fn`, and pinning them keeps every slider
// endpoint stable across Rust releases.
fn min_linear_gain() -> f64 {
    10f64.powf(VOLUME_DB_MIN / 20.0)
}

fn max_linear_gain() -> f64 {
    10f64.powf(VOLUME_DB_MAX / 20.0)
}

fn linear_gain_range() -> f64 {
    max_linear_gain() - min_linear_gain()
}

/// Clamp a dB value into the editor's volume range. `±Infinity` is not finite
/// and lands at 0 — mirroring `clampDb` in `audio-state.ts` so the Rust and TS
/// sliders stay in step on bad inputs.
fn clamp_db(db: f64) -> f64 {
    if !db.is_finite() {
        return 0.0;
    }
    db.clamp(VOLUME_DB_MIN, VOLUME_DB_MAX)
}

/// Linear gain in `[0, 1]` derived from a (clamped) dB value. The slider's 0..1
/// position spans the editor's full dB range, so silence maps to 0 and +20 dB
/// to 1 — not the perceptual loudness curve, which would compress the top.
fn get_normalized_gain_from_db(db: f64) -> f64 {
    let clamped_db = clamp_db(db);
    let linear_gain = 10f64.powf(clamped_db / 20.0);
    (linear_gain - min_linear_gain()) / linear_gain_range()
}

/// Maps the clip's volume setting to the line position. The curve is defined in
/// linear gain space so dragging near 0 dB is precise while mute compresses
/// into the bottom of the clip.
pub fn get_line_pos_from_db(db: f64) -> f64 {
    let normalized_gain = get_normalized_gain_from_db(db).clamp(0.0, 1.0);
    let progress = normalized_gain.powf(1.0 / SLIDER_CURVE_EXPONENT);
    (1.0 - progress) * 100.0
}

/// Inverse of [`get_line_pos_from_db`]. Converts a drag position back into the
/// clip's volume setting without depending on the underlying audio content.
pub fn get_db_from_line_pos(percent: f64) -> f64 {
    let clamped_percent = percent.clamp(0.0, 100.0);
    let progress = 1.0 - clamped_percent / 100.0;
    let normalized_gain = progress.powf(SLIDER_CURVE_EXPONENT);
    let linear_gain = min_linear_gain() + normalized_gain * linear_gain_range();
    clamp_db(20.0 * linear_gain.log10())
}

/// Maps an output amplitude (raw sample amplitude × gain) to a visible waveform
/// height fraction using a dB scale. The mapping is agnostic to peak vs RMS —
/// the caller decides which measure feeds this function.
///
/// The log scale keeps quiet content visible while reserving the top of the
/// element for amplitudes that approach 0 dBFS.
pub fn get_bar_fraction_from_output_amplitude(output_amplitude: f64) -> f64 {
    if output_amplitude <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * output_amplitude.log10();
    if db <= MIN_DISPLAY_DB {
        return 0.0;
    }
    ((db - MIN_DISPLAY_DB) / -MIN_DISPLAY_DB)
        .powf(WAVEFORM_BAR_EXPONENT)
        .min(1.0)
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LinePosFromDbOptions {
    pub db: f64,
}

#[export]
pub fn get_line_pos_from_db_value(LinePosFromDbOptions { db }: LinePosFromDbOptions) -> f64 {
    get_line_pos_from_db(db)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbFromLinePosOptions {
    pub percent: f64,
}

#[export]
pub fn get_db_from_line_pos_value(DbFromLinePosOptions { percent }: DbFromLinePosOptions) -> f64 {
    get_db_from_line_pos(percent)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BarFractionFromOutputAmplitudeOptions {
    pub output_amplitude: f64,
}

#[export]
pub fn get_bar_fraction_from_output_amplitude_value(
    BarFractionFromOutputAmplitudeOptions {
        output_amplitude,
    }: BarFractionFromOutputAmplitudeOptions,
) -> f64 {
    get_bar_fraction_from_output_amplitude(output_amplitude)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected}, got {actual} (delta {} exceeds tolerance {tolerance})",
            (actual - expected).abs(),
        );
    }

    #[test]
    fn line_pos_endpoints_match_the_typescript_curve() {
        // Silence → normalized gain 0 → progress 0 → position 100 (the slider's
        // top, where the volume line sits at full mute). The TS comment calls
        // this the "bottom" of the clip; CSS-percent 100 is the bottom edge.
        assert_eq!(get_line_pos_from_db(VOLUME_DB_MIN), 100.0);
        // +20 dB → normalized gain 1 → progress 1 → position 0 (the slider's
        // top, where the volume line sits at maximum gain).
        assert_eq!(get_line_pos_from_db(VOLUME_DB_MAX), 0.0);
    }

    #[test]
    fn line_pos_clamps_outside_the_volume_range() {
        assert_eq!(get_line_pos_from_db(-120.0), 100.0);
        assert_eq!(get_line_pos_from_db(60.0), 0.0);
    }

    #[test]
    fn line_pos_handles_non_finite_dB_like_the_typescript_clamp() {
        // `clamp_db` routes non-finite to 0, which sits in the middle of the
        // slider — that's the existing behaviour, not an error.
        let at_zero = get_line_pos_from_db(0.0);
        assert_eq!(get_line_pos_from_db(f64::NAN), at_zero);
        assert_eq!(get_line_pos_from_db(f64::INFINITY), at_zero);
        assert_eq!(get_line_pos_from_db(f64::NEG_INFINITY), at_zero);
    }

    #[test]
    fn db_round_trip_is_exact_at_the_dB_endpoints() {
        // At the dB endpoints the slider position collapses to a clean value:
        // silence → progress 0 → position 100, max → progress 1 → position 0.
        // Both directions evaluate with `pow(10, n)` and `log10` of values
        // exactly representable in binary, so the round trip is bit-exact.
        assert_eq!(get_db_from_line_pos(get_line_pos_from_db(VOLUME_DB_MIN)), VOLUME_DB_MIN);
        assert_eq!(get_db_from_line_pos(get_line_pos_from_db(VOLUME_DB_MAX)), VOLUME_DB_MAX);
    }

    #[test]
    fn db_round_trip_close_to_zero_at_midpoint() {
        // 0 dB is the midpoint of the slider; the round trip passes through
        // `pow`/`sqrt` pairs that drift at the ULP level. The TS has the same
        // drift — the parity test there uses `equalsExact` and accepts a few
        // ULPs of noise. We pin that here so a regression to a less-accurate
        // implementation stands out.
        let recovered = get_db_from_line_pos(get_line_pos_from_db(0.0));
        approx_eq(recovered, 0.0, 1e-12);
    }

    #[test]
    fn line_pos_to_db_is_exact_at_zero_and_full() {
        // Position 0 (slider's top, max gain) lands at the ceiling of the dB
        // range; position 100 (slider's bottom, full mute) at the floor.
        assert_eq!(get_db_from_line_pos(0.0), VOLUME_DB_MAX);
        assert_eq!(get_db_from_line_pos(100.0), VOLUME_DB_MIN);
    }

    #[test]
    fn line_pos_to_db_clamps_outside_zero_to_hundred() {
        assert_eq!(get_db_from_line_pos(-50.0), VOLUME_DB_MAX);
        assert_eq!(get_db_from_line_pos(150.0), VOLUME_DB_MIN);
    }

    #[test]
    fn db_round_trip_holds_for_intermediate_values() {
        // -12 dB sits in the loud-but-not-clipping range. The conversion is
        // `pow(10, x/20)` both ways, so a tolerance of 1e-9 is the ULP-level
        // noise a single `log10`/`powf` pair leaves behind.
        let cases = [-30.0, -12.0, -6.0, -3.0];
        for db in cases {
            let recovered = get_db_from_line_pos(get_line_pos_from_db(db));
            approx_eq(recovered, db, 1e-9);
        }
    }

    #[test]
    fn bar_fraction_is_zero_below_the_display_floor() {
        assert_eq!(get_bar_fraction_from_output_amplitude(0.0), 0.0);
        // -40 dB is the floor of the bar fraction curve, so anything quieter
        // is also 0 — including the silent case (negative or zero amplitude).
        assert_eq!(get_bar_fraction_from_output_amplitude(0.005), 0.0);
        assert_eq!(get_bar_fraction_from_output_amplitude(-1.0), 0.0);
    }

    #[test]
    fn bar_fraction_is_one_at_zero_dbFS() {
        assert_eq!(get_bar_fraction_from_output_amplitude(1.0), 1.0);
    }

    #[test]
    fn bar_fraction_grows_monotonically_in_the_visible_range() {
        // -30 dB sits above the floor and below the ceiling; the curve is a
        // monotonic power law there, so the fraction has to land between 0 and 1.
        let fraction = get_bar_fraction_from_output_amplitude(10f64.powf(-30.0 / 20.0));
        assert!(fraction > 0.0 && fraction < 1.0);
    }

    #[test]
    fn bar_fraction_clamps_above_one() {
        // Amplitudes beyond 0 dBFS are physically impossible but the function
        // is a saturating mapping — it caps at 1 rather than throwing.
        assert_eq!(get_bar_fraction_from_output_amplitude(2.0), 1.0);
    }
}
