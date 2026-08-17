import type { SceneTracks, TimelineTrack, TimelineElement } from "@/timeline";
import type { ComputeDropTargetParams, DropTarget } from "@/timeline";
import { resolveTrackPlacement } from "@/timeline/placement";
import { findTransitionCuts } from "@/transitions";
import { TIMELINE_TRACK_GAP_PX } from "./layout";
import { getTrackHeight } from "./track-layout";
import { mediaTime, type MediaTime, TICKS_PER_SECOND } from "@/wasm";

function findElementAtPosition({
	mouseX,
	tracks,
	trackIndex,
	targetElementTypes,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	tracks: TimelineTrack[];
	trackIndex: number;
	targetElementTypes: string[];
	pixelsPerSecond: number;
	zoomLevel: number;
}): { elementId: string; trackId: string } | null {
	const time = mediaTime({
		ticks: Math.round(
			(mouseX / (pixelsPerSecond * zoomLevel)) * TICKS_PER_SECOND,
		),
	});
	const track = tracks[trackIndex];
	if (!track || !("elements" in track)) return null;

	const hit = track.elements.find(
		(element: TimelineElement) =>
			targetElementTypes.includes(element.type) &&
			element.startTime <= time &&
			time < element.startTime + element.duration,
	);
	if (!hit) return null;
	return { elementId: hit.id, trackId: track.id };
}

function getTrackAtY({
	mouseY,
	tracks,
	verticalDragDirection,
}: {
	mouseY: number;
	tracks: TimelineTrack[];
	verticalDragDirection?: "up" | "down" | null;
}): { trackIndex: number; relativeY: number } | null {
	let cumulativeHeight = 0;

	for (let i = 0; i < tracks.length; i++) {
		const trackHeight = getTrackHeight({ type: tracks[i].type });
		const trackTop = cumulativeHeight;
		const trackBottom = trackTop + trackHeight;

		if (mouseY >= trackTop && mouseY < trackBottom) {
			return {
				trackIndex: i,
				relativeY: mouseY - trackTop,
			};
		}

		if (i < tracks.length - 1 && verticalDragDirection) {
			const gapTop = trackBottom;
			const gapBottom = gapTop + TIMELINE_TRACK_GAP_PX;
			if (mouseY >= gapTop && mouseY < gapBottom) {
				const isDraggingUp = verticalDragDirection === "up";
				return {
					trackIndex: isDraggingUp ? i : i + 1,
					relativeY: isDraggingUp ? trackHeight - 1 : 0,
				};
			}
		}

		cumulativeHeight += trackHeight + TIMELINE_TRACK_GAP_PX;
	}

	return null;
}

const EMPTY_TARGET_ELEMENT = null;

