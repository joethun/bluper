import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import type {
	FreezableElement,
	SceneTracks,
	TimelineElement,
	TransitionableElement,
} from "@/timeline/types";
import { findTrackInSceneTracks } from "@/timeline/track-element-update";
import { readElementTransition, stripTransitionIn } from "@/transitions";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";
import {
	buildBakedStillElement,
	buildFrozenElement,
	getSourceTimeAtTimelineTime,
	isFreezableElement,
} from "./element";

export interface FreezeFrameIds {
	/** Id for the inserted still. */
	frozenElementId: string;
	/** Id for the tail the cut leaves behind; unused when the cut lands on an edge. */
	splitElementId: string;
}

/**
 * Cuts `elementId` at `freezeTime`, drops a held still into the cut, and slides
 * everything after it on that track right by the still's length — CapCut's
 * snowflake, as a pure function of the tracks.
 *
 * Returns `null` when the freeze does not apply: the element is gone, is not a
 * kind that can be frozen, or the playhead is outside it. Landing exactly on a
 * clip edge is fine; the still is inserted at that edge with nothing to cut.
 */
export function freezeFrameInTracks({
	tracks,
	trackId,
	elementId,
	freezeTime,
	freezeDuration,
	bakedMediaId,
	ids,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	freezeTime: MediaTime;
	freezeDuration: MediaTime;
	/**
	 * An image holding the already-rendered picture for this moment. Supplied when
	 * the freeze lands inside a transition, where the frame on screen is two clips
	 * blended and no single source frame can stand in for it.
	 */
	bakedMediaId?: string;
	ids: FreezeFrameIds;
}): SceneTracks | null {
	const track = findTrackInSceneTracks({ tracks, trackId });
	const element = track?.elements.find(
		(candidate) => candidate.id === elementId,
	);
	if (!track || !element || !isFreezableElement(element)) {
		return null;
	}

	const elementEnd = addMediaTime({
		a: element.startTime,
		b: element.duration,
	});
	if (freezeTime < element.startTime || freezeTime > elementEnd) {
		return null;
	}

	const frozen = bakedMediaId
		? buildBakedStillElement({
				element,
				mediaId: bakedMediaId,
				startTime: freezeTime,
				duration: freezeDuration,
				id: ids.frozenElementId,
			})
		: buildFrozenElement({
				element,
				sourceTime: getSourceTimeAtTimelineTime({ element, time: freezeTime }),
				startTime: freezeTime,
				duration: freezeDuration,
				id: ids.frozenElementId,
			});

	const rebuiltElements = track.elements.flatMap(
		(candidate): TimelineElement[] => {
			if (candidate.id !== elementId) {
				// Everything downstream of the insertion point shifts by the length
				// of the still, so the track keeps its original ordering and gaps.
				return candidate.startTime >= freezeTime
					? [
							{
								...candidate,
								startTime: addMediaTime({
									a: candidate.startTime,
									b: freezeDuration,
								}),
							},
						]
					: [candidate];
			}

			return buildSplitWithFreeze({
				element,
				frozen,
				freezeTime,
				freezeDuration,
				splitElementId: ids.splitElementId,
			});
		},
	);

	return replaceTrackElements({
		tracks,
		trackId,
		elements: rebuiltElements,
	});
}

function buildSplitWithFreeze({
	element,
	frozen,
	freezeTime,
	freezeDuration,
	splitElementId,
}: {
	element: FreezableElement;
	frozen: TransitionableElement;
	freezeTime: MediaTime;
	freezeDuration: MediaTime;
	splitElementId: string;
}): TimelineElement[] {
	const leftDuration = subMediaTime({ a: freezeTime, b: element.startTime });
	const rightDuration = subMediaTime({ a: element.duration, b: leftDuration });
	const rightStart = addMediaTime({ a: freezeTime, b: freezeDuration });

	// Freezing on the leading edge puts the still where the clip used to meet its
	// neighbour, so the transition that played there moves onto the still. Left on
	// the clip it would retarget itself to the boundary with the still — blending
	// a held frame into the very frame it was taken from, which looks like the
	// transition simply vanished.
	if (leftDuration <= 0) {
		const transitionIn = readElementTransition({ element });
		return [
			transitionIn ? { ...frozen, transitionIn } : frozen,
			stripTransitionIn({ element: { ...element, startTime: rightStart } }),
		];
	}

	if (rightDuration <= 0) {
		return [element, frozen];
	}

	// Snap the source-side split point once and derive the right half from it,
	// so `leftSourceSpan + rightSourceSpan == totalSourceSpan` holds exactly.
	// Rounding both spans independently can desynchronise them by a tick.
	const leftSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: leftDuration,
			clipDuration: element.duration,
			retime: element.retime,
		}),
	});
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: element.duration,
			clipDuration: element.duration,
			retime: element.retime,
		}),
	});
	const rightSourceSpan = subMediaTime({
		a: totalSourceSpan,
		b: leftSourceSpan,
	});
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: leftDuration,
		shouldIncludeSplitBoundary: true,
	});

	return [
		{
			...element,
			duration: leftDuration,
			trimEnd: addMediaTime({ a: element.trimEnd, b: rightSourceSpan }),
			animations: leftAnimations,
		},
		frozen,
		stripTransitionIn({
			element: {
				...element,
				id: splitElementId,
				startTime: rightStart,
				duration: rightDuration,
				trimStart: addMediaTime({ a: element.trimStart, b: leftSourceSpan }),
				animations: rightAnimations,
			},
		}),
	];
}

function replaceTrackElements({
	tracks,
	trackId,
	elements,
}: {
	tracks: SceneTracks;
	trackId: string;
	elements: TimelineElement[];
}): SceneTracks {
	const replace = <TTrack extends { id: string; elements: TimelineElement[] }>(
		track: TTrack,
	): TTrack =>
		track.id === trackId ? ({ ...track, elements } as TTrack) : track;

	return {
		overlay: tracks.overlay.map((track) => replace(track)),
		main: replace(tracks.main),
		audio: tracks.audio.map((track) => replace(track)),
	};
}
