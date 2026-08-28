import { useMemo } from "react";
import { useScrollPosition } from "@/timeline/hooks/use-scroll-position";

/**
 * The horizontal slice of timeline content that is on screen, in content
 * pixels measured from time zero.
 */
export interface TimelinePixelWindow {
	startPx: number;
	endPx: number;
}

/**
 * How much extra content, as a fraction of the viewport width, is kept
 * rendered on each side of what is visible.
 *
 * Big enough that a flick-scroll lands on already-mounted clips instead of a
 * blank strip, small enough that the rendered count stays a small multiple of
 * what fits on screen.
 */
const OVERSCAN_VIEWPORTS = 0.75;

/**
 * The window used to decide which clips get rendered.
 *
 * The timeline is one absolutely-positioned strip per track, so total content
 * width grows with project duration and zoom while the number of clips a user
 * can actually see stays around a dozen. Rendering all of them made every
 * interaction cost scale with project size: each clip carries its own
 * subscriptions and a full context menu, so a zoom step on a few-hundred-clip
 * project re-rendered the lot and blocked the main thread for over a second.
 *
 * Windowing needs no extra machinery here because clip geometry is arithmetic
 * on `startTime`/`duration` and zoom — the same arithmetic that positions them
 * — so nothing has to be measured off the DOM. Box-select and snapping already
 * work from track data rather than rendered nodes, so they still see clips that
 * are not mounted.
 *
 * Returns `null` until the viewport has been measured, which renders
 * everything: a window computed from a zero width would mount nothing and
 * flash an empty timeline on first paint.
 */
export function useVisibleTimelineWindow({
	scrollRef,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
}): TimelinePixelWindow | null {
	const { scrollLeft, viewportWidth } = useScrollPosition({ scrollRef });

	return useMemo(() => {
		if (viewportWidth <= 0) return null;
		const overscan = viewportWidth * OVERSCAN_VIEWPORTS;
		return {
			startPx: scrollLeft - overscan,
			endPx: scrollLeft + viewportWidth + overscan,
		};
	}, [scrollLeft, viewportWidth]);
}
