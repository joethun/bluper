import {
	buildTimelineSnapPointsValue as _buildTimelineSnapPointsValue,
	getTimelineSnapThresholdInTicks as _getTimelineSnapThresholdInTicks,
	resolveTimelineSnapValue as _resolveTimelineSnapValue,
} from "bluper-wasm";
import type { Bookmark, SceneTracks } from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Snapping, now owned by `editor-core::timeline::snapping`.
 *
 * A gesture collects candidates once and resolves against them on each
 * mousemove: collecting walks every track, element and keyframe in the scene,
 * and none of that can change while a gesture is in flight. Building on every
 * move is what made dragging a clip in a long project stutter.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

type SnapPointType =
	| "element-start"
	| "element-end"
	| "playhead"
	| "bookmark"
	| "keyframe";

export interface SnapPoint {
	time: MediaTime;
	type: SnapPointType;
	elementId?: string;
	trackId?: string;
}

interface SnapResult {
	snappedTime: MediaTime;
	snapPoint: SnapPoint | null;
	snapDistance: number;
}

const DEFAULT_TIMELINE_SNAP_THRESHOLD_PX = 10;

/** How far a drag can be from a candidate and still snap to it, in ticks. */
export function getTimelineSnapThresholdInTicks({
	zoomLevel,
	snapThresholdPx = DEFAULT_TIMELINE_SNAP_THRESHOLD_PX,
}: {
	zoomLevel: number;
	snapThresholdPx?: number;
}): number {
	return _getTimelineSnapThresholdInTicks({ zoomLevel, snapThresholdPx });
}

export function resolveTimelineSnap({
	targetTime,
	snapPoints,
	maxSnapDistance,
}: {
	targetTime: MediaTime;
	snapPoints: SnapPoint[];
	maxSnapDistance: number;
}): SnapResult {
	const result: unknown = _resolveTimelineSnapValue(
		wasmArgs({ args: { targetTime, snapPoints, maxSnapDistance } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const snapResult = result as {
		snappedTime: MediaTime;
		snapPoint?: SnapPoint;
		snapDistance: number;
	};
	return {
		snappedTime: snapResult.snappedTime,
		snapPoint: snapResult.snapPoint ?? null,
		snapDistance: snapResult.snapDistance,
	};
}

/**
 * Everything a gesture can snap to, in the order that decides ties: element
 * edges, then the playhead, then bookmarks, then keyframes.
 *
 * Leave `playheadTime` out while the playhead itself is being dragged, and
 * `bookmarks` out for a gesture bookmarks should not pull on.
 */
export function buildTimelineSnapPoints({
	tracks,
	playheadTime,
	bookmarks,
	excludeBookmarkTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	playheadTime?: MediaTime;
	bookmarks?: Bookmark[];
	excludeBookmarkTime?: MediaTime;
	excludeElementIds?: Set<string>;
}): SnapPoint[] {
	const { snapPoints }: { snapPoints: unknown } = _buildTimelineSnapPointsValue(
		wasmArgs({
			args: {
				tracks,
				playheadTime,
				bookmarks,
				excludeBookmarkTime,
				excludeElementIds: excludeElementIds ? [...excludeElementIds] : [],
			},
		}),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return snapPoints as SnapPoint[];
}

/**
 * The candidates a drag or resize of elements uses: every other element's edges,
 * the playhead, and every other element's keyframes.
 */
export function buildElementGestureSnapPoints({
	tracks,
	playheadTime,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	playheadTime: MediaTime;
	excludeElementIds: Set<string>;
}): SnapPoint[] {
	return buildTimelineSnapPoints({ tracks, playheadTime, excludeElementIds });
}
