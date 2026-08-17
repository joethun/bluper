import {
	addMediaTime,
	maxMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";
import { rippleShiftElements } from "@/ripple/shift";
import type { SceneTracks, TimelineTrack } from "./types";

/**
 * Empty space on one track that sits between two pieces of material — or between
 * the start of the timeline and the first clip. Space *after* the last clip is
 * deliberately not a gap: there is nothing on the far side of it to pull back, so
 * closing it would be a no-op.
 */
export interface TimelineGap {
	trackId: string;
	startTime: MediaTime;
	endTime: MediaTime;
}

function getGapDuration({ gap }: { gap: TimelineGap }): MediaTime {
	return subMediaTime({ a: gap.endTime, b: gap.startTime });
}

/**
 * The gap `time` falls inside, if any.
 *
 * Walks the track in start order carrying a high-water mark of how far material
 * reaches, so overlapping clips (which a track can hold while a transition is
 * being placed) close a gap rather than opening a phantom one behind them.
 */
export function findGapAtTime({
	track,
	time,
}: {
	track: TimelineTrack;
	time: MediaTime;
}): TimelineGap | null {
	const sortedElements = [...track.elements].sort(
		(first, second) => first.startTime - second.startTime,
	);

	let filledUntil: MediaTime = ZERO_MEDIA_TIME;
	for (const element of sortedElements) {
		if (element.startTime > filledUntil) {
			if (time >= filledUntil && time < element.startTime) {
				return {
					trackId: track.id,
					startTime: filledUntil,
					endTime: element.startTime,
				};
			}
		}

		filledUntil = maxMediaTime({
			a: filledUntil,
			b: addMediaTime({ a: element.startTime, b: element.duration }),
		});
	}

	return null;
}

/** Every gap on the track, in timeline order. */
export function findGaps({
	track,
}: {
	track: TimelineTrack;
}): TimelineGap[] {
	const sortedElements = [...track.elements].sort(
		(first, second) => first.startTime - second.startTime,
	);

	const gaps: TimelineGap[] = [];
	let filledUntil: MediaTime = ZERO_MEDIA_TIME;
	for (const element of sortedElements) {
		if (element.startTime > filledUntil) {
			gaps.push({
				trackId: track.id,
				startTime: filledUntil,
				endTime: element.startTime,
			});
		}

		filledUntil = maxMediaTime({
			a: filledUntil,
			b: addMediaTime({ a: element.startTime, b: element.duration }),
		});
	}

	return gaps;
}

function closeGapInTrack<
	TElement extends TimelineTrack["elements"][number],
	TTrack extends TimelineTrack & { elements: TElement[] },
>({
	track,
	gap,
}: {
	track: TTrack;
	gap: TimelineGap;
}): TTrack {
	if (track.id !== gap.trackId) {
		return track;
	}

	const shiftAmount = getGapDuration({ gap });
	if (shiftAmount <= 0) {
		return track;
	}

	return {
		...track,
		elements: rippleShiftElements({
			elements: track.elements,
			afterTime: gap.endTime,
			shiftAmount,
		}),
	};
}

/**
 * Pulls everything after the gap back over it, on that track alone.
 *
 * Only the one track moves. Closing a gap on every track at once would be a
 * different edit — it would slide unrelated material out of sync with the
 * picture it was cut against — so the caller asks for the track it clicked.
 */
export function closeGap({
	tracks,
	gap,
}: {
	tracks: SceneTracks;
	gap: TimelineGap;
}): SceneTracks {
	return {
		overlay: tracks.overlay.map((track) => closeGapInTrack({ track, gap })),
		main: closeGapInTrack({ track: tracks.main, gap }),
		audio: tracks.audio.map((track) => closeGapInTrack({ track, gap })),
	};
}

/**
 * Closes every gap on the track, oldest last so each shift is computed against
 * positions that have not moved yet.
 */
export function closeAllGaps({
	tracks,
	track,
}: {
	tracks: SceneTracks;
	track: TimelineTrack;
}): SceneTracks {
	const gaps = findGaps({ track });
	let nextTracks = tracks;
	// Later gaps first: closing an earlier one would move every gap behind it.
	for (const gap of [...gaps].reverse()) {
		nextTracks = closeGap({ tracks: nextTracks, gap });
	}
	return nextTracks;
}
