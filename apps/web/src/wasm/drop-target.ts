import {
	computeDropTarget as _computeDropTarget,
	computeTransitionDropTarget as _computeTransitionDropTarget,
	getDropLineY as _getDropLineY,
} from "bluper-wasm";
import type {
	DropTarget,
	ElementType,
	SceneTracks,
	TimelineTrack,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm/media-time";

/**
 * Drop-target resolution, now owned by `editor-core::timeline::drop_target`.
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

/**
 * An absent Rust `Option` crosses as `undefined`, while the TypeScript contract
 * spells "no insert position" and "no target element" as an explicit `null`.
 * `seamTime` is the opposite case — it is `skip_serializing_if`'d away, so the
 * key is simply missing on a non-transition drop and must stay missing.
 */
function normalizeDropTarget({ target }: { target: DropTarget }): DropTarget {
	const normalized: DropTarget = {
		trackIndex: target.trackIndex,
		isNewTrack: target.isNewTrack,
		insertPosition: target.insertPosition ?? null,
		xPosition: target.xPosition,
		targetElement: target.targetElement ?? null,
	};
	return target.seamTime === undefined
		? normalized
		: { ...normalized, seamTime: target.seamTime };
}

/**
 * Resolves the join a transition drag is over. A transition belongs to a cut
 * rather than to a clip, so the drag snaps to the nearest boundary between two
 * adjacent clips instead of hit-testing whichever clip is under the pointer —
 * dropping in the middle of a clip means nothing.
 */
export function computeTransitionDropTarget({
	mouseX,
	mouseY,
	tracks,
	pixelsPerSecond,
	zoomLevel,
}: {
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	pixelsPerSecond: number;
	zoomLevel: number;
}): DropTarget | null {
	const { target } = _computeTransitionDropTarget(
		wasmArgs({ args: { mouseX, mouseY, tracks, pixelsPerSecond, zoomLevel } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const resolved = (target ?? null) as DropTarget | null;
	return resolved === null ? null : normalizeDropTarget({ target: resolved });
}

/**
 * Resolves a drag to the row and time it would land at. Always answers: the
 * pointer is still down, so the indicator has to go somewhere even when nothing
 * will accept the element.
 */
export function computeDropTarget({
	elementType,
	mouseX,
	mouseY,
	tracks,
	playheadTime,
	isExternalDrop,
	elementDuration,
	pixelsPerSecond,
	zoomLevel,
	verticalDragDirection,
	startTimeOverride,
	excludeElementId,
	targetElementTypes,
	sourceTrackId,
}: {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	playheadTime: MediaTime;
	isExternalDrop: boolean;
	elementDuration: MediaTime;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: MediaTime;
	excludeElementId?: string;
	targetElementTypes?: string[];
	/**
	 * The track the dragged element currently lives on. When placement would
	 * otherwise mint a track on the far side of the timeline from the pointer,
	 * it stays here instead.
	 */
	sourceTrackId?: string;
}): DropTarget {
	const target = _computeDropTarget(
		wasmArgs({
			args: {
				elementType,
				mouseX,
				mouseY,
				tracks,
				playheadTime,
				isExternalDrop,
				elementDuration,
				pixelsPerSecond,
				zoomLevel,
				// `null` and absent mean the same thing; normalise rather than
				// relying on serde to accept both spellings.
				verticalDragDirection: verticalDragDirection ?? undefined,
				startTimeOverride,
				excludeElementId,
				targetElementTypes,
				sourceTrackId,
			},
		}),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return normalizeDropTarget({ target: target as unknown as DropTarget });
}

/**
 * Top edge, in CSS pixels, of the line drawn where a new track would appear.
 * `tracks` is the same display-ordered list the drop target's index refers to.
 */
export function getDropLineY({
	dropTarget,
	tracks,
}: {
	dropTarget: DropTarget;
	tracks: TimelineTrack[];
}): number {
	return _getDropLineY(wasmArgs({ args: { dropTarget, tracks } }));
}
