import {
	canvasToOverlayPoint as _canvasToOverlayPoint,
	getDisplayScale as _getDisplayScale,
	positionToOverlayPoint as _positionToOverlayPoint,
	screenPixelsToLogicalThresholdValue as _screenPixelsToLogicalThresholdValue,
	screenToCanvasPoint as _screenToCanvasPoint,
	type PreviewViewportGeometry,
} from "bluper-wasm";

/**
 * The preview's coordinate conversions. Owned by
 * `editor-core::preview::coords`.
 *
 * `screenToCanvas` still takes the `DOMRect` its callers hold — measuring the
 * viewport element is a browser job — and hands Rust the two numbers it reads
 * off it.
 */

export type { PreviewViewportGeometry };

export function screenToCanvas({
	clientX,
	clientY,
	geometry,
	viewportRect,
}: {
	clientX: number;
	clientY: number;
	geometry: PreviewViewportGeometry;
	viewportRect: DOMRect;
}): { x: number; y: number } {
	return _screenToCanvasPoint({
		overlayX: clientX - viewportRect.left,
		overlayY: clientY - viewportRect.top,
		geometry,
	});
}

export function canvasToOverlay({
	canvasX,
	canvasY,
	geometry,
}: {
	canvasX: number;
	canvasY: number;
	geometry: PreviewViewportGeometry;
}): { x: number; y: number } {
	return _canvasToOverlayPoint({ canvasX, canvasY, geometry });
}

export function positionToOverlay({
	positionX,
	positionY,
	geometry,
}: {
	positionX: number;
	positionY: number;
	geometry: PreviewViewportGeometry;
}): { x: number; y: number } {
	return _positionToOverlayPoint({ positionX, positionY, geometry });
}

export function getDisplayScale({
	geometry,
}: {
	geometry: PreviewViewportGeometry;
}): { x: number; y: number } {
	return _getDisplayScale({ geometry });
}

export function screenPixelsToLogicalThreshold({
	geometry,
	screenPixels,
}: {
	geometry: PreviewViewportGeometry;
	screenPixels: number;
}): { x: number; y: number } {
	return _screenPixelsToLogicalThresholdValue({ screenPixels, geometry });
}
