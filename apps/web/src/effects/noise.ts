import type { EffectContext2D } from "./types";

/**
 * All noise in the effects is hashed from its coordinates rather than drawn from
 * `Math.random()`. Two things depend on it: the compositor caches a layer by
 * content hash, so a resampled grain field would defeat the cache, and an export
 * re-renders every frame from scratch, so anything random would shimmer between
 * the preview and the file.
 */
export function hashNoise({
	x,
	y,
	seed = 0,
}: {
	x: number;
	y: number;
	seed?: number;
}): number {
	let hash = (Math.trunc(x) * 374761393 + Math.trunc(y) * 668265263) ^ (seed * 2246822519);
	hash = (hash ^ (hash >>> 13)) * 1274126177;
	hash = hash ^ (hash >>> 16);
	return (hash >>> 0) / 4294967295;
}

const GRAIN_TILE_SIZE = 256;
const grainTiles = new Map<string, OffscreenCanvas>();

/** A monochrome speckle tile, generated once per (cell size, seed) pair. */
export function grainTile({
	cellSize,
	seed = 7,
}: {
	cellSize: number;
	seed?: number;
}): OffscreenCanvas {
	const cell = Math.max(1, Math.round(cellSize));
	const key = `${cell}:${seed}`;
	const cached = grainTiles.get(key);
	if (cached) {
		return cached;
	}

	const canvas = new OffscreenCanvas(GRAIN_TILE_SIZE, GRAIN_TILE_SIZE);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Failed to create a 2D context for a grain tile");
	}

	for (let y = 0; y < GRAIN_TILE_SIZE; y += cell) {
		for (let x = 0; x < GRAIN_TILE_SIZE; x += cell) {
			const level = Math.round(hashNoise({ x, y, seed }) * 255);
			ctx.fillStyle = `rgb(${level},${level},${level})`;
			ctx.fillRect(x, y, cell, cell);
		}
	}

	grainTiles.set(key, canvas);
	return canvas;
}

/** Tiles a generated pattern across the layer, scrolled by `offset`. */
export function drawTiled({
	ctx,
	tile,
	width,
	height,
	alpha,
	composite,
	offsetX = 0,
	offsetY = 0,
	scale = 1,
	filter = "none",
}: {
	ctx: EffectContext2D;
	tile: OffscreenCanvas;
	width: number;
	height: number;
	alpha: number;
	composite: GlobalCompositeOperation;
	offsetX?: number;
	offsetY?: number;
	scale?: number;
	filter?: string;
}): void {
	const pattern = ctx.createPattern(tile, "repeat");
	if (!pattern) {
		return;
	}

	ctx.save();
	ctx.filter = filter;
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = composite;
	ctx.translate(offsetX, offsetY);
	if (scale !== 1) {
		ctx.scale(scale, scale);
	}
	ctx.fillStyle = pattern;
	ctx.fillRect(
		-offsetX / scale,
		-offsetY / scale,
		width / scale,
		height / scale,
	);
	ctx.restore();
}

/** A one-column tile of horizontal scan lines, for the tape-era effects. */
const scanlineTiles = new Map<string, OffscreenCanvas>();

export function scanlineTile({
	lineHeight,
	gapHeight,
	color,
}: {
	lineHeight: number;
	gapHeight: number;
	color: string;
}): OffscreenCanvas {
	const line = Math.max(1, Math.round(lineHeight));
	const gap = Math.max(1, Math.round(gapHeight));
	const key = `${line}:${gap}:${color}`;
	const cached = scanlineTiles.get(key);
	if (cached) {
		return cached;
	}

	const canvas = new OffscreenCanvas(1, line + gap);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Failed to create a 2D context for a scanline tile");
	}
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, 1, line);

	scanlineTiles.set(key, canvas);
	return canvas;
}
