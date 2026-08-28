//! Mapping between timeline time and screen pixels.
//!
//! The conversions all share one base — `BASE_TIMELINE_PIXELS_PER_SECOND`, which
//! is the on-screen width of one second of media at zoom `1` — and one tick
//! lattice, `TICKS_PER_SECOND`. The numbers coming in are pixel offsets in
//! timeline content space (left edge of the scrolled content, not of the
//! viewport), so a mouse-x from a full-width row needs no scroll correction.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::{MediaTime, TICKS_PER_SECOND};

use crate::math::js_round;
use crate::timeline::snapping::BASE_TIMELINE_PIXELS_PER_SECOND;

/// Width in CSS pixels of the vertical line that marks the current time on the
/// timeline.
#[export]
pub const TIMELINE_INDICATOR_LINE_WIDTH_PX: f64 = 2.0;

/// A device-pixel-ratio the caller supplied, or `1.0` when nothing else is
/// available. The browser fallback (`window.devicePixelRatio`) only exists on
/// the web side and is not reachable from here.
fn get_device_pixel_ratio(device_pixel_ratio: Option<f64>) -> f64 {
    match device_pixel_ratio {
        Some(ratio) if ratio.is_finite() && ratio > 0.0 => ratio,
        _ => 1.0,
    }
}

/// Pixels per second at the given zoom level. The single source of truth the
/// time-to-pixels and pixels-to-time conversions both use.
pub fn get_timeline_pixels_per_second(zoom_level: f64) -> f64 {
    BASE_TIMELINE_PIXELS_PER_SECOND * zoom_level
}

/// A media time in ticks, projected onto the timeline content.
pub fn timeline_time_to_pixels(time: f64, zoom_level: f64) -> f64 {
    let pixels_per_second = get_timeline_pixels_per_second(zoom_level);
    (time / TICKS_PER_SECOND as f64) * pixels_per_second
}

/// Inverse of [`timeline_time_to_pixels`]. `pixels` is in timeline content
/// space, from the left edge of the scrolled content. Negative pixel values
/// clamp to `0`, since nothing on the timeline begins before the start.
pub fn timeline_pixels_to_time(pixels: f64, zoom_level: f64) -> MediaTime {
    let pixels_per_second = get_timeline_pixels_per_second(zoom_level);
    let seconds = pixels / pixels_per_second;
    let tick_count = seconds.max(0.0) * TICKS_PER_SECOND as f64;
    MediaTime::from_ticks(js_round(tick_count) as i64)
}

/// Snap a raw pixel coordinate onto the device-pixel grid by multiplying it up
/// to device pixels, rounding, and dividing back. With a `dpr` of `1` this
/// collapses to the nearest CSS pixel; with `2` it lands on a half-pixel
/// offset between CSS pixels.
pub fn snap_pixel_to_device_grid(pixel: f64, device_pixel_ratio: Option<f64>) -> f64 {
    let dpr = get_device_pixel_ratio(device_pixel_ratio);
    js_round(pixel * dpr) / dpr
}

/// A media time projected onto the timeline, then snapped to the device-pixel
/// grid so a hairline indicator lands on a physical pixel.
pub fn timeline_time_to_snapped_pixels(
    time: f64,
    zoom_level: f64,
    device_pixel_ratio: Option<f64>,
) -> f64 {
    let raw_pixel = timeline_time_to_pixels(time, zoom_level);
    snap_pixel_to_device_grid(raw_pixel, device_pixel_ratio)
}

