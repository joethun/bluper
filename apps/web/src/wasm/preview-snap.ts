import {
	previewSnapPosition as _previewSnapPosition,
	previewSnapRotation as _previewSnapRotation,
	previewSnapScale as _previewSnapScale,
	previewSnapScaleAxes as _previewSnapScaleAxes,
} from "bluper-wasm";

/**
 * Snapping for the preview canvas — position, uniform scale, per-axis scale and
 * rotation. Owned by `editor-core::preview::snap`.
 *
 * Coordinates are canvas units with the origin at the canvas *centre*, and
 * thresholds are per-axis because the preview is letterboxed into its container:
 * one screen pixel is a different number of canvas units on each axis once the
 * aspect ratios differ. Callers are drag gestures, so the payload is a handful
 * of numbers per pointer move.
 */

/**
 * Smallest magnitude a snap may give a scale. Mirrors `PREVIEW_MIN_SCALE` in the
 * Rust module, which is the source of truth; it is repeated here rather than
 * read through the generated getter so importing this module does not call into
 * wasm.
 */
export const MIN_SCALE = 0.01;

/**
 * Snap radius in *screen* pixels. The UI converts it into the per-axis canvas
 * thresholds these functions take, since only the UI knows the preview's scale.
 */
export const SNAP_THRESHOLD_SCREEN_PIXELS = 8;

/** A guide the UI draws while a gesture is snapped. */
export interface SnapLine {
	type: "horizontal" | "vertical";
	position: number;
}

export interface SnapResult {
	snappedPosition: { x: number; y: number };
	activeLines: SnapLine[];
}

/**
 * Which edges the gesture is dragging. Leaving it out is not the same as passing
 * an empty object: absent means "no opinion" and every touching edge draws its
 * guide, whereas `{}` draws none.
 */
export interface ScaleEdgePreference {
	left?: boolean;
	right?: boolean;
	top?: boolean;
	bottom?: boolean;
}

export interface ScaleSnapResult {
	snappedScale: number;
	activeLines: SnapLine[];
}

export interface AxisSnapResult {
	snappedScale: number;
	/** Infinity when no snap candidate was within threshold */
	snapDistance: number;
	activeLines: SnapLine[];
}

export interface RotationSnapResult {
	snappedRotation: number;
	isSnapped: boolean;
}

export function snapPosition({
	proposedPosition,
	canvasSize,
	elementSize,
	rotation,
	snapThreshold,
}: {
	proposedPosition: { x: number; y: number };
	canvasSize: { width: number; height: number };
	elementSize: { width: number; height: number };
	rotation?: number;
	snapThreshold: { x: number; y: number };
}): SnapResult {
	return _previewSnapPosition({
		proposedPosition,
		canvasSize,
		elementSize,
		rotation,
		snapThreshold,
	});
}

export function snapScale({
	proposedScale,
	position,
	baseWidth,
	baseHeight,
	rotation,
	canvasSize,
	snapThreshold,
	preferredEdges,
}: {
	proposedScale: number;
	position: { x: number; y: number };
	baseWidth: number;
	baseHeight: number;
	rotation?: number;
	canvasSize: { width: number; height: number };
	snapThreshold: { x: number; y: number };
	preferredEdges?: ScaleEdgePreference;
}): ScaleSnapResult {
	return _previewSnapScale({
		proposedScale,
		position,
		baseWidth,
		baseHeight,
		rotation,
		canvasSize,
		snapThreshold,
		preferredEdges,
	});
}

export function snapScaleAxes({
	proposedScaleX,
	proposedScaleY,
	position,
	baseWidth,
	baseHeight,
	rotation,
	canvasSize,
	snapThreshold,
	preferredEdges,
}: {
	proposedScaleX: number;
	proposedScaleY: number;
	position: { x: number; y: number };
	baseWidth: number;
	baseHeight: number;
	rotation?: number;
	canvasSize: { width: number; height: number };
	snapThreshold: { x: number; y: number };
	preferredEdges?: ScaleEdgePreference;
}): { x: AxisSnapResult; y: AxisSnapResult } {
	return _previewSnapScaleAxes({
		proposedScaleX,
		proposedScaleY,
		position,
		baseWidth,
		baseHeight,
		rotation,
		canvasSize,
		snapThreshold,
		preferredEdges,
	});
}

export function snapRotation({
	proposedRotation,
}: {
	proposedRotation: number;
}): RotationSnapResult {
	return _previewSnapRotation({ proposedRotation });
}
