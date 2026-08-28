//! Tick and label spacing on the timeline ruler.
//!
//! The ruler has two layers of marks: dense ticks every few frames, and
//! readable labels every several seconds. Both pick their interval from a
//! small table so they stay on frame boundaries — the label interval must
//! always be a whole number of frames, and the tick interval must divide
//! the label interval, so labels and ticks land on the same pixel column.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::FrameRate;

use crate::math::js_round;
use crate::timeline::snapping::BASE_TIMELINE_PIXELS_PER_SECOND;

/// Frame intervals for labels. Starts at 2 so there's always at least one
/// tick between labels even at maximum zoom. Pattern: 2, 3, 5, 10, 15
/// (matches CapCut).
const LABEL_FRAME_INTERVALS: &[u32] = &[2, 3, 5, 10, 15];

/// Frame intervals for ticks. Can go down to 1 for maximum granularity.
const TICK_FRAME_INTERVALS: &[u32] = &[1, 2, 3, 5, 10, 15];

/// Second intervals for when the zoom is past frame-level detail.
const SECOND_MULTIPLIERS: &[u32] = &[
    1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/// Minimum pixel spacing between labels to keep them readable.
const MIN_LABEL_SPACING_PX: f64 = 120.0;

/// Minimum pixel spacing between ticks. Much denser than labels.
const MIN_TICK_SPACING_PX: f64 = 18.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulerConfig {
    /// Time interval in seconds between each label.
    pub label_interval_seconds: f64,
    /// Time interval in seconds between each tick.
    pub tick_interval_seconds: f64,
}

/// Pick the smallest entry from `frame_intervals` whose pixel spacing clears
/// `min_spacing_px`, then fall back to the second multipliers, then to 60s.
fn find_optimal_interval(
    pixels_per_frame: f64,
    pixels_per_second: f64,
    min_spacing_px: f64,
    frame_intervals: &[u32],
    fps: f64,
) -> f64 {
    for &frame_interval in frame_intervals {
        let pixel_spacing = pixels_per_frame * f64::from(frame_interval);
        if pixel_spacing >= min_spacing_px {
            return f64::from(frame_interval) / fps;
        }
    }

    for &second_multiplier in SECOND_MULTIPLIERS {
        let pixel_spacing = pixels_per_second * f64::from(second_multiplier);
        if pixel_spacing >= min_spacing_px {
            return f64::from(second_multiplier);
        }
    }

    60.0
}

/// Adjust the tick interval so it divides the label interval exactly. The
/// label grid then always lands on a tick position, which is what the
/// `<RulerLabels>` render relies on.
fn ensure_tick_divides_label(
    tick_interval_seconds: f64,
    label_interval_seconds: f64,
    pixels_per_frame: f64,
    pixels_per_second: f64,
    fps: f64,
) -> f64 {
    let label_frames = js_round(label_interval_seconds * fps);
    let tick_frames = js_round(tick_interval_seconds * fps);

    if label_frames % tick_frames == 0.0 {
        return tick_interval_seconds;
    }

    for &candidate_frames in TICK_FRAME_INTERVALS {
        if label_frames % candidate_frames as f64 == 0.0 {
            let candidate_spacing = pixels_per_frame * candidate_frames as f64;
            if candidate_spacing >= MIN_TICK_SPACING_PX {
                return candidate_frames as f64 / fps;
            }
        }
    }

    for &candidate_seconds in SECOND_MULTIPLIERS {
        let ratio = label_interval_seconds / candidate_seconds as f64;
        if (ratio - js_round(ratio)).abs() < 0.0001 {
            let candidate_spacing = pixels_per_second * candidate_seconds as f64;
            if candidate_spacing >= MIN_TICK_SPACING_PX {
                return candidate_seconds as f64;
            }
        }
    }

    label_interval_seconds
}

/// Decide the label and tick intervals for the current zoom and frame rate.
pub fn get_ruler_config(zoom_level: f64, fps: FrameRate) -> RulerConfig {
    let fps_float = fps.as_f64().unwrap_or(0.0);
    let pixels_per_second = BASE_TIMELINE_PIXELS_PER_SECOND * zoom_level;
    let pixels_per_frame = pixels_per_second / fps_float;

    let label_interval_seconds = find_optimal_interval(
        pixels_per_frame,
        pixels_per_second,
        MIN_LABEL_SPACING_PX,
        LABEL_FRAME_INTERVALS,
        fps_float,
    );

    let raw_tick_interval_seconds = find_optimal_interval(
        pixels_per_frame,
        pixels_per_second,
        MIN_TICK_SPACING_PX,
        TICK_FRAME_INTERVALS,
        fps_float,
    );

    let tick_interval_seconds = ensure_tick_divides_label(
        raw_tick_interval_seconds,
        label_interval_seconds,
        pixels_per_frame,
        pixels_per_second,
        fps_float,
    );

    RulerConfig {
        label_interval_seconds,
        tick_interval_seconds,
    }
}

/// Whether a given time should carry a label, given the current label grid.
/// The epsilon matches the JavaScript: 0.0001 seconds, and the boundary is
/// symmetric so `1.5` is a label when the interval is `1` but `1.00009`
/// is not.
pub fn should_show_label(time: f64, label_interval_seconds: f64) -> bool {
    let epsilon = 0.0001;
    let remainder = time % label_interval_seconds;
    remainder < epsilon || remainder > label_interval_seconds - epsilon
}

/// Whether `time_in_seconds` falls exactly on a whole-second boundary.
fn is_second_boundary(time_in_seconds: f64) -> bool {
    let epsilon = 0.0001;
    let remainder = time_in_seconds % 1.0;
    remainder < epsilon || remainder > 1.0 - epsilon
}

/// Frame number within the current second. `0` when the time is on the
/// second boundary, matching the JavaScript's `Math.round(0 * fps)`.
fn get_frame_within_second(time_in_seconds: f64, fps: f64) -> i64 {
    let fractional_part = time_in_seconds % 1.0;
    js_round(fractional_part * fps) as i64
}

/// `MM:SS` (or `H:MM:SS` past one hour) when `time_in_seconds` lands on a
/// second boundary, otherwise the frame-within-second suffixed with `f`.
pub fn format_ruler_label(time_in_seconds: f64, fps: FrameRate) -> String {
    if is_second_boundary(time_in_seconds) {
        format_timestamp(time_in_seconds)
    } else {
        let fps_float = fps.as_f64().unwrap_or(0.0);
        let frame_within_second = get_frame_within_second(time_in_seconds, fps_float);
        format!("{frame_within_second}f")
    }
}

/// `MM:SS` (or `H:MM:SS` past one hour). `totalSeconds` is `Math.round`-ed
/// so a value like `59.9999` reads as `01:00` rather than `00:59`.
fn format_timestamp(time_in_seconds: f64) -> String {
    let total_seconds = js_round(time_in_seconds);
    let total_seconds = if total_seconds < 0.0 { 0.0 } else { total_seconds };
    let hours = (total_seconds / 3600.0) as i64;
    let minutes = ((total_seconds % 3600.0) / 60.0) as i64;
    let seconds = (total_seconds % 60.0) as i64;

    let mm = format!("{minutes:02}");
    let ss = format!("{seconds:02}");

    if hours > 0 {
        format!("{hours}:{mm}:{ss}")
    } else {
        format!("{mm}:{ss}")
    }
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetRulerConfigOptions {
    pub zoom_level: f64,
    pub fps: FrameRate,
}

#[export]
pub fn get_ruler_config_value(
    GetRulerConfigOptions { zoom_level, fps }: GetRulerConfigOptions,
) -> RulerConfig {
    get_ruler_config(zoom_level, fps)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShouldShowLabelOptions {
    pub time: f64,
    pub label_interval_seconds: f64,
}

#[export]
pub fn should_show_label_value(
    ShouldShowLabelOptions {
        time,
        label_interval_seconds,
    }: ShouldShowLabelOptions,
) -> bool {
    should_show_label(time, label_interval_seconds)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormatRulerLabelOptions {
    pub time_in_seconds: f64,
    pub fps: FrameRate,
}

#[export]
pub fn format_ruler_label_value(
    FormatRulerLabelOptions {
        time_in_seconds,
        fps,
    }: FormatRulerLabelOptions,
) -> String {
    format_ruler_label(time_in_seconds, fps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_zoom_one_thirty_fps_labels_every_three_seconds() {
        // At zoom 1, 30 fps: pixels per frame = 50 / 30 ≈ 1.667.
        // MIN_LABEL_SPACING_PX is 120. No frame interval in the table
        // reaches that. Falling through to seconds: 1 s = 50 px (no),
        // 2 s = 100 px (no), 3 s = 150 px (yes) → label every 3 s.
        // Tick search: at 18 px, frame 15 → spacing 25 px (yes). So
        // raw tick = 15/30 = 0.5 s. 90 frames / 15 frames = 6 → already
        // divides, so tick stays at 0.5 s.
        let config = get_ruler_config(1.0, FrameRate::FPS_30);
        assert_eq!(config.label_interval_seconds, 3.0);
        assert_eq!(config.tick_interval_seconds, 0.5);
    }

    #[test]
    fn at_high_zoom_labels_every_two_frames() {
        // At zoom 100, 30 fps: pixels per frame = 5000 / 30 ≈ 166.67.
        // MIN_LABEL_SPACING_PX is 120, so any label frame interval clears
        // it — the smallest, 2, wins → labels every 2/30 s.
        // Tick interval is found first at 1 frame (166.67 px ≥ 18 ✓).
        // 2 frames ÷ 1 frame = 2 → tick already divides label → tick = 1/30.
        let config = get_ruler_config(100.0, FrameRate::FPS_30);
        assert_eq!(config.label_interval_seconds, 2.0 / 30.0);
        assert_eq!(config.tick_interval_seconds, 1.0 / 30.0);
    }

    #[test]
    fn tick_always_divides_label() {
        for zoom in [0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 50.0] {
            let config = get_ruler_config(zoom, FrameRate::FPS_30);
            let label_frames = (config.label_interval_seconds * 30.0).round();
            let tick_frames = (config.tick_interval_seconds * 30.0).round();
            assert_eq!(
                label_frames % tick_frames,
                0.0,
                "at zoom {zoom}, label_frames={label_frames}, tick_frames={tick_frames}"
            );
        }
    }

    #[test]
    fn handles_non_integer_frame_rates() {
        // 23.976 fps = 24000/1001. At zoom 10: pixels per frame = 500/23.976.
        // The expected output uses the same f64 arithmetic as the
        // JavaScript, so we just check it doesn't panic and produces a
        // label interval that divides by the frame rate evenly.
        let config = get_ruler_config(10.0, FrameRate::FPS_23_976);
        assert!(config.label_interval_seconds > 0.0);
        assert!(config.tick_interval_seconds > 0.0);
    }

    #[test]
    fn label_falls_on_whole_intervals() {
        // For an interval of 5 s, every 5th second should be labelled and
        // the values in between should not.
        let interval = 5.0;
        for whole in 0..30 {
            let time = whole as f64 * interval;
            assert!(should_show_label(time, interval));
        }
        // Halfway between is 2.5 s past — should not label.
        assert!(!should_show_label(2.5, interval));
    }

    #[test]
    fn label_recognises_the_end_of_the_interval() {
        // The JS uses a symmetric epsilon: both 0 and the interval itself
        // are labels, so the grid is periodic. A time one epsilon *below*
        // the interval is not labelled, but *at* the interval is.
        let interval = 1.0;
        assert!(should_show_label(1.0, interval));
        assert!(should_show_label(0.0, interval));
        assert!(!should_show_label(0.5, interval));
    }

    #[test]
    fn second_boundary_formats_as_timestamp() {
        assert_eq!(format_ruler_label(0.0, FrameRate::FPS_30), "00:00");
        assert_eq!(format_ruler_label(1.0, FrameRate::FPS_30), "00:01");
        assert_eq!(format_ruler_label(59.0, FrameRate::FPS_30), "00:59");
        assert_eq!(format_ruler_label(60.0, FrameRate::FPS_30), "01:00");
        assert_eq!(format_ruler_label(90.0, FrameRate::FPS_30), "01:30");
    }

    #[test]
    fn past_one_hour_emits_h_mm_ss() {
        assert_eq!(format_ruler_label(3600.0, FrameRate::FPS_30), "1:00:00");
        assert_eq!(format_ruler_label(3661.0, FrameRate::FPS_30), "1:01:01");
        assert_eq!(format_ruler_label(7322.0, FrameRate::FPS_30), "2:02:02");
    }

    #[test]
    fn frame_label_shows_frame_within_second() {
        // At 30 fps, 0.5 s is the middle of the second — frame 15.
        // The JavaScript does Math.round(0.5 * 30) = 15.
        assert_eq!(format_ruler_label(0.5, FrameRate::FPS_30), "15f");
        // 1/30 s past the second boundary is frame 1.
        assert_eq!(
            format_ruler_label(1.0 + 1.0 / 30.0, FrameRate::FPS_30),
            "1f"
        );
        // 0.1 s into the second at 30 fps is 3 frames.
        assert_eq!(
            format_ruler_label(2.0 + 0.1, FrameRate::FPS_30),
            "3f"
        );
    }

    #[test]
    fn frame_within_second_rounds_correctly() {
        assert_eq!(get_frame_within_second(0.5, 30.0), 15);
        assert_eq!(get_frame_within_second(0.0, 30.0), 0);
        assert_eq!(get_frame_within_second(0.999, 30.0), 30);
    }
}