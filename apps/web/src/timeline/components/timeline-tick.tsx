"use client";

import { memo } from "react";
import type { FrameRate } from "bluper-wasm";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { formatRulerLabel } from "@/timeline/ruler-utils";

interface TimelineTickProps {
	time: number;
	timeInSeconds: number;
	zoomLevel: number;
	fps: FrameRate;
	showLabel: boolean;
}

/**
 * Memoised because the ruler re-renders on every scroll frame to recompute
 * which ticks are in view, while the ticks that stay in view are unchanged —
 * their props are the tick's own time and the zoom, neither of which a scroll
 * touches.
 */
export const TimelineTick = memo(function TimelineTick({
	time,
	timeInSeconds,
	zoomLevel,
	fps,
	showLabel,
}: TimelineTickProps) {
	const leftPosition = timelineTimeToSnappedPixels({ time, zoomLevel });

	if (showLabel) {
		const label = formatRulerLabel({ timeInSeconds, fps });
		return (
			<span
				className="text-muted-foreground/85 absolute top-1 select-none text-[10px] leading-none"
				style={{ left: `${leftPosition}px` }}
			>
				{label}
			</span>
		);
	}

	return (
		<div
			className="border-muted-foreground/25 absolute top-1.5 h-1.5 border-l select-none"
			style={{ left: `${leftPosition}px` }}
		/>
	);
});
