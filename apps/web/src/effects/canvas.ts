import type { EffectContext2D } from "./types";

/**
 * Scratch canvases are pooled rather than allocated per frame: an animated
 * effect redraws its layer on every tick, and a fresh 1080p OffscreenCanvas per
 * tick is enough garbage to show up as playback stutter.
 *
 * Keys are fixed strings (see `SURFACE_KEYS`) paired with the size asked for, so
 * a 1080p clip and a small sticker in the same frame do not fight over one
 * canvas and resize it back and forth.
 *
 * The pool is bounded by bytes rather than by entry count: a panel preview is
 * 100 KB while a 4K chain buffer is 33 MB, so counting them the same would
 * either starve the previews or let the large buffers run away.
 */
const MAX_POOLED_BYTES = 192 * 1024 * 1024;

export type Surface = {
	canvas: OffscreenCanvas;
	ctx: OffscreenCanvasRenderingContext2D;
};

type PoolEntry = Surface & { readFrequently: boolean; bytes: number };

const pool = new Map<string, PoolEntry>();
let pooledBytes = 0;

export const SURFACE_KEYS = {
	chainA: "chain-a",
	chainB: "chain-b",
	textRaster: "text-raster",
	pixels: "pixels",
	channel: "channel",
	stage: "stage",
} as const;

export function borrowSurface({
	key,
	width,
	height,
	readFrequently = false,
}: {
	key: string;
	width: number;
	height: number;
	readFrequently?: boolean;
}): Surface {
	const cacheKey = `${key}:${width}x${height}`;
	const existing = pool.get(cacheKey);
	if (existing && existing.readFrequently === readFrequently) {
		// Re-inserting keeps the map ordered least-recently-used first, which is
		// what makes the eviction below pick the right victim.
		pool.delete(cacheKey);
		pool.set(cacheKey, existing);
		resetContext({ ctx: existing.ctx, width, height });
		return existing;
	}

	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: readFrequently });
	if (!ctx) {
		throw new Error("Failed to create a 2D context for an effect surface");
	}
	const previous = pool.get(cacheKey);
	if (previous) {
		pooledBytes -= previous.bytes;
		pool.delete(cacheKey);
	}
	const entry: PoolEntry = {
		canvas,
		ctx,
		readFrequently,
		bytes: width * height * 4,
	};
	pool.set(cacheKey, entry);
	pooledBytes += entry.bytes;
	while (pooledBytes > MAX_POOLED_BYTES && pool.size > 1) {
		const oldest = pool.keys().next();
		if (oldest.done) break;
		const evicted = pool.get(oldest.value);
		pool.delete(oldest.value);
		pooledBytes -= evicted?.bytes ?? 0;
	}
	return entry;
}

function resetContext({
	ctx,
	width,
	height,
}: {
	ctx: EffectContext2D;
	width: number;
	height: number;
}): void {
	ctx.filter = "none";
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
	ctx.imageSmoothingEnabled = true;
	ctx.clearRect(0, 0, width, height);
}

/**
 * One "unit" of visual distance. Blur radii and offsets are written in units so
 * an effect looks the same on a 720p clip and a 4K one instead of turning into a
 * hairline on the larger frame.
 */
export function unitSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): number {
	return Math.min(width, height) / 1000;
}

/** Draws the layer scaled and nudged about its own centre. */
export function drawSource({
	ctx,
	source,
	width,
	height,
	scale = 1,
	translateY = 0,
	filter = "none",
	alpha = 1,
	composite = "source-over",
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
	scale?: number;
	translateY?: number;
	filter?: string;
	alpha?: number;
	composite?: GlobalCompositeOperation;
}): void {
	ctx.save();
	ctx.filter = filter;
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = composite;
	ctx.translate(width / 2, height / 2 + translateY);
	if (scale !== 1) {
		ctx.scale(scale, scale);
	}
	ctx.drawImage(source, -width / 2, -height / 2, width, height);
	ctx.restore();
}

export function fillLayer({
	ctx,
	color,
	width,
	height,
	alpha = 1,
	composite = "source-over",
}: {
	ctx: EffectContext2D;
	color: string;
	width: number;
	height: number;
	alpha?: number;
	composite?: GlobalCompositeOperation;
}): void {
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = composite;
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

/**
 * Throws away anything the effect painted outside the layer's own silhouette.
 * Blend modes and full-frame fills reach into pixels the layer never covered,
 * which would turn a transparent sticker or a line of text into a coloured box.
 */
export function keepSourceAlpha({
	ctx,
	source,
	width,
	height,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
}): void {
	ctx.save();
	ctx.globalCompositeOperation = "destination-in";
	ctx.drawImage(source, 0, 0, width, height);
	ctx.restore();
}

/**
 * Splits the layer into red, green and blue copies and re-adds them at
 * different offsets, which is what reads as a lens fringe or a mistracking
 * tape. Canvas has no channel selector, so each copy is multiplied by a pure
 * primary and the three are recombined with `lighter`.
 */
export function drawChannelSplit({
	ctx,
	source,
	width,
	height,
	red,
	green = { x: 0, y: 0 },
	blue,
	alpha = 1,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
	red: { x: number; y: number };
	green?: { x: number; y: number };
	blue: { x: number; y: number };
	alpha?: number;
}): void {
	const channels = [
		{ color: "#ff0000", offset: red },
		{ color: "#00ff00", offset: green },
		{ color: "#0000ff", offset: blue },
	];

	for (const channel of channels) {
		const surface = borrowSurface({
			key: `${SURFACE_KEYS.channel}-${channel.color}`,
			width,
			height,
		});
		surface.ctx.drawImage(source, 0, 0, width, height);
		// `multiply` over a transparent pixel leaves the fill behind rather than
		// nothing, so the layer's own alpha is re-imposed afterwards.
		fillLayer({
			ctx: surface.ctx,
			color: channel.color,
			width,
			height,
			composite: "multiply",
		});
		keepSourceAlpha({ ctx: surface.ctx, source, width, height });

		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.globalCompositeOperation = "lighter";
		ctx.drawImage(
			surface.canvas,
			channel.offset.x,
			channel.offset.y,
			width,
			height,
		);
		ctx.restore();
	}
}

/**
 * Runs a per-pixel transform. The read happens on a `willReadFrequently`
 * surface rather than on the caller's target, which keeps the compositor's
 * upload canvas on the GPU-backed path.
 */
export function mapPixels({
	ctx,
	source,
	width,
	height,
	map,
}: {
	ctx: EffectContext2D;
	source: CanvasImageSource;
	width: number;
	height: number;
	map: (pixels: Uint8ClampedArray) => void;
}): void {
	const surface = borrowSurface({
		key: SURFACE_KEYS.pixels,
		width,
		height,
		readFrequently: true,
	});
	surface.ctx.drawImage(source, 0, 0, width, height);
	const image = surface.ctx.getImageData(0, 0, width, height);
	map(image.data);
	surface.ctx.putImageData(image, 0, 0);
	// `copy` rather than `source-over`, so a caller may map a surface in place
	// without the result being composited over what it replaces.
	ctx.save();
	ctx.globalCompositeOperation = "copy";
	ctx.drawImage(surface.canvas, 0, 0, width, height);
	ctx.restore();
}

export function smoothstep({
	edge0,
	edge1,
	value,
}: {
	edge0: number;
	edge1: number;
	value: number;
}): number {
	if (edge1 <= edge0) {
		return value < edge0 ? 0 : 1;
	}
	const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}
