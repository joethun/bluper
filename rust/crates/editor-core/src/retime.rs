//! Speed curves: how fast a clip walks its source material.

mod curve;
mod presets;
mod rate;
mod resolve;
mod split;

pub use curve::{
    CurveOptions, CurveRateAtPositionOptions, CurveRateSamples, MAX_CURVE_POINTS,
    MAX_CURVE_POINTS_VALUE, RetimeOptions, SampleCurveRatesOptions, ScaleCurveOptions,
    SliceCurveOptions, get_curve_rate_at_position, get_retime_curve_of, has_retime_curve,
    sample_curve_rate_series, sanitize_curve, scale_curve_rates, slice_curve, curve_clip_fraction_at_source_fraction, curve_clip_per_source,
    curve_rate_at_position, curve_source_fraction_at_clip_fraction, retime_curve,
    sample_curve_rates, sanitize_retime_curve, scale_retime_curve_rates, slice_retime_curve,
};
pub use rate::{
    DEFAULT_RETIME_RATE_VALUE, MAX_CURVE_RATE_VALUE, MAX_RETIME_RATE_VALUE,
    MIN_CURVE_RATE_VALUE, MIN_RETIME_RATE_VALUE, can_maintain_pitch_at, MaintainPitchOptions, RateOptions,
    clamp_curve_rate_value, clamp_retime_rate_value, should_maintain_pitch_for,
    DEFAULT_RETIME_RATE, MAX_CURVE_RATE, MAX_RETIME_RATE, MIN_CURVE_RATE, MIN_RETIME_RATE,
    can_maintain_pitch, clamp_curve_rate, clamp_retime_rate, should_maintain_pitch,
};
pub use resolve::{
    ClipTimeAtSourceTimeOptions, SourceTimeAtClipTimeOptions, TimelineDurationOptions,
    get_clip_time_at_source_time, get_source_time_at_clip_time,
    get_timeline_duration_for_source_span,
};
pub use presets::{
    BuildConstantRetimeOptions, BuildCurveRetimeOptions, BuildRetimeCurvePresetOptions,
    RetimeCurvePreset, RetimeCurvePresets, build_constant_retime, build_curve_retime,
    build_retime_curve_preset, get_retime_curve_presets,
};
pub use split::{
    SourceSpanAtClipTimeOptions, SplitRetime, SplitRetimeOptions, get_source_span_at_clip_time,
    split_retime_at_clip_time,
};
