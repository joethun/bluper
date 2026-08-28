import {
	getHitElementIndexes as _getHitElementIndexes,
	getPreferredHitIndex as _getPreferredHitIndex,
} from "bluper-wasm";
import type { ElementWithBounds } from "./element-bounds";
import type { ElementRef } from "@/timeline/types";

/**
 * What the pointer is over in the preview. Owned by
 * `editor-core::preview::hit_test`.
 *
 * Only the bounds cross, and only indices come back: the caller already holds
 * the elements, and sending them through the bridge would serialise every
 * clip's parameter tree to answer which one was clicked.
 */

export function getHitElements({
	canvasX,
	canvasY,
	elementsWithBounds,
}: {
	canvasX: number;
	canvasY: number;
	elementsWithBounds: ElementWithBounds[];
}): ElementWithBounds[] {
	const { indexes } = _getHitElementIndexes({
		canvasX,
		canvasY,
		bounds: elementsWithBounds.map(({ bounds }) => ({
			cx: bounds.cx,
			cy: bounds.cy,
			width: bounds.width,
			height: bounds.height,
			rotation: bounds.rotation,
		})),
	});

	return indexes.map((index) => elementsWithBounds[index]);
}

export function hitTest({
	canvasX,
	canvasY,
	elementsWithBounds,
}: {
	canvasX: number;
	canvasY: number;
	elementsWithBounds: ElementWithBounds[];
}): ElementWithBounds | null {
	return (
		getHitElements({
			canvasX,
			canvasY,
			elementsWithBounds,
		})[0] ?? null
	);
}

export function resolvePreferredHit({
	hits,
	preferredElements,
}: {
	hits: ElementWithBounds[];
	preferredElements: ElementRef[];
}): ElementWithBounds | null {
	const index = _getPreferredHitIndex({
		hits: hits.map((hit) => ({
			trackId: hit.trackId,
			elementId: hit.elementId,
		})),
		preferredElements: preferredElements.map((element) => ({
			trackId: element.trackId,
			elementId: element.elementId,
		})),
	});

	return index === undefined ? null : hits[index];
}
