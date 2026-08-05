import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import { TRANSITIONABLE_ELEMENT_TYPES } from "@/timeline/types";
import type {
	ElementTransition,
	TransitionBinding,
	TransitionPlacement,
} from "@/transitions/types";
import {
	addMediaTime,
	mediaTime,
	minMediaTime,
	roundMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";

/**
 * Two clips count as sharing a cut when they butt up against each other. A tick
 * or two of slack absorbs the rounding that resizing and frame-snapping leave
 * behind, without letting a real (audible/visible) gap carry a transition.
 */
const MAX_CUT_GAP_TICKS = Math.max(1, Math.round(TICKS_PER_SECOND / 1000));

export function canElementHaveTransition({
	element,
}: {
	element: Pick<TimelineElement, "type">;
}): boolean {
	return (TRANSITIONABLE_ELEMENT_TYPES as readonly string[]).includes(
		element.type,
	);
}

export function readElementTransition({
	element,
}: {
	element: TimelineElement;
}): ElementTransition | undefined {
	return "transitionIn" in element ? element.transitionIn : undefined;
}

/**
 * Drops the incoming-side transition from an element. Splitting a clip invents a
 * boundary that never had a transition, so the trailing half must not inherit
 * the one that belonged to the original clip's start.
 */
export function stripTransitionIn<TElement extends TimelineElement>({
	element,
}: {
	element: TElement;
}): TElement {
	if (!("transitionIn" in element) || element.transitionIn === undefined) {
		return element;
	}

	const { transitionIn: _removed, ...rest } = element;
	// Removing an optional property leaves the same element type; TypeScript
	// cannot see that through the generic, which is the only reason to assert.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return rest as TElement;
}

function sortedElements({
	track,
}: {
	track: TimelineTrack;
}): TimelineElement[] {
	return [...track.elements].sort((a, b) => {
		if (a.startTime !== b.startTime) return a.startTime - b.startTime;
		return a.id.localeCompare(b.id);
	});
}

function elementEnd({ element }: { element: TimelineElement }): MediaTime {
	return addMediaTime({ a: element.startTime, b: element.duration });
}

/**
 * Whether two clips meet at a cut a transition can bridge. Both have to be a
 * kind that carries transitions — a text clip butted against a video does not
 * make a cut, it is composited over one.
 */
function isPaired({
	outgoing,
	incoming,
}: {
	outgoing: TimelineElement | undefined;
	incoming: TimelineElement | undefined;
}): boolean {
	if (!outgoing || !incoming) return false;
	if (
		!canElementHaveTransition({ element: outgoing }) ||
		!canElementHaveTransition({ element: incoming })
	) {
		return false;
	}

	const gap = Math.abs(incoming.startTime - elementEnd({ element: outgoing }));
	return gap <= MAX_CUT_GAP_TICKS;
}

/**
 * A transition may not outrun either clip it joins: each half eats into one
 * neighbour, and eating past a clip's far edge would leave the transition
 * overlapping a third clip.
 */
export function clampTransitionDuration({
	duration,
	outgoingDuration,
	incomingDuration,
}: {
	duration: MediaTime;
	outgoingDuration: MediaTime;
	incomingDuration: MediaTime;
}): MediaTime {
	const neighbourLimit = minMediaTime({
		a: outgoingDuration,
		b: incomingDuration,
	});
	return minMediaTime({ a: duration, b: neighbourLimit });
}

function buildPlacement({
	trackId,
	outgoing,
	incoming,
	transition,
}: {
	trackId: string;
	outgoing: TimelineElement;
	incoming: TimelineElement;
	transition: ElementTransition;
}): TransitionPlacement | null {
	const duration = clampTransitionDuration({
		duration: transition.duration,
		outgoingDuration: outgoing.duration,
		incomingDuration: incoming.duration,
	});
	if (duration <= 0) {
		return null;
	}

	const half = roundMediaTime({ time: duration / 2 });
	const cut = incoming.startTime;
	const windowStart = subMediaTime({ a: cut, b: half });
	const windowEnd = addMediaTime({
		a: cut,
		b: subMediaTime({ a: duration, b: half }),
	});

	return {
		trackId,
		transition,
		outgoingId: outgoing.id,
		incomingId: incoming.id,
		duration,
		maxDuration: minMediaTime({
			a: outgoing.duration,
			b: incoming.duration,
		}),
		cut,
		windowStart,
		windowEnd,
		sides: [
			{
				elementId: outgoing.id,
				role: "outgoing",
				headExtension: ZERO_MEDIA_TIME,
				// The window runs past where this clip ends.
				tailExtension: subMediaTime({ a: windowEnd, b: cut }),
			},
			{
				elementId: incoming.id,
				role: "incoming",
				// The window opens before this clip does.
				headExtension: subMediaTime({ a: cut, b: windowStart }),
				tailExtension: ZERO_MEDIA_TIME,
			},
		],
	};
}

/** Every transition on a track that currently joins two adjacent clips. */
export function findTransitions({
	track,
}: {
	track: TimelineTrack;
}): TransitionPlacement[] {
	const elements = sortedElements({ track });
	const placements: TransitionPlacement[] = [];

	for (let index = 1; index < elements.length; index++) {
		const incoming = elements[index];
		const transition = readElementTransition({ element: incoming });
		if (!transition) {
			continue;
		}

		const outgoing = elements[index - 1];
		if (!isPaired({ outgoing, incoming })) {
			continue;
		}

		const placement = buildPlacement({
			trackId: track.id,
			outgoing,
			incoming,
			transition,
		});
		if (placement) {
			placements.push(placement);
		}
	}

	return placements;
}

/** A cut a transition could be dropped on, whether or not one is there yet. */
export interface TransitionCut {
	trackId: string;
	outgoingId: string;
	incomingId: string;
	/** Timeline time the two clips meet at. */
	time: MediaTime;
	/** The longest transition this cut can carry. */
	maxDuration: MediaTime;
	transition: ElementTransition | null;
}

/** Every junction on a track that two clips share, in timeline order. */
export function findTransitionCuts({
	track,
}: {
	track: TimelineTrack;
}): TransitionCut[] {
	const elements = sortedElements({ track });
	const cuts: TransitionCut[] = [];

	for (let index = 1; index < elements.length; index++) {
		const incoming = elements[index];
		const outgoing = elements[index - 1];
		if (!isPaired({ outgoing, incoming })) {
			continue;
		}

		cuts.push({
			trackId: track.id,
			outgoingId: outgoing.id,
			incomingId: incoming.id,
			time: incoming.startTime,
			maxDuration: minMediaTime({
				a: outgoing.duration,
				b: incoming.duration,
			}),
			transition: readElementTransition({ element: incoming }) ?? null,
		});
	}

	return cuts;
}

/** The cut at a clip's leading edge, if it shares one with the clip before it. */
export function getTransitionCutForElement({
	track,
	elementId,
}: {
	track: TimelineTrack;
	elementId: string;
}): TransitionCut | null {
	return (
		findTransitionCuts({ track }).find((cut) => cut.incomingId === elementId) ??
		null
	);
}

/**
 * The join the playhead is parked on, across every track.
 *
 * A transition drag hit-tests the pointer, but the transition browser's add
 * button has only a playhead. A cut is a single instant, so landing on one to the
 * tick would be luck — the caller passes the slack it will accept rather than
 * this guessing at a pixel distance it cannot see.
 */
export function findTransitionCutAtTime({
	tracks,
	time,
	toleranceTicks,
	preferredTrackId,
}: {
	tracks: SceneTracks;
	time: MediaTime;
	toleranceTicks: number;
	preferredTrackId?: string | null;
}): TransitionCut | null {
	// The same order the transition drop target scans in, so the button and a drag
	// agree on which track wins when two are cut at the same instant.
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const candidates: Array<{ cut: TransitionCut; distance: number }> = [];

	for (const track of orderedTracks) {
		for (const cut of findTransitionCuts({ track })) {
			const distance = Math.abs(cut.time - time);
			if (distance <= toleranceTicks) {
				candidates.push({ cut, distance });
			}
		}
	}

	if (candidates.length === 0) {
		return null;
	}

	// A cut on the track already being worked in beats a nearer one elsewhere;
	// failing that the closest wins, and track order settles a tie.
	const preferred = candidates.filter(
		(candidate) => candidate.cut.trackId === preferredTrackId,
	);
	const pool = preferred.length > 0 ? preferred : candidates;
	return pool.reduce((best, candidate) =>
		candidate.distance < best.distance ? candidate : best,
	).cut;
}

/** The longest transition the cut at a clip's leading edge can carry. */
export function getMaxTransitionDuration({
	track,
	elementId,
}: {
	track: TimelineTrack;
	elementId: string;
}): MediaTime | null {
	return getTransitionCutForElement({ track, elementId })?.maxDuration ?? null;
}

/**
 * Whether the transition stored on this clip currently has a cut to play over.
 * The stored value outlives the cut — dragging the previous clip away leaves the
 * transition on the element with nothing to bridge — so anything that reports
 * transition state to the user has to ask about the cut, not the field.
 */
export function hasActiveTransition({
	track,
	elementId,
}: {
	track: TimelineTrack;
	elementId: string;
}): boolean {
	return findTransitions({ track }).some(
		(placement) => placement.incomingId === elementId,
	);
}

/**
 * The bindings that affect one element. A clip can be the incoming side of the
 * transition on its own leading edge and the outgoing side of the next clip's;
 * their windows can touch but never overlap, because each half is capped at half
 * the clip's duration.
 */
export function getTransitionBindingsForElement({
	placements,
	elementId,
}: {
	placements: TransitionPlacement[];
	elementId: string;
}): TransitionBinding[] {
	const bindings: TransitionBinding[] = [];

	for (const placement of placements) {
		for (const side of placement.sides) {
			if (side.elementId !== elementId) {
				continue;
			}
			bindings.push({
				transition: { ...placement.transition, duration: placement.duration },
				role: side.role,
				windowStart: placement.windowStart,
				windowEnd: placement.windowEnd,
				headExtension: side.headExtension,
				tailExtension: side.tailExtension,
			});
		}
	}

	return bindings;
}

/**
 * How far a clip's render window has to grow so both sides of its transitions
 * have pixels to show.
 */
export function getTransitionRenderExtension({
	bindings,
}: {
	bindings: TransitionBinding[];
}): { head: MediaTime; tail: MediaTime } {
	let head = 0;
	let tail = 0;

	for (const binding of bindings) {
		head = Math.max(head, binding.headExtension);
		tail = Math.max(tail, binding.tailExtension);
	}

	return { head: mediaTime({ ticks: head }), tail: mediaTime({ ticks: tail }) };
}

export function getActiveTransitionBinding({
	bindings,
	time,
}: {
	bindings: TransitionBinding[];
	time: number;
}): TransitionBinding | null {
	for (const binding of bindings) {
		if (time >= binding.windowStart && time < binding.windowEnd) {
			return binding;
		}
	}
	return null;
}
