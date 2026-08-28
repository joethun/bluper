import {
	applyElementUpdate as _applyElementUpdate,
	closeAllGaps as _closeAllGaps,
	closeGap as _closeGap,
	expandToGroups as _expandToGroups,
	findGapAtTime as _findGapAtTime,
	findGaps as _findGaps,
	removeWithGroups as _removeWithGroups,
} from "bluper-wasm";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Element updates, now owned by `editor-core::timeline::update_pipeline`.
 *
 * The element crosses untyped — `TimelineElement` uses `#[serde(flatten)]` in
 * Rust, which tsify cannot render as valid TypeScript — so the typing lives
 * here, on the signature callers actually see. Field-name agreement between the
 * two sides is covered by the model's round-trip tests.
 */

export interface ElementUpdateContext {
	tracks: SceneTracks;
	trackId: string;
}

/**
 * Apply a patch, then hold the invariants that follow from it: a new speed
 * resizes the clip, a shorter clip drops keyframes past its end, and nothing
 * starts before zero.
 *
 * `context` is accepted and ignored. No rule reads it today — it was plumbing
 * for rules that might need the surrounding tracks — and passing a whole
 * `SceneTracks` across the boundary for nobody to read would be the most
 * expensive part of the call. It stays in the signature so adding such a rule
 * does not mean changing every call site.
 */
export function applyElementUpdate({
	element,
	patch,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	context?: ElementUpdateContext;
}): TimelineElement {
	const updated = _applyElementUpdate({
		element,
		patch,
		idSeed: crypto.randomUUID(),
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return updated.element as TimelineElement;
}

// --- Gaps -------------------------------------------------------------------

/** Widening for the untyped element model. See the note above. */
function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

/**
 * Empty space on one track between two pieces of material — or before the first
 * clip. Space *after* the last clip is deliberately not a gap: there is nothing
 * on the far side to pull back.
 */
export interface TimelineGap {
	trackId: string;
	startTime: MediaTime;
	endTime: MediaTime;
}

export function findGapAtTime({
	track,
	time,
}: {
	track: TimelineTrack;
	time: MediaTime;
}): TimelineGap | null {
	// The gap's times are integer ticks; `MediaTime` flattens to `number` across
	// the boundary, so the brand is reapplied here.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (_findGapAtTime(wasmArgs({ args: { track, time } })).gap ??
		null) as TimelineGap | null;
}

export function findGaps({ track }: { track: TimelineTrack }): TimelineGap[] {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _findGaps(wasmArgs({ args: { track } })).gaps as TimelineGap[];
}

export function closeGap({
	tracks,
	gap,
}: {
	tracks: SceneTracks;
	gap: TimelineGap;
}): SceneTracks {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _closeGap(
		wasmArgs({ args: { tracks, gap } }),
	) as unknown as SceneTracks;
}

export function closeAllGaps({
	tracks,
	track,
}: {
	tracks: SceneTracks;
	track: TimelineTrack;
}): SceneTracks {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _closeAllGaps(
		wasmArgs({ args: { tracks, track } }),
	) as unknown as SceneTracks;
}

// --- Grouping ---------------------------------------------------------------

/**
 * Group membership is a shared id on each element rather than a container, so a
 * group has no position in the track order and an element leaves one by losing
 * the id.
 */
export function createGroupId(): string {
	// Stays here: minting an id needs randomness, which is not worth wiring into
	// a wasm build to produce an opaque string.
	return `group-${crypto.randomUUID()}`;
}

export function isGroupedElement({
	element,
}: {
	element: TimelineElement;
}): boolean {
	return typeof element.groupId === "string" && element.groupId.length > 0;
}

/** Pulls in the rest of every group the given elements belong to. */
export function expandToGroups({
	tracks,
	elements,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
}): ElementRef[] {
	return _expandToGroups(wasmArgs({ args: { tracks, elements } })).elements;
}

/** Drops the given elements *and* the rest of their groups. */
export function removeWithGroups({
	tracks,
	elements,
	remove,
}: {
	tracks: SceneTracks;
	elements: readonly ElementRef[];
	remove: readonly ElementRef[];
}): ElementRef[] {
	return _removeWithGroups(wasmArgs({ args: { tracks, elements, remove } }))
		.elements;
}
