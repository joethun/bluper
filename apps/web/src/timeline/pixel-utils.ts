import {
	TIMELINE_INDICATOR_LINE_WIDTH_PX as _TIMELINE_INDICATOR_LINE_WIDTH_PX,
	getCenteredLineLeft,
	getTimelinePixelsPerSecond,
	timelinePixelsToTime,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/wasm/pixel-utils";

/**
 * Timeline content-space math, owned by `editor-core::timeline::pixel_utils`.
 * The TS-side originals were thin numeric recipes over the same constants;
 * the Rust side keeps the bit pattern identical so a slider snapped at a
 * sub-pixel stays snapped.
 *
 * Re-exported as-is so the existing call sites keep their import shape.
 */

export const TIMELINE_INDICATOR_LINE_WIDTH_PX = _TIMELINE_INDICATOR_LINE_WIDTH_PX;

export {
	getCenteredLineLeft,
	getTimelinePixelsPerSecond,
	timelinePixelsToTime,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
};
