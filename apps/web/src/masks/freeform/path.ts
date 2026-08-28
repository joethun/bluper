import type { ElementBounds } from "@/preview/element-bounds";
import {
	removeFreeformPathPoints as _removeFreeformPathPoints,
	getFreeformPathClosedStateAfterPointRemoval as _getFreeformPathClosedStateAfterPointRemoval,
	freeformCanvasPointToLocal as _freeformCanvasPointToLocal,
	getFreeformCanvasGeometry as _getFreeformCanvasGeometry,
	getFreeformSegmentCount as _getFreeformSegmentCount,
	getFreeformCanvasSegments as _getFreeformCanvasSegments,
	findClosestPointOnFreeformSegment as _findClosestPointOnFreeformSegment,
	insertPointIntoFreeformSegment as _insertPointIntoFreeformSegment,
	getFreeformLocalBounds as _getFreeformLocalBounds,
	recenterFreeformPath as _recenterFreeformPath,
	buildFreeformPath2d as _buildFreeformPath2D,
	buildFreeformSvgPath as _buildFreeformSvgPath,
	type FreeformPathPoint,
	type FreeformCanvasAnchor,
	type FreeformCanvasBounds,
	type FreeformCanvasSegment,
	type FreeformRecenteredPath,
} from "bluper-wasm";

/**
 * Geometry for the freeform custom mask path. Owned by
 * `editor-core::masks::freeform_path`.
 *
 * The TS surface used `null` for the empty-path bounds; the wasm layer
 * serializes Option as `undefined`, so the façade reconciles the two before
 * returning to callers.
 */

export type { FreeformPathPoint, FreeformCanvasSegment };

export interface CanvasPoint {
	x: number;
	y: number;
}

export function removeFreeformPathPoints({
	points,
	pointIds,
}: {
	points: FreeformPathPoint[];
	pointIds: string[];
}): FreeformPathPoint[] {
	return _removeFreeformPathPoints({ points, pointIds });
}

export function getFreeformPathClosedStateAfterPointRemoval({
	wasClosed,
	remainingPointCount,
}: {
	wasClosed: boolean;
	remainingPointCount: number;
}): boolean {
	return _getFreeformPathClosedStateAfterPointRemoval({
		wasClosed,
		remainingPointCount,
	});
}

export function freeformCanvasPointToLocal({
	point,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
}: {
	point: CanvasPoint;
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
}): CanvasPoint {
	return _freeformCanvasPointToLocal({
		point,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
	});
}

export function getFreeformCanvasGeometry({
	points,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
}: {
	points: FreeformPathPoint[];
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
}): {
	anchors: FreeformCanvasAnchor[];
	bounds: FreeformCanvasBounds | null;
} {
	const result = _getFreeformCanvasGeometry({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
	});
	return {
		anchors: result.anchors,
		bounds: result.bounds ?? null,
	};
}

export function getFreeformSegmentCount({
	points,
	closed,
}: {
	points: FreeformPathPoint[];
	closed: boolean;
}): number {
	return _getFreeformSegmentCount({ points, closed });
}

export function getFreeformCanvasSegments({
	points,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
	closed,
}: {
	points: FreeformPathPoint[];
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
	closed: boolean;
}): FreeformCanvasSegment[] {
	return _getFreeformCanvasSegments({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
		closed,
	});
}

export function findClosestPointOnFreeformSegment({
	points,
	segmentIndex,
	canvasPoint,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
	closed,
}: {
	points: FreeformPathPoint[];
	segmentIndex: number;
	canvasPoint: CanvasPoint;
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
	closed: boolean;
}): { t: number; point: CanvasPoint } | null {
	const result = _findClosestPointOnFreeformSegment({
		points,
		segmentIndex,
		canvasPoint,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
		closed,
	});
	if (!result) {
		return null;
	}
	return { t: result.t, point: result.point };
}

export function insertPointIntoFreeformSegment({
	points,
	segmentIndex,
	pointId,
	t,
	closed,
}: {
	points: FreeformPathPoint[];
	segmentIndex: number;
	pointId: string;
	t: number;
	closed: boolean;
}): FreeformPathPoint[] {
	return _insertPointIntoFreeformSegment({
		points,
		segmentIndex,
		pointId,
		t,
		closed,
	});
}

export function getFreeformLocalBounds({
	points,
	bounds,
}: {
	points: FreeformPathPoint[];
	bounds: ElementBounds;
}): { width: number; height: number } | null {
	return _getFreeformLocalBounds({ points, bounds }) ?? null;
}

export function recenterFreeformPath({
	points,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
}: {
	points: FreeformPathPoint[];
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
}): FreeformRecenteredPath {
	return _recenterFreeformPath({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
	});
}

export function buildFreeformPath2D({
	points,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
	closed,
}: {
	points: FreeformPathPoint[];
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
	closed: boolean;
}): Path2D {
	const pathData = _buildFreeformPath2D({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
		closed,
	});
	return new Path2D(pathData);
}

export function buildFreeformSvgPath({
	points,
	centerX,
	centerY,
	rotation,
	scale,
	bounds,
	closed,
}: {
	points: FreeformPathPoint[];
	centerX: number;
	centerY: number;
	rotation: number;
	scale: number;
	bounds: ElementBounds;
	closed: boolean;
}): string {
	return _buildFreeformSvgPath({
		points,
		centerX,
		centerY,
		rotation,
		scale,
		bounds,
		closed,
	});
}