/// Left edge of a horizontal line that is `line_width_px` wide and centred on
/// `center_pixel`. The default width is the indicator's.
pub fn get_centered_line_left(center_pixel: f64, line_width_px: Option<f64>) -> f64 {
    center_pixel - line_width_px.unwrap_or(TIMELINE_INDICATOR_LINE_WIDTH_PX) / 2.0
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PixelsPerSecondOptions {
    pub zoom_level: f64,
}

#[export]
pub fn get_timeline_pixels_per_second_value(
    PixelsPerSecondOptions { zoom_level }: PixelsPerSecondOptions,
) -> f64 {
    get_timeline_pixels_per_second(zoom_level)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeToPixelsOptions {
    pub time: f64,
    pub zoom_level: f64,
}

#[export]
pub fn timeline_time_to_pixels_value(
    TimeToPixelsOptions { time, zoom_level }: TimeToPixelsOptions,
) -> f64 {
    timeline_time_to_pixels(time, zoom_level)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PixelsToTimeOptions {
    pub pixels: f64,
    pub zoom_level: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PixelsToTimeResult {
    pub time: MediaTime,
}

#[export]
pub fn timeline_pixels_to_time_value(
    PixelsToTimeOptions { pixels, zoom_level }: PixelsToTimeOptions,
) -> PixelsToTimeResult {
    PixelsToTimeResult {
        time: timeline_pixels_to_time(pixels, zoom_level),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeToSnappedPixelsOptions {
    pub time: f64,
    pub zoom_level: f64,
    #[serde(default)]
    pub device_pixel_ratio: Option<f64>,
}

#[export]
pub fn timeline_time_to_snapped_pixels_value(
    TimeToSnappedPixelsOptions {
        time,
        zoom_level,
        device_pixel_ratio,
    }: TimeToSnappedPixelsOptions,
) -> f64 {
    timeline_time_to_snapped_pixels(time, zoom_level, device_pixel_ratio)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CenteredLineLeftOptions {
    pub center_pixel: f64,
    #[serde(default)]
    pub line_width_px: Option<f64>,
}

#[export]
pub fn get_centered_line_left_value(
    CenteredLineLeftOptions {
        center_pixel,
        line_width_px,
    }: CenteredLineLeftOptions,
) -> f64 {
    get_centered_line_left(center_pixel, line_width_px)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixels_per_second_scales_with_zoom() {
        assert_eq!(get_timeline_pixels_per_second(1.0), 50.0);
        assert_eq!(get_timeline_pixels_per_second(2.0), 100.0);
        assert_eq!(get_timeline_pixels_per_second(0.5), 25.0);
    }

    #[test]
    fn time_to_pixels_matches_zoom_rate() {
        assert_eq!(timeline_time_to_pixels(0.0, 1.0), 0.0);
        assert_eq!(timeline_time_to_pixels(TICKS_PER_SECOND as f64, 1.0), 50.0);
        assert_eq!(
            timeline_time_to_pixels(TICKS_PER_SECOND as f64 / 2.0, 2.0),
            50.0
        );
    }

    #[test]
    fn pixels_to_time_inverts_time_to_pixels() {
        assert_eq!(
            timeline_pixels_to_time(0.0, 1.0),
            MediaTime::from_ticks(0)
        );
        assert_eq!(
            timeline_pixels_to_time(50.0, 1.0),
            MediaTime::from_ticks(TICKS_PER_SECOND)
        );
        // At zoom 2, pixels per second doubles (50 -> 100), so 100px is a
        // full second — same tick count as the zoom-1 case, by coincidence of
        // the rate.
        assert_eq!(
            timeline_pixels_to_time(100.0, 2.0),
            MediaTime::from_ticks(TICKS_PER_SECOND)
        );
    }

    #[test]
    fn pixels_to_time_clamps_negative_pixels_to_zero() {
        assert_eq!(
            timeline_pixels_to_time(-200.0, 1.0),
            MediaTime::from_ticks(0)
        );
    }

    #[test]
    fn snap_to_device_grid_lands_on_half_pixel_at_dpr_two() {
        // A raw pixel that already sits on the half-integer grid stays put.
        assert_eq!(snap_pixel_to_device_grid(1.5, Some(2.0)), 1.5);
        // A raw pixel halfway between half-integer anchors rounds up.
        assert_eq!(snap_pixel_to_device_grid(1.25, Some(2.0)), 1.5);
        assert_eq!(snap_pixel_to_device_grid(1.75, Some(2.0)), 2.0);
        // dpr=1 falls back to no snap.
        assert_eq!(snap_pixel_to_device_grid(1.4, Some(1.0)), 1.0);
        // A missing or invalid dpr defaults to 1.
        assert_eq!(snap_pixel_to_device_grid(1.4, None), 1.0);
        assert_eq!(snap_pixel_to_device_grid(1.4, Some(0.0)), 1.0);
        assert_eq!(snap_pixel_to_device_grid(1.4, Some(f64::NAN)), 1.0);
    }

    #[test]
    fn time_to_snapped_pixels_snap_runs_after_the_conversion() {
        // Integer pixel survives both the conversion and the snap.
        assert_eq!(
            timeline_time_to_snapped_pixels(TICKS_PER_SECOND as f64, 1.0, Some(2.0)),
            50.0
        );
        // A pixel that lands on a half-pixel stays where it is.
        assert_eq!(
            timeline_time_to_snapped_pixels(
                TICKS_PER_SECOND as f64 / 100.0,
                1.0,
                Some(2.0)
            ),
            0.5
        );
    }

    #[test]
    fn centered_line_left_offsets_by_half_the_width() {
        assert_eq!(get_centered_line_left(10.0, Some(2.0)), 9.0);
        assert_eq!(get_centered_line_left(10.5, Some(2.0)), 9.5);
    }

    #[test]
    fn centered_line_left_defaults_to_the_indicator_width() {
        let default_width = TIMELINE_INDICATOR_LINE_WIDTH_PX;
        assert_eq!(
            get_centered_line_left(10.0, None),
            10.0 - default_width / 2.0
        );
    }

    #[test]
    fn the_indicator_width_constant_matches_the_typescript_value() {
        assert_eq!(TIMELINE_INDICATOR_LINE_WIDTH_PX, 2.0);
    }
}
