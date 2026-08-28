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
 *
 * Borrowing clears, so a surface a caller is still holding must never be
 * borrowed again under the same key until it has been consumed — which is why
 * every distinct role below has a key of its own.
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
	alphaMask: "alpha-mask",
	filter: "filter",
	filterBlur: "filter-blur",
	crop: "crop",
	cropSource: "crop-source",
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
