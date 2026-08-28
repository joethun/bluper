//! The preview's three coordinate spaces and the conversions between them —
//! `apps/web/src/preview/preview-coords.ts`.
//!
//! - **Screen**: client pixels, what a pointer event reports.
//! - **Canvas**: the project's own pixels, what an element's transform is
//!   expressed in and what the compositor draws into.
//! - **Overlay**: the handles and outlines drawn over the picture, laid out in
//!   the viewport's pixels but anchored to the canvas.
//!
//! The viewport shows a window onto the canvas: `scale` is how many screen
//! pixels a canvas pixel occupies, and `center_x`/`center_y` is the canvas
//! point pinned to the middle of the viewport. Zooming changes the first,
//! panning the second, and every conversion here is those two applied in one
//! direction or the other.

use bridge::export;
use serde::Deserialize;

use crate::math::geometry::GeometryPoint;

/// Where the viewport is looking and how far in. Mirrors
/// `PreviewViewportGeometry`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewViewportGeometry {
    pub canvas_height: f64,
    pub canvas_width: f64,
    pub center_x: f64,
    pub center_y: f64,
    pub scale: f64,
    pub viewport_height: f64,
    pub viewport_width: f64,
}

/// Canvas point drawn at the viewport's top-left corner.
fn canvas_origin(geometry: PreviewViewportGeometry) -> GeometryPoint {
    GeometryPoint {
        x: geometry.viewport_width / 2.0 - geometry.center_x * geometry.scale,
        y: geometry.viewport_height / 2.0 - geometry.center_y * geometry.scale,
    }
}

/// A client point in canvas units. `overlay_x`/`overlay_y` are the pointer
/// position relative to the viewport element's top-left — the caller measures
/// the element, since a `DOMRect` has no meaning here.
pub fn screen_to_canvas(
    overlay_x: f64,
    overlay_y: f64,
    geometry: PreviewViewportGeometry,
) -> GeometryPoint {
    GeometryPoint {
        x: geometry.center_x + (overlay_x - geometry.viewport_width / 2.0) / geometry.scale,
        y: geometry.center_y + (overlay_y - geometry.viewport_height / 2.0) / geometry.scale,
    }
}

pub fn canvas_to_overlay(
    canvas_x: f64,
    canvas_y: f64,
    geometry: PreviewViewportGeometry,
) -> GeometryPoint {
    let origin = canvas_origin(geometry);

    GeometryPoint {
        x: origin.x + canvas_x * geometry.scale,
        y: origin.y + canvas_y * geometry.scale,
    }
}

/// An element's `position` in overlay units. A position is an offset from the
/// canvas centre, which is why this is not `canvas_to_overlay` with the same
/// numbers.
pub fn position_to_overlay(
    position_x: f64,
    position_y: f64,
    geometry: PreviewViewportGeometry,
) -> GeometryPoint {
    canvas_to_overlay(
        geometry.canvas_width / 2.0 + position_x,
        geometry.canvas_height / 2.0 + position_y,
        geometry,
    )
}

/// Screen pixels per canvas pixel, per axis.
///
/// The preview never scales the axes independently — the picture would shear —
/// so both components are the same number. It stays a pair because the callers
/// feed it into per-axis handle maths that would otherwise have to know that.
pub fn display_scale(geometry: PreviewViewportGeometry) -> GeometryPoint {
    GeometryPoint {
        x: geometry.scale,
        y: geometry.scale,
    }
}

