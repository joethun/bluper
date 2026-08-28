//! Frame rates on the way in — `apps/web/src/fps/utils.ts`.
//!
//! A project stores its rate as an exact fraction, and imported media reports
//! one as a float. The conversion between the two is not a division: 29.97 is
//! `30000/1001`, not `2997/100`, and treating it as the latter puts every
//! frame boundary a few ticks off. So a float that is within a hair of a
//! broadcast rate snaps to that rate's exact fraction, and only a genuinely
//! unusual rate falls through to the general reduction.

use bridge::export;
use serde::Deserialize;

use time::FrameRate;

/// The rates a float is allowed to snap to, with the exact fraction each one
/// stands for. NTSC's `/1001` rates are the reason this table exists.
const STANDARD_FRAME_RATES: [FrameRate; 10] = [
    FrameRate::FPS_23_976,
    FrameRate::FPS_24,
    FrameRate::FPS_25,
    FrameRate::FPS_29_97,
    FrameRate::FPS_30,
    FrameRate::FPS_48,
    FrameRate::FPS_50,
    FrameRate::FPS_59_94,
    FrameRate::FPS_60,
    FrameRate::FPS_120,
];

/// How far a reported rate may sit from a standard one and still be taken for
/// it. Wide enough to absorb a container that rounded 23.976 to 23.98, narrow
/// enough that 24 and 25 cannot be confused.
const STANDARD_FRAME_RATE_TOLERANCE: f64 = 0.01;

/// Denominator a non-standard rate is expressed over before being reduced.
const ARBITRARY_DENOMINATOR: f64 = 1_000_000.0;

pub fn frame_rate_to_float(rate: FrameRate) -> f64 {
    f64::from(rate.numerator) / f64::from(rate.denominator)
}

pub fn frame_rates_equal(a: FrameRate, b: FrameRate) -> bool {
    a.numerator == b.numerator && a.denominator == b.denominator
}

/// Euclid, on floats, because the numerator is a rounded product rather than
/// an integer type. Non-finite inputs would never terminate — `NaN % NaN` is
/// `NaN`, which is never zero — so they leave with a divisor of 1 and let the
/// caller's clamp reject the rate.
fn gcd(left: f64, right: f64) -> f64 {
    if !left.is_finite() || !right.is_finite() {
        return 1.0;
    }
    let mut a = left.abs();
    let mut b = right.abs();
    while b != 0.0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    if a == 0.0 { 1.0 } else { a }
}

/// The exact fraction a reported rate stands for.
///
/// The order of the standard table is the TypeScript's, and it matters: the
/// first entry within tolerance wins, so 23.976 reaches `24000/1001` before it
/// can reach `24`.
pub fn float_to_frame_rate(fps: f64) -> FrameRate {
    let standard = STANDARD_FRAME_RATES.into_iter().find(|candidate| {
        (fps - frame_rate_to_float(*candidate)).abs() <= STANDARD_FRAME_RATE_TOLERANCE
    });
    if let Some(rate) = standard {
        return rate;
    }

    // The TypeScript reached its `gcd` with a NaN here and hung. Nothing calls
    // it that way, but a rate the probe could not read is exactly the input a
    // caller would pass by accident, so it leaves as an invalid rate — which
    // the project validator already refuses — instead of spinning.
    if !fps.is_finite() {
        return FrameRate {
            numerator: 0,
            denominator: 1,
        };
    }

    if fps.fract() == 0.0 {
        return FrameRate {
            numerator: clamp_to_u32(fps),
            denominator: 1,
        };
    }

    let scaled_numerator = crate::math::js_round(fps * ARBITRARY_DENOMINATOR);
    let divisor = gcd(scaled_numerator, ARBITRARY_DENOMINATOR);
    FrameRate {
        numerator: clamp_to_u32(scaled_numerator / divisor),
        denominator: clamp_to_u32(ARBITRARY_DENOMINATOR / divisor),
    }
}

/// The wire type is `u32` on both halves of the fraction, so a rate that is
/// negative, NaN or larger than four billion cannot be represented. None of
/// those describe media — the guard exists so a malformed probe lands on a
/// clamped rate rather than wrapping into a plausible-looking wrong one.
fn clamp_to_u32(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    if value >= f64::from(u32::MAX) {
        return u32::MAX;
    }
    value as u32
}

