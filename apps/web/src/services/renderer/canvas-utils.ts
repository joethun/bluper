export function createCanvasSurface({
	width,
	height,
}: {
	width: number;
	height: number;
}): {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
} {
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Failed to create 2D rendering context");
	}
	return { canvas, context };
}

/**
 * Reads a single pixel's RGBA by drawing `source` onto a fresh 2D canvas first.
 * Some sources (a `VideoFrame`, the compositor's output canvas) keep their own
 * context type and `getImageData` on them is either wrong or has surprising
 * alpha rules, so a vanilla 2D draw is the only readback path that always works.
 */
export function readPixelRgba({
	source,
	width,
	height,
	x = 0,
	y = 0,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
	x?: number;
	y?: number;
}): Uint8ClampedArray {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Failed to create readback context");
	ctx.drawImage(source, 0, 0, width, height);
	return ctx.getImageData(x, y, 1, 1).data;
}

/**
 * Reads every pixel of `source` as a flat RGBA buffer. Used by checks that need
 * the whole frame rather than a single point — the read has to happen straight
 * after the render, so a helper that creates its own canvas avoids the caller
 * having to manage one.
 */
export function readFullFrameRgba({
	source,
	width,
	height,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
}): Uint8ClampedArray {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Failed to create readback context");
	ctx.drawImage(source, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height).data;
}
