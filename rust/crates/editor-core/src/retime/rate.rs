//! Bounds on playback speed.

pub const DEFAULT_RETIME_RATE: f64 = 1.0;
pub const MIN_RETIME_RATE: f64 = 0.01;
pub const MAX_RETIME_RATE: f64 = 5.0;

/// Speed curves get their own, narrower bounds. A curve handle is dragged on a
/// log axis rather than typed, so the range has to stay readable at a glance —
/// and a decade either side of 1x is the span the graph labels.
pub const MIN_CURVE_RATE: f64 = 0.1;
pub const MAX_CURVE_RATE: f64 = 10.0;

/// A rate that is not a positive finite number is not a rate; fall back to 1x
/// rather than propagating a NaN through the integral.
pub fn clamp_retime_rate(rate: f64) -> f64 {
    if !rate.is_finite() || rate <= 0.0 {
        return DEFAULT_RETIME_RATE;
    }
    rate.max(MIN_RETIME_RATE).min(MAX_RETIME_RATE)
}

pub fn clamp_curve_rate(rate: f64) -> f64 {
    if !rate.is_finite() || rate <= 0.0 {
        return DEFAULT_RETIME_RATE;
    }
    rate.max(MIN_CURVE_RATE).min(MAX_CURVE_RATE)
}

pub fn can_maintain_pitch(rate: f64) -> bool {
    rate.is_finite() && rate > 0.0
}

pub fn should_maintain_pitch(rate: f64, maintain_pitch: Option<bool>) -> bool {
    maintain_pitch == Some(true) && can_maintain_pitch(rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rate_that_is_not_a_rate_falls_back_to_one() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(clamp_retime_rate(bad), 1.0, "for {bad}");
            assert_eq!(clamp_curve_rate(bad), 1.0, "for {bad}");
        }
    }

    #[test]
    fn curves_are_bounded_more_tightly_than_a_uniform_rate() {
        assert_eq!(clamp_retime_rate(100.0), MAX_RETIME_RATE);
        assert_eq!(clamp_curve_rate(100.0), MAX_CURVE_RATE);
        // A rate legal on a curve can exceed the uniform maximum, and vice
        // versa at the bottom.
        assert_eq!(clamp_curve_rate(8.0), 8.0);
        assert_eq!(clamp_retime_rate(8.0), MAX_RETIME_RATE);
        assert_eq!(clamp_retime_rate(0.05), 0.05);
        assert_eq!(clamp_curve_rate(0.05), MIN_CURVE_RATE);
    }

    #[test]
    fn pitch_can_only_be_maintained_at_a_real_rate() {
        assert!(should_maintain_pitch(2.0, Some(true)));
        assert!(!should_maintain_pitch(2.0, Some(false)));
        assert!(!should_maintain_pitch(2.0, None));
        assert!(!should_maintain_pitch(f64::NAN, Some(true)));
    }
}

// Bridge surface. The consts are exported too, so the panel's slider bounds and
// the clamping that enforces them cannot drift apart.

#[bridge::export]
pub const DEFAULT_RETIME_RATE_VALUE: f64 = DEFAULT_RETIME_RATE;

#[bridge::export]
pub const MIN_RETIME_RATE_VALUE: f64 = MIN_RETIME_RATE;

#[bridge::export]
pub const MAX_RETIME_RATE_VALUE: f64 = MAX_RETIME_RATE;

#[bridge::export]
pub const MIN_CURVE_RATE_VALUE: f64 = MIN_CURVE_RATE;

#[bridge::export]
pub const MAX_CURVE_RATE_VALUE: f64 = MAX_CURVE_RATE;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RateOptions {
    pub rate: f64,
}

#[bridge::export]
pub fn clamp_retime_rate_value(RateOptions { rate }: RateOptions) -> f64 {
    clamp_retime_rate(rate)
}

#[bridge::export]
pub fn clamp_curve_rate_value(RateOptions { rate }: RateOptions) -> f64 {
    clamp_curve_rate(rate)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaintainPitchOptions {
    pub rate: f64,
    #[serde(default)]
    pub maintain_pitch: Option<bool>,
}

#[bridge::export]
pub fn should_maintain_pitch_for(
    MaintainPitchOptions {
        rate,
        maintain_pitch,
    }: MaintainPitchOptions,
) -> bool {
    should_maintain_pitch(rate, maintain_pitch)
}

#[bridge::export]
pub fn can_maintain_pitch_at(RateOptions { rate }: RateOptions) -> bool {
    can_maintain_pitch(rate)
}