/// A distance in screen pixels expressed in canvas units — how far a drag has
/// to travel on screen to count, whatever the zoom is.
pub fn screen_pixels_to_logical_threshold(
    screen_pixels: f64,
    geometry: PreviewViewportGeometry,
) -> GeometryPoint {
    GeometryPoint {
        x: screen_pixels / geometry.scale,
        y: screen_pixels / geometry.scale,
    }
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenToCanvasOptions {
    /// Pointer position relative to the viewport element's left edge.
    pub overlay_x: f64,
    /// Pointer position relative to the viewport element's top edge.
    pub overlay_y: f64,
    pub geometry: PreviewViewportGeometry,
}

#[export]
pub fn screen_to_canvas_point(
    ScreenToCanvasOptions {
        overlay_x,
        overlay_y,
        geometry,
    }: ScreenToCanvasOptions,
) -> GeometryPoint {
    screen_to_canvas(overlay_x, overlay_y, geometry)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanvasToOverlayOptions {
    pub canvas_x: f64,
    pub canvas_y: f64,
    pub geometry: PreviewViewportGeometry,
}

#[export]
pub fn canvas_to_overlay_point(
    CanvasToOverlayOptions {
        canvas_x,
        canvas_y,
        geometry,
    }: CanvasToOverlayOptions,
) -> GeometryPoint {
    canvas_to_overlay(canvas_x, canvas_y, geometry)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PositionToOverlayOptions {
    pub position_x: f64,
    pub position_y: f64,
    pub geometry: PreviewViewportGeometry,
}

#[export]
pub fn position_to_overlay_point(
    PositionToOverlayOptions {
        position_x,
        position_y,
        geometry,
    }: PositionToOverlayOptions,
) -> GeometryPoint {
    position_to_overlay(position_x, position_y, geometry)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewGeometryOptions {
    pub geometry: PreviewViewportGeometry,
}

#[export]
pub fn get_display_scale(PreviewGeometryOptions { geometry }: PreviewGeometryOptions) -> GeometryPoint {
    display_scale(geometry)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScreenPixelsToLogicalThresholdOptions {
    pub screen_pixels: f64,
    pub geometry: PreviewViewportGeometry,
}

#[export]
pub fn screen_pixels_to_logical_threshold_value(
    ScreenPixelsToLogicalThresholdOptions {
        screen_pixels,
        geometry,
    }: ScreenPixelsToLogicalThresholdOptions,
) -> GeometryPoint {
    screen_pixels_to_logical_threshold(screen_pixels, geometry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry(scale: f64) -> PreviewViewportGeometry {
        PreviewViewportGeometry {
            canvas_width: 1920.0,
            canvas_height: 1080.0,
            center_x: 960.0,
            center_y: 540.0,
            scale,
            viewport_width: 800.0,
            viewport_height: 450.0,
        }
    }

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() <= 1e-9,
            "expected {expected}, got {actual}",
        );
    }

    #[test]
    fn the_middle_of_the_viewport_is_the_centred_canvas_point() {
        let point = screen_to_canvas(400.0, 225.0, geometry(0.5));
        assert_eq!(point, GeometryPoint { x: 960.0, y: 540.0 });
    }

    #[test]
    fn screen_distance_divides_by_the_scale() {
        // 100px right of centre at half scale is 200 canvas units right of the
        // centred point.
        let point = screen_to_canvas(500.0, 225.0, geometry(0.5));
        approx(point.x, 1160.0);
        approx(point.y, 540.0);
    }

    #[test]
    fn canvas_and_screen_are_inverses_of_each_other() {
        let geometry = geometry(0.375);
        let canvas = screen_to_canvas(123.0, 456.0, geometry);
        let overlay = canvas_to_overlay(canvas.x, canvas.y, geometry);
        approx(overlay.x, 123.0);
        approx(overlay.y, 456.0);
    }

    #[test]
    fn a_position_of_zero_lands_on_the_canvas_centre() {
        // An element with no offset sits in the middle of the frame, which is
        // the middle of the viewport when the view is centred.
        let overlay = position_to_overlay(0.0, 0.0, geometry(0.5));
        approx(overlay.x, 400.0);
        approx(overlay.y, 225.0);
    }

    #[test]
    fn a_position_offset_is_scaled_like_any_other_canvas_distance() {
        let overlay = position_to_overlay(100.0, -50.0, geometry(0.5));
        approx(overlay.x, 450.0);
        approx(overlay.y, 200.0);
    }

    #[test]
    fn a_panned_view_moves_the_canvas_under_the_viewport() {
        // Pinning a canvas point left of centre pushes the picture right.
        let mut panned = geometry(0.5);
        panned.center_x = 760.0;
        let overlay = canvas_to_overlay(960.0, 540.0, panned);
        approx(overlay.x, 500.0);
        approx(overlay.y, 225.0);
    }

    #[test]
    fn the_display_scale_is_the_same_on_both_axes() {
        // The preview never shears, and the callers depend on it: a handle
        // that scaled x and y differently would not stay on the outline.
        let scale = display_scale(geometry(0.375));
        assert_eq!(scale, GeometryPoint { x: 0.375, y: 0.375 });
    }

    #[test]
    fn a_screen_threshold_grows_as_the_view_zooms_out() {
        // Four screen pixels is eight canvas units at half scale and two at
        // double — the gesture stays the same size under the finger.
        assert_eq!(
            screen_pixels_to_logical_threshold(4.0, geometry(0.5)),
            GeometryPoint { x: 8.0, y: 8.0 },
        );
        assert_eq!(
            screen_pixels_to_logical_threshold(4.0, geometry(2.0)),
            GeometryPoint { x: 2.0, y: 2.0 },
        );
    }
}
