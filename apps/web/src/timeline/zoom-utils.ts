import {
	getTimelineZoomMinValue as _getTimelineZoomMinValue,
	getTimelinePaddingPxValue as _getTimelinePaddingPxValue,
	sliderToZoomValue as _sliderToZoomValue,
	zoomToSliderValue as _zoomToSliderValue,
} from "bluper-wasm";

/**
 * Timeline zoom math. Owned by `editor-core::timeline::zoom_utils`.
 *
 * `BASE_TIMELINE_PIXELS_PER_SECOND` and `TIMELINE_ZOOM_MAX` still live in
 * `apps/web/src/timeline/scale.ts`; the Rust module reuses the same values
 * from `crate::timeline::snapping` and a private `const` respectively. Once
 * that TS file is ported the façade will read through it.
 */

export function getTimelineZoomMin({
	duration,
	containerWidth,
}: {
	duration: number;
	containerWidth: number | null | undefined;
}): number {
	return _getTimelineZoomMinValue({
		duration,
		containerWidth: containerWidth ?? undefined,
	});
}

export function getTimelinePaddingPx({
	containerWidth,
	zoomLevel,
	minZoom,
}: {
	containerWidth: number;
	zoomLevel: number;
	minZoom: number;
}): number {
	return _getTimelinePaddingPxValue({
		containerWidth,
		zoomLevel,
		minZoom,
	});
}

export function sliderToZoom({
	sliderPosition,
	minZoom,
	maxZoom,
}: {
	sliderPosition: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	return _sliderToZoomValue({
		sliderPosition,
		minZoom,
		maxZoom,
	});
}

export function zoomToSlider({
	zoomLevel,
	minZoom,
	maxZoom,
}: {
	zoomLevel: number;
	minZoom: number;
	maxZoom?: number;
}): number {
	return _zoomToSliderValue({
		zoomLevel,
		minZoom,
		maxZoom,
	});
}
