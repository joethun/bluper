import type { SceneTracks, TimelineElement } from "@/timeline";
import { updateTrackInSceneTracks } from "./track-element-update";
import { addMediaTime, type MediaTime, subMediaTime } from "@/wasm";

/**
 * Slides the clips after `element` along, far enough that a clip which has just
 * grown does not sit on top of its neighbour.
 *
 * A speed change is the case that needs this: it derives a new length from the
 * material the clip holds, so slowing a clip down makes it longer without anyone
 * having dragged an edge. Resizing has a neighbour to stop against, but a speed
 * has to be honoured — the clip is as long as its own footage says it is, so the
 * timeline is what gives way.
 *
 * Only the overlap is taken up, never the whole growth: clips further down the
 * track keep the spacing they were given, and a clip with room ahead of it does
 * not shove a distant neighbour for no reason. A clip that shrinks leaves a gap
 * rather than dragging its neighbours back — closing gaps is ripple editing's
 * job, and it is a setting the user turns on.
 */
export function shiftElementsClearOfElement({
	tracks,
	trackId,
	element,
}: {
	tracks: SceneTracks;
	trackId: string;
	element: TimelineElement;
}): SceneTracks {
	const elementEnd = addMediaTime({
		a: element.startTime,
		b: element.duration,
	});

	return updateTrackInSceneTracks({
		tracks,
		trackId,
		update: (track) => {
			let firstFollowingStart: MediaTime | null = null;
			for (const candidate of track.elements) {
				if (candidate.id === element.id) continue;
				if (candidate.startTime <= element.startTime) continue;
				if (
					firstFollowingStart === null ||
					candidate.startTime < firstFollowingStart
				) {
					firstFollowingStart = candidate.startTime;
				}
			}

			if (firstFollowingStart === null || firstFollowingStart >= elementEnd) {
				return track;
			}

			const shiftAmount = subMediaTime({
				a: elementEnd,
				b: firstFollowingStart,
			});
			const shiftFrom = firstFollowingStart;

			return {
				...track,
				elements: track.elements.map((candidate) =>
					candidate.id !== element.id && candidate.startTime >= shiftFrom
						? {
								...candidate,
								startTime: addMediaTime({
									a: candidate.startTime,
									b: shiftAmount,
								}),
							}
						: candidate,
				),
			};
		},
	});
}
