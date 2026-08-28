"use client";

import { useCallback, useMemo } from "react";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import { timelineTimeToPixels } from "@/timeline";
import type { ElementDragView } from "@/timeline";
import { findTransitions } from "@/transitions";
import { TransitionMarker } from "@/transitions/components/transition-marker";
import type { MediaTime } from "@/wasm";
import type { TimelinePixelWindow } from "./visible-window";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
	/** Set while a transition is being dragged over a join on this track. */
	seamTime?: MediaTime | null;
	/**
	 * The horizontal slice of the timeline that is on screen, in content pixels.
	 * Clips outside it are not rendered. `null` before the viewport has been
	 * measured, which renders everything.
	 */
	visibleWindow?: TimelinePixelWindow | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
	seamTime = null,
	visibleWindow = null,
}: TimelineTrackContentProps) {
	const { isElementSelected } = useElementSelection();

	// Stable per track, so a parent re-render does not hand every clip a fresh
	// set of callbacks and defeat `TimelineElement`'s memoisation. None of these
	// close over the mapped element — each takes it from its own arguments — so
	// hoisting them out of the map changes nothing about what they do.
	const handleResizeStart = useCallback<
		React.ComponentProps<typeof TimelineElement>["onResizeStart"]
	>(
		({ event, element, side }) => onResizeStart({ event, element, track, side }),
		[onResizeStart, track],
	);
	const handleElementMouseDown = useCallback<
		React.ComponentProps<typeof TimelineElement>["onElementMouseDown"]
	>(
		({ event, element }) => onElementMouseDown({ event, element, track }),
		[onElementMouseDown, track],
	);
	const handleElementClick = useCallback<
		React.ComponentProps<typeof TimelineElement>["onElementClick"]
	>(
		({ event, element }) => onElementClick({ event, element, track }),
		[onElementClick, track],
	);

	const transitions = useMemo(() => findTransitions({ track }), [track]);

	// A clip being dragged is drawn at the cursor rather than at its stored
	// start time, so the window test — which reads the stored time — cannot
	// judge it. Edge auto-scroll can also carry the pointer past where the clip
	// came from, so keep every drag member rendered for the whole gesture.
	const draggingElementIds =
		dragView.kind === "dragging" ? dragView.memberTimeOffsets : null;

	const visibleElements = useMemo(() => {
		if (!visibleWindow) return track.elements;
		return track.elements.filter((element) => {
			if (draggingElementIds?.has(element.id)) return true;
			const left = timelineTimeToPixels({
				time: element.startTime,
				zoomLevel,
			});
			const right =
				left +
				timelineTimeToPixels({ time: element.duration, zoomLevel });
			return right >= visibleWindow.startPx && left <= visibleWindow.endPx;
		});
	}, [track.elements, visibleWindow, zoomLevel, draggingElementIds]);

	return (
		<div className="relative size-full select-none">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0 select-none"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full select-none"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{transitions.map((placement) => (
					<TransitionMarker
						key={`${placement.outgoingId}:${placement.incomingId}`}
						trackId={track.id}
						placement={placement}
						zoomLevel={zoomLevel}
					/>
				))}
				{seamTime !== null ? (
					<div
						aria-hidden
						className="bg-primary pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full"
						style={{
							left: timelineTimeToPixels({ time: seamTime, zoomLevel }),
							zIndex: TIMELINE_LAYERS.trackContent + 1,
						}}
					/>
				) : null}
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					visibleElements.map((element) => {
						const isSelected = isElementSelected({
							trackId: track.id,
							elementId: element.id,
						});

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={handleResizeStart}
								onElementMouseDown={handleElementMouseDown}
								onElementClick={handleElementClick}
								dragView={dragView}
								isDropTarget={element.id === targetElementId}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
