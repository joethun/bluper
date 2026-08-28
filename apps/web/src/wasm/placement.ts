import {
	applyPlacement as _applyPlacement,
	buildEmptyTrack as _buildEmptyTrack,
	canElementGoOnTrack as _canElementGoOnTrack,
	getDefaultInsertIndexForTrack as _getDefaultInsertIndexForTrack,
	getTrackTypeForElementType as _getTrackTypeForElementType,
	resolveTrackPlacement as _resolveTrackPlacement,
	shiftElementsClearOfElement as _shiftElementsClearOfElement,
	validateElementTrackCompatibility as _validateElementTrackCompatibility,
} from "bluper-wasm";
import type {
	AdjustmentTrack,
	AudioTrack,
	EffectTrack,
	ElementType,
	GraphicTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	TimelineTrack,
	TrackType,
	VideoTrack,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Placement, now owned by `editor-core::timeline::placement`.
 *
 * Tracks cross the boundary untyped, because the element model uses
 * `#[serde(flatten)]` in Rust and tsify cannot render that as valid TypeScript.
 * The typing therefore lives on these signatures, and field-name agreement
 * between the two sides is covered by the model's round-trip tests.
 */

/**
 * The generated signatures take that untyped model, so each call has to widen
 * its argument. Funnelled through one place so the escape hatch is a single line
 * rather than one per call site.
 */
function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

/** Kept here rather than in Rust: `#[export]` on a const only carries numbers. */
export const MAIN_TRACK_NAME = "Main Track";

export interface PlacementTimeSpan {
	startTime: MediaTime;
	duration: MediaTime;
	/** An element already there that should not count as an obstacle. */
	excludeElementId?: string;
}

/**
 * Either the element type being placed, or the track type wanted directly. Rust
 * takes these as two optional fields, since serde cannot express "exactly one".
 */
export type PlacementSubject =
	{ elementType: ElementType } | { trackType: TrackType };

export type PlacementStrategy =
	| { type: "explicit"; trackId: string }
	| { type: "firstAvailable" }
	| {
			type: "preferIndex";
			trackIndex: number;
			hoverDirection: "above" | "below";
			verticalDragDirection?: "up" | "down" | null;
			createNewTrackOnly?: boolean;
	  }
	| { type: "aboveSource"; sourceTrackIndex: number }
	| { type: "alwaysNew"; position: "highest" | "default" };

export type PlacementResult =
	| {
			kind: "existingTrack";
			trackId: string;
			trackIndex: number;
			trackType: TrackType;
	  }
	| {
			kind: "newTrack";
			insertIndex: number;
			insertPosition: "above" | "below" | null;
			trackType: TrackType;
	  };

export function resolveTrackPlacement({
	tracks,
	timeSpans,
	strategy,
	sourceTrackId,
	...subject
}: PlacementSubject & {
	tracks: SceneTracks;
	timeSpans: PlacementTimeSpan[];
	strategy: PlacementStrategy;
	sourceTrackId?: string;
}): PlacementResult | null {
	// `verticalDragDirection: null` and absent mean the same thing; normalise
	// rather than relying on serde to accept both spellings.
	const normalizedStrategy =
		strategy.type === "preferIndex"
			? {
					...strategy,
					verticalDragDirection: strategy.verticalDragDirection ?? undefined,
				}
			: strategy;

	const resolved = _resolveTrackPlacement(
		wasmArgs({
			args: {
				tracks,
				timeSpans,
				strategy: normalizedStrategy,
				elementType: "elementType" in subject ? subject.elementType : undefined,
				trackType: "trackType" in subject ? subject.trackType : undefined,
				sourceTrackId,
			},
		}),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (resolved.placement ?? null) as PlacementResult | null;
}

export function applyPlacement({
	tracks,
	placementResult,
	elements,
	newTrackInsertIndexOverride,
}: {
	tracks: SceneTracks;
	placementResult: PlacementResult;
	elements: TimelineElement[];
	newTrackInsertIndexOverride?: number;
}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
	const applied = _applyPlacement(
		wasmArgs({
			args: {
				tracks,
				placementResult,
				elements,
				newTrackInsertIndexOverride,
				newTrackId: crypto.randomUUID(),
			},
		}),
	);
	if (!applied.updatedTracks || !applied.targetTrackId) return null;
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		updatedTracks: applied.updatedTracks as unknown as SceneTracks,
		targetTrackId: applied.targetTrackId,
	};
}

/**
 * A new, empty track of the given type.
 *
 * The overloads narrow the result by the `type` argument, which is what lets a
 * caller assign it straight into `SceneTracks.audio` or `.overlay` without a
 * cast of their own.
 */
export function buildEmptyTrack(args: {
	id: string;
	type: "video";
	name?: string;
}): VideoTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: "text";
	name?: string;
}): TextTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: "audio";
	name?: string;
}): AudioTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: "graphic";
	name?: string;
}): GraphicTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: "effect";
	name?: string;
}): EffectTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: "adjustment";
	name?: string;
}): AdjustmentTrack;
export function buildEmptyTrack(args: {
	id: string;
	type: TrackType;
	name?: string;
}): TimelineTrack;
export function buildEmptyTrack({
	id,
	type,
	name,
}: {
	id: string;
	type: TrackType;
	name?: string;
}): TimelineTrack {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _buildEmptyTrack({ id, type, name }) as unknown as TimelineTrack;
}

export function getTrackTypeForElementType({
	elementType,
}: {
	elementType: ElementType;
}): TrackType {
	return _getTrackTypeForElementType({ elementType });
}

export function canElementGoOnTrack({
	elementType,
	trackType,
}: {
	elementType: ElementType;
	trackType: TrackType;
}): boolean {
	return _canElementGoOnTrack({ elementType, trackType });
}

export function validateElementTrackCompatibility({
	element,
	track,
}: {
	element: { type: ElementType };
	track: { type: TrackType };
}): { isValid: boolean; errorMessage?: string } {
	return _validateElementTrackCompatibility({
		elementType: element.type,
		trackType: track.type,
	});
}

export function getDefaultInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
}): number {
	return _getDefaultInsertIndexForTrack(
		wasmArgs({ args: { tracks, trackType } }),
	);
}

/**
 * Slides the clips after `element` along, far enough that a clip which has just
 * grown does not sit on top of its neighbour. Only the overlap is taken up — a
 * clip that shrinks leaves a gap, because closing gaps is ripple editing's job
 * and that is a setting the user turns on.
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
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _shiftElementsClearOfElement(
		wasmArgs({ args: { tracks, trackId, element } }),
	) as unknown as SceneTracks;
}
