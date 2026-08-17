import type { SceneTracks } from "@/timeline";
import { buildTimelineSnapPoints, type SnapPoint } from "@/timeline/snapping";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import type { MediaTime } from "@/wasm";

/**
 * Snap candidates for a gesture that drags or resizes elements: every other
 * element's edges, the playhead, and every other element's animation keyframes.
 *
 * Building this walks every track, element and keyframe in the scene, so
 * gestures that resolve snap on each mousemove should build it once and reuse
 * it — none of its inputs can change while a gesture is in flight.
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
	return buildTimelineSnapPoints({
		sources: [
			() => getElementEdgeSnapPoints({ tracks, excludeElementIds }),
			() => getPlayheadSnapPoints({ playheadTime }),
			() =>
				getAnimationKeyframeSnapPointsForTimeline({
					tracks,
					excludeElementIds,
				}),
		],
	});
}
