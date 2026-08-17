import type { SceneTracks } from "@/timeline";
import {
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { buildElementGestureSnapPoints } from "@/timeline/gesture-snap-points";
import type { MoveGroup } from "./types";
import { addMediaTime, type MediaTime, subMediaTime } from "@/wasm";

/**
 * Snap candidates for a group move, excluding the members being dragged.
 * Callers that resolve snap every mousemove should build this once at gesture
 * start — the inputs are fixed for the duration of the drag — and pass it to
 * `resolveGroupMoveSnap`.
 */
export function buildGroupMoveSnapPoints({
	group,
	tracks,
	playheadTime,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	playheadTime: MediaTime;
}): SnapPoint[] {
	return buildElementGestureSnapPoints({
		tracks,
		playheadTime,
		excludeElementIds: new Set(
			group.members.map((member) => member.elementId),
		),
	});
}

/**
 * Resolve snap against a pre-built snap point list, returning the anchor start
 * time that puts whichever group edge is closest to a candidate onto it.
 */
export function resolveGroupMoveSnap({
	group,
	anchorStartTime,
	snapPoints,
	zoomLevel,
}: {
	group: MoveGroup;
	anchorStartTime: MediaTime;
	snapPoints: SnapPoint[];
	zoomLevel: number;
}): {
	snappedAnchorStartTime: MediaTime;
	snapPoint: SnapPoint | null;
} {
	const maxSnapDistance = getTimelineSnapThresholdInTicks({ zoomLevel });

	let closestSnapDistance = Infinity;
	let snappedAnchorStartTime = anchorStartTime;
	let snapPoint: SnapPoint | null = null;

	for (const member of group.members) {
		const memberStartTime = addMediaTime({
			a: anchorStartTime,
			b: member.timeOffset,
		});
		const memberStartSnap = resolveTimelineSnap({
			targetTime: memberStartTime,
			snapPoints,
			maxSnapDistance,
		});
		if (
			memberStartSnap.snapPoint &&
			memberStartSnap.snapDistance < closestSnapDistance
		) {
			closestSnapDistance = memberStartSnap.snapDistance;
			snappedAnchorStartTime = subMediaTime({
				a: memberStartSnap.snappedTime,
				b: member.timeOffset,
			});
			snapPoint = memberStartSnap.snapPoint;
		}

		const memberEndSnap = resolveTimelineSnap({
			targetTime: addMediaTime({
				a: memberStartTime,
				b: member.duration,
			}),
			snapPoints,
			maxSnapDistance,
		});
		if (
			memberEndSnap.snapPoint &&
			memberEndSnap.snapDistance < closestSnapDistance
		) {
			closestSnapDistance = memberEndSnap.snapDistance;
			snappedAnchorStartTime = subMediaTime({
				a: subMediaTime({
					a: memberEndSnap.snappedTime,
					b: member.duration,
				}),
				b: member.timeOffset,
			});
			snapPoint = memberEndSnap.snapPoint;
		}
	}

	return {
		snappedAnchorStartTime,
		snapPoint,
	};
}
