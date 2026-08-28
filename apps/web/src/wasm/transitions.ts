import {
	canElementTypeHaveTransition as _canElementTypeHaveTransition,
	findTransitionCutAtTimeValue as _findTransitionCutAtTimeValue,
	findTransitionCutsOnTrack as _findTransitionCutsOnTrack,
	findTransitionsOnTrack as _findTransitionsOnTrack,
	getActiveTransitionBinding as _getActiveTransitionBinding,
	getTransitionBindingsForElement as _getTransitionBindingsForElement,
	getTransitionCutForElement as _getTransitionCutForElement,
	getTransitionRenderExtension as _getTransitionRenderExtension,
	stripTransitionInValue as _stripTransitionInValue,
} from "bluper-wasm";
import type {
	ElementType,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import type { ElementTransition } from "@/transitions/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Which cuts carry a transition, owned by `editor-core::transitions::pairing`.
 *
 * A transition is stored on the *incoming* clip and straddles the cut it shares
 * with the clip before it: the first half eats into the outgoing clip's tail, the
 * second half into the incoming clip's head. Neither clip's `startTime` or
 * `duration` changes and the project keeps its length — the overlap exists only
 * at render time, paid for out of the material each clip's trim is hiding.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

type TransitionRole = "outgoing" | "incoming";

interface TransitionPlacementSide {
	elementId: string;
	role: TransitionRole;
	/** How much of the window lies before the clip's own start. */
	headExtension: MediaTime;
	/** How much of the window lies after the clip's own end. */
	tailExtension: MediaTime;
}

/**
 * A stored transition resolved against the cut it joins — the window it occupies
 * and how each of the two clips should be drawn.
 */
export interface TransitionPlacement {
	trackId: string;
	transition: ElementTransition;
	outgoingId: string;
	incomingId: string;
	/** Clamped duration actually used — never longer than either clip allows. */
	duration: MediaTime;
	/** The longest this cut could carry, for whatever edits the length. */
	maxDuration: MediaTime;
	/** Timeline time of the cut the window straddles. */
	cut: MediaTime;
	windowStart: MediaTime;
	windowEnd: MediaTime;
	sides: TransitionPlacementSide[];
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

/**
 * A transition bound to one concrete clip, ready for the renderer: the absolute
 * timeline window plus which side of it this clip plays.
 */
export interface TransitionBinding {
	transition: ElementTransition;
	role: TransitionRole;
	windowStart: MediaTime;
	windowEnd: MediaTime;
	headExtension: MediaTime;
	tailExtension: MediaTime;
}

/**
 * Only clips with footage of their own take part in a cut. A text clip butted
 * against a video does not make a cut — it is composited over one.
 */
export function canElementHaveTransition({
	element,
}: {
	element: Pick<TimelineElement, "type">;
}): boolean {
	return _canElementTypeHaveTransition({
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		elementType: element.type as ElementType as never,
	});
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
	const stripped: unknown = _stripTransitionInValue(
		wasmArgs({ args: { element } }),
	).element;
	// Removing an optional property leaves the same element type; TypeScript
	// cannot see that through the generic, which is the only reason to assert.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return stripped as TElement;
}

/** Every transition on a track that currently joins two adjacent clips. */
export function findTransitions({
	track,
}: {
	track: TimelineTrack;
}): TransitionPlacement[] {
	const { placements }: { placements: unknown } = _findTransitionsOnTrack(
		wasmArgs({ args: { track } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return placements as TransitionPlacement[];
}

/**
 * A `None` on the Rust side arrives as `undefined`, and the field is declared
 * nullable because that is what the callers test against.
 */
function withNullTransition({ cut }: { cut: TransitionCut }): TransitionCut {
	return { ...cut, transition: cut.transition ?? null };
}

/** Every junction on a track that two clips share, in timeline order. */
export function findTransitionCuts({
	track,
}: {
	track: TimelineTrack;
}): TransitionCut[] {
	const { cuts }: { cuts: unknown } = _findTransitionCutsOnTrack(
		wasmArgs({ args: { track } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (cuts as TransitionCut[]).map((cut) => withNullTransition({ cut }));
}

/** The cut at a clip's leading edge, if it shares one with the clip before it. */
export function getTransitionCutForElement({
	track,
	elementId,
}: {
	track: TimelineTrack;
	elementId: string;
}): TransitionCut | null {
	const { cut }: { cut: unknown } = _getTransitionCutForElement(
		wasmArgs({ args: { track, elementId } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const found = cut as TransitionCut | undefined;
	return found ? withNullTransition({ cut: found }) : null;
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
	const { cut }: { cut: unknown } = _findTransitionCutAtTimeValue(
		wasmArgs({
			args: {
				tracks,
				time,
				toleranceTicks,
				preferredTrackId: preferredTrackId ?? undefined,
			},
		}),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const found = cut as TransitionCut | undefined;
	return found ? withNullTransition({ cut: found }) : null;
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
	const { bindings }: { bindings: unknown } =
		_getTransitionBindingsForElement(
			wasmArgs({ args: { placements, elementId } }),
		);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return bindings as TransitionBinding[];
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
	const extension: unknown = _getTransitionRenderExtension(
		wasmArgs({ args: { bindings } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return extension as { head: MediaTime; tail: MediaTime };
}

/**
 * The binding covering an instant, or `null` outside every window. Half-open, so
 * the tick a window ends on already belongs to the plain clip.
 *
 * The time is a tick count rather than a `MediaTime` because the renderer asks
 * this per frame with whatever instant it is drawing, which a seek can leave
 * between two ticks.
 */
export function getActiveTransitionBinding({
	bindings,
	time,
}: {
	bindings: TransitionBinding[];
	time: number;
}): TransitionBinding | null {
	const { binding }: { binding: unknown } = _getActiveTransitionBinding(
		wasmArgs({ args: { bindings, time } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (binding as TransitionBinding | undefined) ?? null;
}
