import {
	getCenteredLineLeftValue as _getCenteredLineLeftValue,
	getTimelinePixelsPerSecondValue as _getTimelinePixelsPerSecondValue,
	timelinePixelsToTimeValue as _timelinePixelsToTimeValue,
	timelineTimeToPixelsValue as _timelineTimeToPixelsValue,
	timelineTimeToSnappedPixelsValue as _timelineTimeToSnappedPixelsValue,
} from "bluper-wasm";
import { mediaTime, type MediaTime } from "@/wasm/media-time";

/**
 * Timeline content-space math — pixel/second conversion, snapping to the
 * device pixel grid, indicator-line centering. Owned by
 * `editor-core::timeline::pixel_utils`. The TS-side originals were thin
 * numeric recipes over the same constants; the Rust side keeps the bit
 * pattern identical so a slider snapped at a sub-pixel stays snapped.
 */

export const TIMELINE_INDICATOR_LINE_WIDTH_PX = 2;

export function getTimelinePixelsPerSecond({
	zoomLevel,
}: {
	zoomLevel: number;
}): number {
	return _getTimelinePixelsPerSecondValue({ zoomLevel });
}

export function timelineTimeToPixels({
	time,
	zoomLevel,
}: {
	time: number;
	zoomLevel: number;
}): number {
	return _timelineTimeToPixelsValue({ time, zoomLevel });
}

export function timelinePixelsToTime({
	pixels,
	zoomLevel,
}: {
	pixels: number;
	zoomLevel: number;
}): MediaTime {
	return mediaTime({
		ticks: _timelinePixelsToTimeValue({ pixels, zoomLevel }).time,
	});
}

export function timelineTimeToSnappedPixels({
	time,
	zoomLevel,
	devicePixelRatio,
}: {
	time: number;
	zoomLevel: number;
	devicePixelRatio?: number;
}): number {
	return _timelineTimeToSnappedPixelsValue({
		time,
		zoomLevel,
		devicePixelRatio,
	});
}

export function getCenteredLineLeft({
	centerPixel,
	lineWidthPx,
}: {
	centerPixel: number;
	lineWidthPx?: number;
}): number {
	return _getCenteredLineLeftValue({
		centerPixel,
		lineWidthPx: lineWidthPx ?? TIMELINE_INDICATOR_LINE_WIDTH_PX,
	});
}