import {
	getBoxMaskHandlePositions as _getBoxMaskHandlePositions,
	getBoxMaskOverlays as _getBoxMaskOverlays,
	getBoxMaskRectOverlay as _getBoxMaskRectOverlay,
	getLineMaskHandlePositions as _getLineMaskHandlePositions,
	getLineMaskOverlay as _getLineMaskOverlay,
} from "bluper-wasm";
import type { ElementBounds } from "@/preview/element-bounds";
import type {
	MaskFeatures,
	MaskHandleId,
	MaskHandlePosition,
	MaskLineOverlay,
	MaskOverlay,
	MaskRectOverlay,
	RectangleMaskParams,
} from "@/masks/types";

/**
 * Mask overlay and handle geometry, owned by
 * `editor-core::masks::handle_positions`. A mask stores its placement
 * normalised against the element it is attached to; these turn that back into
 * canvas coordinates for the preview to draw and hit-test.
 *
 * The Rust builders all share one overlay union rather than returning a
 * distinct type each, since every one of them ends up in the same
 * `MaskOverlay[]`. The two that the TypeScript typed more narrowly narrow it
 * back here, so the signatures a caller sees are unchanged.
 */

export function getLineMaskOverlay({
	centerX,
	centerY,
	rotation,
	bounds,
	handleId,
	cursor,
}: {
	centerX: number;
	centerY: number;
	rotation: number;
	bounds: ElementBounds;
	handleId?: MaskHandleId;
	cursor?: string;
}): MaskLineOverlay {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _getLineMaskOverlay({
		centerX,
		centerY,
		rotation,
		bounds,
		handleId,
		cursor,
	}) as MaskLineOverlay;
}

export function getLineMaskHandlePositions({
	centerX,
	centerY,
	rotation,
	feather,
	bounds,
	displayScale,
}: {
	centerX: number;
	centerY: number;
	rotation: number;
	feather: number;
	bounds: ElementBounds;
	displayScale: number;
}): MaskHandlePosition[] {
	return _getLineMaskHandlePositions({
		centerX,
		centerY,
		rotation,
		feather,
		bounds,
		displayScale,
	}).handles;
}

export function getBoxMaskHandlePositions({
	centerX,
	centerY,
	width,
	height,
	rotation,
	feather,
	sizeMode,
	showScaleHandle,
	bounds,
	displayScale,
}: {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotation: number;
	feather: number;
	sizeMode: MaskFeatures["sizeMode"];
	showScaleHandle?: boolean;
	bounds: ElementBounds;
	displayScale: number;
}): MaskHandlePosition[] {
	return _getBoxMaskHandlePositions({
		centerX,
		centerY,
		width,
		height,
		rotation,
		feather,
		sizeMode,
		showScaleHandle,
		bounds,
		displayScale,
	}).handles;
}

export function getBoxMaskRectOverlay({
	centerX,
	centerY,
	width,
	height,
	rotation,
	bounds,
	handleId,
	cursor,
	dashed,
}: {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotation: number;
	bounds: ElementBounds;
	handleId?: MaskHandleId;
	cursor?: string;
	dashed?: boolean;
}): MaskRectOverlay {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _getBoxMaskRectOverlay({
		centerX,
		centerY,
		width,
		height,
		rotation,
		bounds,
		handleId,
		cursor,
		dashed,
	}) as MaskRectOverlay;
}

export function getBoxMaskOverlays({
	params,
	bounds,
	pathData,
	showBoundingBox,
}: {
	params: Pick<
		RectangleMaskParams,
		"centerX" | "centerY" | "width" | "height" | "rotation"
	>;
	bounds: ElementBounds;
	pathData?: string;
	showBoundingBox?: boolean;
}): MaskOverlay[] {
	return _getBoxMaskOverlays({ params, bounds, pathData, showBoundingBox })
		.overlays;
}
