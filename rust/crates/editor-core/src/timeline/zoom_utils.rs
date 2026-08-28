//! Zoom level math for the timeline.
//!
//! The slider maps linearly into a logarithmic zoom range, so dragging near
//! the bottom of the bar changes the zoom in small steps and dragging near
//! the top changes it in large ones. `getTimelineZoomMin` computes the zoom
//! that just fits the project into the viewport; `getTimelinePaddingPx`
//! converts that into the horizontal padding the scrollbar leaves around the
//! content. The padding ratio is a piecewise interpolation — high near the
//! minimum zoom (lots of breathing room), tapering to a low floor as the user
//! zooms in.

use bridge::export;
use serde::Deserialize;

use time::TICKS_PER_SECOND;

use crate::timeline::snapping::BASE_TIMELINE_PIXELS_PER_SECOND;

const TIMELINE_ZOOM_MAX: f64 = 100.0;
const PADDING_MAX_RATIO: f64 = 0.75;
const PADDING_MIN_RATIO: f64 = 0.15;
const PADDING_MIN_AT_ZOOM_PERCENT: f64 = 0.2;
const DEFAULT_CONTAINER_WIDTH: f64 = 1000.0;

/// Minimum zoom level that fits the project into the viewport, capped by
/// `TIMELINE_ZOOM_MAX`. A duration under one second still uses one second for
/// the fit calculation — the slider's lower bound can't fall below what one
/// second of media needs.
pub fn get_timeline_zoom_min(duration: f64, container_width: Option<f64>) -> f64 {
    let safe_duration_seconds = (duration / TICKS_PER_SECOND as f64).max(1.0);
    let safe_container_width = container_width.unwrap_or(DEFAULT_CONTAINER_WIDTH);
    let content_ratio_at_min_zoom = 1.0 - PADDING_MAX_RATIO;
    let available_width = safe_container_width * content_ratio_at_min_zoom;
    let zoom_to_fit =
        available_width / (safe_duration_seconds * BASE_TIMELINE_PIXELS_PER_SECOND);

    zoom_to_fit.min(TIMELINE_ZOOM_MAX)
}

/// Horizontal padding the scrollbar leaves around the timeline content, in
/// pixels. The padding ratio tapers from `PADDING_MAX_RATIO` near the minimum
/// zoom down to `PADDING_MIN_RATIO` as the zoom grows past
/// `PADDING_MIN_AT_ZOOM_PERCENT` of the way to `TIMELINE_ZOOM_MAX`.
pub fn get_timeline_padding_px(container_width: f64, zoom_level: f64, min_zoom: f64) -> f64 {
    let zoom_percent = get_zoom_percent(zoom_level, min_zoom);
    let padding_transition_percent = (zoom_percent / PADDING_MIN_AT_ZOOM_PERCENT).min(1.0);
    let padding_ratio =
        PADDING_MAX_RATIO - (PADDING_MAX_RATIO - PADDING_MIN_RATIO) * padding_transition_percent;

    container_width * padding_ratio
}

fn get_zoom_percent(zoom_level: f64, min_zoom: f64) -> f64 {
    (zoom_level - min_zoom) / (TIMELINE_ZOOM_MAX - min_zoom)
}

/// Convert a linear slider position (0–1) to an exponential zoom level. At low
/// slider values the zoom changes are small; at high values they're large.
pub fn slider_to_zoom(slider_position: f64, min_zoom: f64, max_zoom: Option<f64>) -> f64 {
    let max_zoom = max_zoom.unwrap_or(TIMELINE_ZOOM_MAX);
    let clamped_position = slider_position.clamp(0.0, 1.0);
    min_zoom * (max_zoom / min_zoom).powf(clamped_position)
}

