import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { roundMediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";

export const TIMELINE_INDICATOR_LINE_WIDTH_PX = 2;

function getDevicePixelRatio({
	devicePixelRatio,
}: {
	devicePixelRatio?: number;
}): number {
	if (
		typeof devicePixelRatio === "number" &&
		Number.isFinite(devicePixelRatio) &&
		devicePixelRatio > 0
	) {
		return devicePixelRatio;
	}

	if (typeof window === "undefined") {
		return 1;
	}

	if (Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0) {
		return window.devicePixelRatio;
	}

	return 1;
}

export function getTimelinePixelsPerSecond({
	zoomLevel,
}: {
	zoomLevel: number;
}): number {
	return BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
}

export function timelineTimeToPixels({
	time,
	zoomLevel,
}: {
	time: number;
	zoomLevel: number;
}): number {
	return (time / TICKS_PER_SECOND) * getTimelinePixelsPerSecond({ zoomLevel });
}

/**
 * Inverse of {@link timelineTimeToPixels}. `pixels` is measured in timeline
 * content space — from the left edge of the scrolled content, not the viewport —
 * so callers that read a mouse position off a full-width row need no scroll
 * correction.
 */
export function timelinePixelsToTime({
	pixels,
	zoomLevel,
}: {
	pixels: number;
	zoomLevel: number;
}): MediaTime {
	const seconds = pixels / getTimelinePixelsPerSecond({ zoomLevel });
	return roundMediaTime({ time: Math.max(0, seconds) * TICKS_PER_SECOND });
}

function snapPixelToDeviceGrid({
	pixel,
	devicePixelRatio,
}: {
	pixel: number;
	devicePixelRatio?: number;
}): number {
	const safeDevicePixelRatio = getDevicePixelRatio({ devicePixelRatio });
	return Math.round(pixel * safeDevicePixelRatio) / safeDevicePixelRatio;
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
	const rawPixel = timelineTimeToPixels({ time, zoomLevel });
	return snapPixelToDeviceGrid({ pixel: rawPixel, devicePixelRatio });
}

export function getCenteredLineLeft({
	centerPixel,
	lineWidthPx = TIMELINE_INDICATOR_LINE_WIDTH_PX,
}: {
	centerPixel: number;
	lineWidthPx?: number;
}): number {
	return centerPixel - lineWidthPx / 2;
}
