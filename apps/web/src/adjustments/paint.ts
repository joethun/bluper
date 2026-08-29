import { keepSourceAlpha } from "@/effects/canvas";
import { resolveFilteredSource } from "@/effects/filter-fallback";
import type {
	AdjustmentGrain,
	AdjustmentHighPass,
	AdjustmentOverlay,
	AdjustmentVignette,
	AdjustmentWash,
	ResolvedAdjustments,
} from "./types";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const GRAIN_TILE_SIZE_PX = 128;
const MAX_GRAIN_ALPHA = 0.35;
const MAX_HIGH_PASS_ALPHA = 0.85;

const grainTiles = new Map<number, OffscreenCanvas>();

/**
 * Deterministic noise. `Math.random()` would resample every frame, which both
 * defeats the compositor's content-hash texture cache and makes an export
 * shimmer, so the tile is generated once from a fixed sequence and reused.
 */
function createGrainTile({ size }: { size: number }): OffscreenCanvas | null {
	if (typeof OffscreenCanvas === "undefined") {
		return null;
	}

	const cached = grainTiles.get(size);
	if (cached) {
		return cached;
	}

	const canvas = new OffscreenCanvas(GRAIN_TILE_SIZE_PX, GRAIN_TILE_SIZE_PX);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}

	const cellSize = Math.max(1, Math.round(size));
	let state = 0x2f6e2b1;
	const nextUnit = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};

	for (let y = 0; y < GRAIN_TILE_SIZE_PX; y += cellSize) {
		for (let x = 0; x < GRAIN_TILE_SIZE_PX; x += cellSize) {
			const level = Math.round(nextUnit() * 255);
			ctx.fillStyle = `rgb(${level},${level},${level})`;
			ctx.fillRect(x, y, cellSize, cellSize);
		}
	}

	grainTiles.set(size, canvas);
	return canvas;
}

function paintWash({
	ctx,
	overlay,
	width,
	height,
}: {
	ctx: Context2D;
	overlay: AdjustmentWash;
	width: number;
	height: number;
}): void {
	ctx.save();
	ctx.globalCompositeOperation = overlay.compositeOperation;
	ctx.globalAlpha = overlay.alpha;
	ctx.fillStyle = overlay.color;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

function paintVignette({
	ctx,
	overlay,
	width,
	height,
}: {
	ctx: Context2D;
	overlay: AdjustmentVignette;
	width: number;
	height: number;
}): void {
	const centerX = width / 2;
	const centerY = height / 2;
	const outerRadius = Math.hypot(width, height) / 2;
	const gradient = ctx.createRadialGradient(
		centerX,
		centerY,
		outerRadius * overlay.radius,
		centerX,
		centerY,
		outerRadius,
	);
	gradient.addColorStop(0, "rgba(0,0,0,0)");
	gradient.addColorStop(1, `rgba(0,0,0,${overlay.amount})`);

	ctx.save();
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

function paintGrain({
	ctx,
	overlay,
	width,
	height,
}: {
	ctx: Context2D;
	overlay: AdjustmentGrain;
	width: number;
	height: number;
}): void {
	const tile = createGrainTile({ size: overlay.size });
	if (!tile) {
		return;
	}

	const pattern = ctx.createPattern(tile, "repeat");
	if (!pattern) {
		return;
	}

	ctx.save();
	ctx.globalCompositeOperation = "overlay";
	ctx.globalAlpha = overlay.amount * MAX_GRAIN_ALPHA;
	ctx.fillStyle = pattern;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

function paintHighPass({
	ctx,
	overlay,
	source,
	width,
	height,
}: {
	ctx: Context2D;
	overlay: AdjustmentHighPass;
	source: CanvasImageSource;
	width: number;
	height: number;
}): void {
	// This overlay stays on the canvas even when the rest of the chain has been
	// handed to the compositor as shader passes, so it is the one place an
	// adjustment still needs a filter to work on an engine that ignores
	// `ctx.filter`.
	const filtered = resolveFilteredSource({
		source,
		width,
		height,
		filter: `blur(${overlay.radius}px) invert(1)`,
	});

	ctx.save();
	ctx.globalCompositeOperation = "overlay";
	ctx.globalAlpha = overlay.amount * MAX_HIGH_PASS_ALPHA;
	ctx.filter = filtered.filter;
	ctx.drawImage(filtered.source, 0, 0, width, height);
	ctx.restore();
}

/**
 * Renders a layer with its adjustment stack applied. The heavy lifting is done
 * by `ctx.filter` and canvas blend modes, both of which the browser runs on the
 * GPU — a per-pixel pass in JS would not hold up at playback rates, and the
 * WASM compositor's shader set is fixed.
 */
export function paintAdjustedLayer({
	ctx,
	source,
	width,
	height,
	adjustments,
}: {
	ctx: Context2D;
	source: CanvasImageSource;
	width: number;
	height: number;
	adjustments: ResolvedAdjustments;
}): void {
	ctx.save();
	ctx.filter = adjustments.filter.length > 0 ? adjustments.filter : "none";
	ctx.drawImage(source, 0, 0, width, height);
	ctx.restore();

	for (const overlay of adjustments.overlays) {
		paintOverlay({ ctx, overlay, source, width, height });
	}

	if (needsAlphaRestore({ overlays: adjustments.overlays })) {
		// Blend modes and full-canvas fills paint into pixels the layer never
		// covered, which would turn a transparent sticker into a coloured box.
		// Re-imposing the source's own alpha throws that spill away.
		keepSourceAlpha({ ctx, source, width, height });
	}
}

function paintOverlay({
	ctx,
	overlay,
	source,
	width,
	height,
}: {
	ctx: Context2D;
	overlay: AdjustmentOverlay;
	source: CanvasImageSource;
	width: number;
	height: number;
}): void {
	switch (overlay.kind) {
		case "wash":
			paintWash({ ctx, overlay, width, height });
			return;
		case "vignette":
			paintVignette({ ctx, overlay, width, height });
			return;
		case "grain":
			paintGrain({ ctx, overlay, width, height });
			return;
		case "highPass":
			paintHighPass({ ctx, overlay, source, width, height });
			return;
	}
}

function needsAlphaRestore({
	overlays,
}: {
	overlays: AdjustmentOverlay[];
}): boolean {
	return overlays.some(
		(overlay) =>
			overlay.kind === "wash" ||
			overlay.kind === "vignette" ||
			overlay.kind === "grain",
	);
}

/** Stable cache key for a resolved stack, for the compositor's texture cache. */
export function hashResolvedAdjustments({
	adjustments,
}: {
	adjustments: ResolvedAdjustments;
}): string {
	return `${adjustments.filter}|${adjustments.overlays
		.map((overlay) => JSON.stringify(overlay))
		.join(",")}`;
}