function fallbackNewTrackDropTarget({
	xPosition,
}: {
	xPosition: MediaTime;
}): DropTarget {
	return {
		trackIndex: 0,
		isNewTrack: true,
		insertPosition: null,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

/** How near the pointer has to be to a join for a transition to land on it. */
const TRANSITION_SNAP_PX = 28;

/**
 * Resolves the join a transition drag is over. A transition belongs to a cut
 * rather than to a clip, so the drag snaps to the nearest boundary between two
 * adjacent clips instead of hit-testing whichever clip is under the pointer —
 * dropping in the middle of a clip means nothing.
 */
export function computeTransitionDropTarget({
	mouseX,
	mouseY,
	tracks,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	pixelsPerSecond: number;
	zoomLevel: number;
}): DropTarget | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const trackAtMouse = getTrackAtY({ mouseY, tracks: orderedTracks });
	if (!trackAtMouse) {
		return null;
	}

	const track = orderedTracks[trackAtMouse.trackIndex];
	if (!track) {
		return null;
	}

	const pixelsPerTick = (pixelsPerSecond * zoomLevel) / TICKS_PER_SECOND;
	if (pixelsPerTick <= 0) {
		return null;
	}

	const cuts = findTransitionCuts({ track });
	let nearest: { cut: (typeof cuts)[number]; distancePx: number } | null = null;
	for (const cut of cuts) {
		const distancePx = Math.abs(cut.time * pixelsPerTick - mouseX);
		if (!nearest || distancePx < nearest.distancePx) {
			nearest = { cut, distancePx };
		}
	}

	if (!nearest || nearest.distancePx > TRANSITION_SNAP_PX) {
		return null;
	}

	return {
		trackIndex: trackAtMouse.trackIndex,
		isNewTrack: false,
		insertPosition: null,
		// The transition is stored on the later clip, so that is what the drop
		// names; the seam rides along for the indicator.
		xPosition: nearest.cut.time,
		seamTime: nearest.cut.time,
		targetElement: {
			trackId: nearest.cut.trackId,
			elementId: nearest.cut.incomingId,
		},
	};
}

export function computeDropTarget({
	elementType,
	mouseX,
	mouseY,
	tracks,
	playheadTime,
	isExternalDrop,
	elementDuration,
	pixelsPerSecond,
	zoomLevel,
	verticalDragDirection,
	startTimeOverride,
	excludeElementId,
	targetElementTypes,
	sourceTrackId,
}: ComputeDropTargetParams): DropTarget {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const xPosition =
		startTimeOverride !== undefined
			? startTimeOverride
			: isExternalDrop
				? playheadTime
				: mediaTime({
						ticks: Math.round(
							Math.max(0, mouseX / (pixelsPerSecond * zoomLevel)) *
								TICKS_PER_SECOND,
						),
					});

	if (orderedTracks.length === 0) {
		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: 0,
				hoverDirection: "below",
				createNewTrackOnly: true,
			},
			sourceTrackId,
		});
		const emptyTimelineResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!emptyTimelineResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: emptyTimelineResult.insertIndex,
			isNewTrack: true,
			insertPosition: emptyTimelineResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const trackAtMouse = getTrackAtY({
		mouseY,
		tracks: orderedTracks,
		verticalDragDirection,
	});

	if (!trackAtMouse) {
		const isAboveAllTracks = mouseY < 0;

		const placementResult = resolveTrackPlacement({
			tracks,
			elementType,
			timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
			strategy: {
				type: "preferIndex",
				trackIndex: isAboveAllTracks ? 0 : orderedTracks.length - 1,
				hoverDirection: isAboveAllTracks ? "above" : "below",
				createNewTrackOnly: true,
			},
			sourceTrackId,
		});
		const outOfBoundsResult =
			placementResult?.kind === "newTrack" ? placementResult : null;
		if (!outOfBoundsResult) {
			return fallbackNewTrackDropTarget({ xPosition });
		}

		return {
			trackIndex: outOfBoundsResult.insertIndex,
			isNewTrack: true,
			insertPosition: outOfBoundsResult.insertPosition,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	const { trackIndex, relativeY } = trackAtMouse;
	const track = orderedTracks[trackIndex];

	if (targetElementTypes && targetElementTypes.length > 0) {
		const targetElement = findElementAtPosition({
			mouseX,
			tracks: orderedTracks,
			trackIndex,
			targetElementTypes,
			pixelsPerSecond,
			zoomLevel,
		});
		if (targetElement) {
			return {
				trackIndex,
				isNewTrack: false,
				insertPosition: null,
				xPosition,
				targetElement,
			};
		}
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const placementResult = resolveTrackPlacement({
		tracks,
		elementType,
		timeSpans: [{ startTime: xPosition, duration: elementDuration, excludeElementId }],
		strategy: {
			type: "preferIndex",
			trackIndex,
			hoverDirection: relativeY < trackHeight / 2 ? "above" : "below",
			verticalDragDirection,
		},
		sourceTrackId,
	});
	if (!placementResult) {
		return fallbackNewTrackDropTarget({ xPosition });
	}

	if (placementResult.kind === "existingTrack") {
		return {
			trackIndex: placementResult.trackIndex,
			isNewTrack: false,
			insertPosition: null,
			xPosition,
			targetElement: EMPTY_TARGET_ELEMENT,
		};
	}

	return {
		trackIndex: placementResult.insertIndex,
		isNewTrack: true,
		insertPosition: placementResult.insertPosition,
		xPosition,
		targetElement: EMPTY_TARGET_ELEMENT,
	};
}

export function getDropLineY({
	dropTarget,
	tracks,
}: {
	dropTarget: DropTarget;
	tracks: TimelineTrack[];
}): number {
	const safeTrackIndex = Math.min(
		Math.max(dropTarget.trackIndex, 0),
		tracks.length,
	);
	let y = 0;

	for (let i = 0; i < safeTrackIndex; i++) {
		y += getTrackHeight({ type: tracks[i].type }) + TIMELINE_TRACK_GAP_PX;
	}

	return y;
}