/// One imported asset, as far as the frame-rate decision is concerned.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMediaFps {
    #[serde(rename = "type")]
    pub media_type: String,
    /// Absent for audio and images, and for a video the probe could not read.
    #[serde(default)]
    pub fps: Option<f64>,
}

/// The fastest video among the assets, or `None` when none of them is a video
/// with a usable rate. Audio and images have no frame rate of their own and
/// are skipped rather than counted as zero.
pub fn get_highest_imported_video_fps(assets: &[ImportedMediaFps]) -> Option<f64> {
    let mut highest: Option<f64> = None;

    for asset in assets {
        if asset.media_type != "video" {
            continue;
        }
        let fps = asset.fps.unwrap_or(f64::NAN);
        if !fps.is_finite() || fps <= 0.0 {
            continue;
        }

        highest = Some(match highest {
            None => fps,
            Some(current) => current.max(fps),
        });
    }

    highest
}

/// The rate the project should be raised to after an import, or `None` to
/// leave it alone.
///
/// Only ever raises. Dropping a 24p clip into a 60p project must not slow the
/// project down — the whole timeline's frame boundaries would move — but
/// importing 60p footage into a 24p project and leaving it at 24 would throw
/// away frames the user just brought in.
pub fn get_raised_project_fps_for_imported_media(
    current_fps: FrameRate,
    imported_assets: &[ImportedMediaFps],
) -> Option<FrameRate> {
    let highest_imported_video_fps = get_highest_imported_video_fps(imported_assets)?;
    if highest_imported_video_fps <= frame_rate_to_float(current_fps) {
        return None;
    }

    Some(float_to_frame_rate(highest_imported_video_fps))
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameRateOptions {
    pub rate: FrameRate,
}

#[export]
pub fn frame_rate_to_float_value(FrameRateOptions { rate }: FrameRateOptions) -> f64 {
    frame_rate_to_float(rate)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FrameRatesEqualOptions {
    pub a: FrameRate,
    pub b: FrameRate,
}

#[export]
pub fn frame_rates_equal_value(FrameRatesEqualOptions { a, b }: FrameRatesEqualOptions) -> bool {
    frame_rates_equal(a, b)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FloatToFrameRateOptions {
    pub fps: f64,
}

#[export]
pub fn float_to_frame_rate_value(FloatToFrameRateOptions { fps }: FloatToFrameRateOptions) -> FrameRate {
    float_to_frame_rate(fps)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HighestImportedVideoFpsOptions {
    pub media_assets: Vec<ImportedMediaFps>,
}

/// `undefined` rather than `null` when nothing qualifies — the façade maps it
/// back, since `Option` has no null on this bridge.
#[export]
pub fn get_highest_imported_video_fps_value(
    HighestImportedVideoFpsOptions { media_assets }: HighestImportedVideoFpsOptions,
) -> Option<f64> {
    get_highest_imported_video_fps(&media_assets)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RaisedProjectFpsOptions {
    pub current_fps: FrameRate,
    pub imported_assets: Vec<ImportedMediaFps>,
}

#[export]
pub fn get_raised_project_fps_for_imported_media_value(
    RaisedProjectFpsOptions {
        current_fps,
        imported_assets,
    }: RaisedProjectFpsOptions,
) -> Option<FrameRate> {
    get_raised_project_fps_for_imported_media(current_fps, &imported_assets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(fps: f64) -> ImportedMediaFps {
        ImportedMediaFps {
            media_type: "video".to_string(),
            fps: Some(fps),
        }
    }

    fn audio() -> ImportedMediaFps {
        ImportedMediaFps {
            media_type: "audio".to_string(),
            fps: None,
        }
    }

    #[test]
    fn a_reported_ntsc_rate_snaps_to_its_exact_fraction() {
        // The whole reason the table exists: 29.97 is 30000/1001, and a naive
        // reduction would give 2997/100, whose frame boundaries drift.
        assert_eq!(float_to_frame_rate(29.97), FrameRate::FPS_29_97);
        assert_eq!(float_to_frame_rate(23.976), FrameRate::FPS_23_976);
        assert_eq!(float_to_frame_rate(59.94), FrameRate::FPS_59_94);
    }

    #[test]
    fn the_tolerance_absorbs_a_container_that_rounded_the_rate() {
        // 23.98 in a file header is 24000/1001 that someone printed to four
        // significant figures.
        assert_eq!(float_to_frame_rate(23.98), FrameRate::FPS_23_976);
        assert_eq!(float_to_frame_rate(29.98), FrameRate::FPS_29_97);
    }

    #[test]
    fn a_rate_outside_the_tolerance_is_not_snapped() {
        // 24.5 is 0.5 from both 24 and 25, so it reduces on its own.
        assert_eq!(
            float_to_frame_rate(24.5),
            FrameRate {
                numerator: 49,
                denominator: 2
            },
        );
    }

    #[test]
    fn an_integer_rate_that_is_not_standard_keeps_a_denominator_of_one() {
        assert_eq!(
            float_to_frame_rate(90.0),
            FrameRate {
                numerator: 90,
                denominator: 1
            },
        );
    }

    #[test]
    fn a_fractional_rate_reduces_against_a_million() {
        // 12.345 → 12345000/1000000 → 2469/200.
        assert_eq!(
            float_to_frame_rate(12.345),
            FrameRate {
                numerator: 2469,
                denominator: 200
            },
        );
    }

    #[test]
    fn a_rate_that_cannot_be_represented_clamps_instead_of_wrapping() {
        // Nothing produces these; the point is that a malformed probe lands on
        // an invalid rate the validator can reject, not on a plausible one.
        assert_eq!(float_to_frame_rate(-30.0).numerator, 0);
        assert_eq!(float_to_frame_rate(f64::NAN).numerator, 0);
    }

    #[test]
    fn equality_is_on_the_fraction_not_its_value() {
        // 30/1 and 60/2 are the same rate and different fractions. The editor
        // stores one of them, and treating them as equal would hide a project
        // written with the other.
        assert!(frame_rates_equal(FrameRate::FPS_30, FrameRate::new(30, 1)));
        assert!(!frame_rates_equal(FrameRate::FPS_30, FrameRate::new(60, 2)));
    }

    #[test]
    fn the_float_value_is_the_division() {
        assert_eq!(frame_rate_to_float(FrameRate::FPS_30), 30.0);
        assert!((frame_rate_to_float(FrameRate::FPS_29_97) - 29.97).abs() < 0.001);
    }

    #[test]
    fn the_highest_rate_ignores_everything_that_is_not_a_playable_video() {
        let assets = vec![
            audio(),
            video(24.0),
            ImportedMediaFps {
                media_type: "video".to_string(),
                fps: None,
            },
            video(0.0),
            video(60.0),
            video(30.0),
        ];
        assert_eq!(get_highest_imported_video_fps(&assets), Some(60.0));
    }

    #[test]
    fn nothing_importable_leaves_the_rate_unknown() {
        assert_eq!(get_highest_imported_video_fps(&[]), None);
        assert_eq!(get_highest_imported_video_fps(&[audio()]), None);
    }

    #[test]
    fn a_faster_import_raises_the_project_rate() {
        assert_eq!(
            get_raised_project_fps_for_imported_media(FrameRate::FPS_24, &[video(60.0)]),
            Some(FrameRate::FPS_60),
        );
    }

    #[test]
    fn a_slower_or_equal_import_leaves_the_project_alone() {
        // Lowering the project rate would move every existing frame boundary.
        assert_eq!(
            get_raised_project_fps_for_imported_media(FrameRate::FPS_60, &[video(24.0)]),
            None,
        );
        assert_eq!(
            get_raised_project_fps_for_imported_media(FrameRate::FPS_30, &[video(30.0)]),
            None,
        );
    }

    #[test]
    fn a_raise_lands_on_the_exact_fraction_not_the_reported_float() {
        assert_eq!(
            get_raised_project_fps_for_imported_media(FrameRate::FPS_24, &[video(29.97)]),
            Some(FrameRate::FPS_29_97),
        );
    }
}