/// Inverse of [`slider_to_zoom`]. Convert an exponential zoom level back to a
/// linear slider position (0–1).
pub fn zoom_to_slider(zoom_level: f64, min_zoom: f64, max_zoom: Option<f64>) -> f64 {
    let max_zoom = max_zoom.unwrap_or(TIMELINE_ZOOM_MAX);
    let clamped_zoom = zoom_level.clamp(min_zoom, max_zoom);
    (clamped_zoom / min_zoom).ln() / (max_zoom / min_zoom).ln()
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineZoomMinOptions {
    pub duration: f64,
    /// Omitted when the caller has not measured the viewport yet. Falls back to
    /// a 1000-px container so the slider still has a defined lower bound.
    #[serde(default)]
    pub container_width: Option<f64>,
}

#[export]
pub fn get_timeline_zoom_min_value(
    TimelineZoomMinOptions {
        duration,
        container_width,
    }: TimelineZoomMinOptions,
) -> f64 {
    get_timeline_zoom_min(duration, container_width)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePaddingPxOptions {
    pub container_width: f64,
    pub zoom_level: f64,
    pub min_zoom: f64,
}

#[export]
pub fn get_timeline_padding_px_value(
    TimelinePaddingPxOptions {
        container_width,
        zoom_level,
        min_zoom,
    }: TimelinePaddingPxOptions,
) -> f64 {
    get_timeline_padding_px(container_width, zoom_level, min_zoom)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SliderToZoomOptions {
    pub slider_position: f64,
    pub min_zoom: f64,
    /// Defaults to `TIMELINE_ZOOM_MAX`. A custom value lets tests pin the
    /// slider's range independently of the production cap.
    #[serde(default)]
    pub max_zoom: Option<f64>,
}

#[export]
pub fn slider_to_zoom_value(
    SliderToZoomOptions {
        slider_position,
        min_zoom,
        max_zoom,
    }: SliderToZoomOptions,
) -> f64 {
    slider_to_zoom(slider_position, min_zoom, max_zoom)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoomToSliderOptions {
    pub zoom_level: f64,
    pub min_zoom: f64,
    /// Defaults to `TIMELINE_ZOOM_MAX`. A custom value lets tests pin the
    /// slider's range independently of the production cap.
    #[serde(default)]
    pub max_zoom: Option<f64>,
}

#[export]
pub fn zoom_to_slider_value(
    ZoomToSliderOptions {
        zoom_level,
        min_zoom,
        max_zoom,
    }: ZoomToSliderOptions,
) -> f64 {
    zoom_to_slider(zoom_level, min_zoom, max_zoom)
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
    fn min_zoom_fits_short_projects_into_a_typical_container() {
        // 5 seconds at 50 px/s is 250 px of content; with 25% reserved for
        // padding the available width is 250, so the fit is 250 / 250 = 1.0.
        assert_eq!(
            get_timeline_zoom_min(5.0 * TICKS_PER_SECOND as f64, Some(1000.0)),
            1.0,
        );
    }

    #[test]
    fn min_zoom_floors_short_durations_to_one_second() {
        // A 0.1s clip is clamped to a 1s effective duration; at 50 px/s that
        // is 50 px of content. Available width is 250, so the fit is 250/50 = 5,
        // not the 2500 a raw division of 0.1 * 50 would give.
        assert_eq!(
            get_timeline_zoom_min(TICKS_PER_SECOND as f64 / 10.0, Some(1000.0)),
            5.0,
        );
    }

    #[test]
    fn min_zoom_is_capped_by_timeline_zoom_max() {
        // A 1s clip in a 40 000-px container fits at zoom 200; the cap at 100
        // wins. Picking the container size (rather than the duration) keeps the
        // duration above the one-second floor, so this test isolates the cap.
        assert_eq!(
            get_timeline_zoom_min(
                TICKS_PER_SECOND as f64,
                Some(40_000.0),
            ),
            TIMELINE_ZOOM_MAX,
        );
    }

    #[test]
    fn min_zoom_defaults_to_a_thousand_pixel_container() {
        // The `None` branch must match the explicit-1000 call. Drift between
        // them would change every fit-to-screen calculation during SSR.
        let from_default = get_timeline_zoom_min(5.0 * TICKS_PER_SECOND as f64, None);
        let from_explicit = get_timeline_zoom_min(5.0 * TICKS_PER_SECOND as f64, Some(1000.0));
        assert_eq!(from_default, from_explicit);
    }

    #[test]
    fn padding_at_min_zoom_is_three_quarters_of_the_container() {
        let container_width = 800.0;
        let min_zoom = get_timeline_zoom_min(5.0 * TICKS_PER_SECOND as f64, Some(container_width));
        approx_eq(
            get_timeline_padding_px(container_width, min_zoom, min_zoom),
            container_width * PADDING_MAX_RATIO,
            1e-9,
        );
    }

    #[test]
    fn padding_shrinks_to_the_minimum_at_full_zoom() {
        let container_width = 800.0;
        let min_zoom = 1.0;
        let padding = get_timeline_padding_px(container_width, TIMELINE_ZOOM_MAX, min_zoom);
        approx_eq(
            padding,
            container_width * PADDING_MIN_RATIO,
            1e-9,
        );
    }

    #[test]
    fn padding_is_a_linear_ramp_between_the_two_endpoints() {
        // At zoom_percent = PADDING_MIN_AT_ZOOM_PERCENT the transition is
        // exactly halfway through — the ratio is the midpoint of the two
        // endpoints. Pinning the midpoint makes the ramp's shape auditable.
        let container_width = 800.0;
        let min_zoom = 1.0;
        let mid_zoom = min_zoom + PADDING_MIN_AT_ZOOM_PERCENT * (TIMELINE_ZOOM_MAX - min_zoom);
        let expected =
            container_width * (PADDING_MAX_RATIO - (PADDING_MAX_RATIO - PADDING_MIN_RATIO) * 1.0);
        // At the threshold the transition percent clamps to 1, so the ratio is
        // the minimum. Past the threshold the padding holds at the minimum.
        approx_eq(
            get_timeline_padding_px(container_width, mid_zoom, min_zoom),
            expected,
            1e-9,
        );
        approx_eq(
            get_timeline_padding_px(
                container_width,
                mid_zoom + (TIMELINE_ZOOM_MAX - mid_zoom) / 2.0,
                min_zoom,
            ),
            expected,
            1e-9,
        );
    }

    #[test]
    fn slider_to_zoom_endpoints_match_min_and_max() {
        // slider 0 → min_zoom (the slider's floor). slider 1 → max_zoom (the
        // ceiling). These are the bounds the UI clamps to before display.
        assert_eq!(slider_to_zoom(0.0, 1.0, None), 1.0);
        assert_eq!(slider_to_zoom(1.0, 1.0, None), TIMELINE_ZOOM_MAX);
    }

    #[test]
    fn slider_to_zoom_clamps_outside_zero_to_one() {
        assert_eq!(slider_to_zoom(-0.5, 1.0, None), 1.0);
        assert_eq!(slider_to_zoom(2.0, 1.0, None), TIMELINE_ZOOM_MAX);
    }

    #[test]
    fn slider_zoom_round_trip_holds_at_min_mid_and_max() {
        // The slider↔zoom mapping is exact by construction (`exp(ln(x)) == x`),
        // so the round trip recovers the input at any point on the curve.
        let min_zoom = 1.0;
        for slider in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let zoom = slider_to_zoom(slider, min_zoom, None);
            let recovered = zoom_to_slider(zoom, min_zoom, None);
            approx_eq(recovered, slider, 1e-12);
        }
    }

    #[test]
    fn zoom_to_slider_clamps_outside_the_zoom_range() {
        let min_zoom = 1.0;
        // zoom below the floor compresses to slider 0; above the ceiling to 1.
        assert_eq!(zoom_to_slider(0.5, min_zoom, None), 0.0);
        assert_eq!(zoom_to_slider(TIMELINE_ZOOM_MAX * 2.0, min_zoom, None), 1.0);
    }

    #[test]
    fn zoom_to_slider_uses_an_explicit_max_when_provided() {
        // A custom max shrinks the slider's range without touching the
        // default cap — used by the orchestrator's parity tests to keep
        // cases numerically friendly. The mapping is
        // `ln(zoom / min) / ln(max / min)`, so over `[1, 8]` zoom 4 lands at
        // `ln(4) / ln(8) = 2/3`, zoom 2 at `ln(2)/ln(8) = 1/3`, zoom 1 at 0.
        let min_zoom = 1.0;
        approx_eq(zoom_to_slider(4.0, min_zoom, Some(8.0)), 2.0 / 3.0, 1e-12);
        approx_eq(zoom_to_slider(2.0, min_zoom, Some(8.0)), 1.0 / 3.0, 1e-12);
        assert_eq!(zoom_to_slider(1.0, min_zoom, Some(8.0)), 0.0);
    }

    #[test]
    fn zoom_min_and_max_boundary_match_a_default_call() {
        // slider 0 lands on the minimum zoom regardless of the max argument;
        // slider 1 lands on whatever max was passed. Pin the symmetry so a
        // future change to the default breaks here, not in production.
        let min_zoom = 2.0;
        let max_zoom = 16.0;
        assert_eq!(slider_to_zoom(0.0, min_zoom, Some(max_zoom)), min_zoom);
        assert_eq!(slider_to_zoom(1.0, min_zoom, Some(max_zoom)), max_zoom);
        assert_eq!(slider_to_zoom(1.0, min_zoom, None), TIMELINE_ZOOM_MAX);
    }
}
