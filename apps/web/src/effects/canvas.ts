import { resolveFilteredSource } from "./filter-fallback";
import { borrowSurface, SURFACE_KEYS } from "./surface-pool";
import type { EffectContext2D } from "./types";
import { unitSize as _unitSize } from "@/wasm";

// Re-exported so the effects keep importing their scratch surfaces from the
// module they do their drawing through.
export { borrowSurface, SURFACE_KEYS };

// Math now owned by `editor-core::effects::canvas`.
export const unitSize = _unitSize;

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
	// On an engine whose `ctx.filter` is inert the chain has already been baked
	// into a copy of the source, and `filter` comes back as "none" — so the same
	// two lines below are correct on both.
	const filtered = resolveFilteredSource({ source, width, height, filter });

	ctx.save();
	ctx.filter = filtered.filter;
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = composite;
	ctx.translate(width / 2, height / 2 + translateY);
	if (scale !== 1) {
		ctx.scale(scale, scale);
	}
	ctx.drawImage(filtered.source, -width / 2, -height / 2, width, height);
	ctx.restore();
}

function fillLayer({
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
 * WebKitGTK draws a WebCodecs `VideoFrame` straight through, ignoring the
 * composite operation in force: `destination-in` lands as `source-over` there,
 * so a mask draw repaints the frame over what it was meant to be masking
 * instead of cutting it out. A canvas, an `ImageBitmap` and an
 * `HTMLImageElement` all composite correctly — only a frame does not — so a
 * frame is copied into a canvas and masked with that. Measured by the
 * "Masking a decoded frame keeps what was painted over it" desktop check, which
 * also records whether the engine still needs the copy.
 */
function compositableSource({
	source,
	width,
	height,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
}): CanvasImageSource {
	if (typeof VideoFrame === "undefined" || !(source instanceof VideoFrame)) {
		return source;
	}
	const surface = borrowSurface({
		key: SURFACE_KEYS.alphaMask,
		width,
		height,
	});
	surface.ctx.drawImage(source, 0, 0, width, height);
	return surface.canvas;
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
	const mask = compositableSource({ source, width, height });
	ctx.save();
	ctx.globalCompositeOperation = "destination-in";
	ctx.drawImage(mask, 0, 0, width, height);
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

	// Derived once rather than per channel: where the source is a decoded frame
	// this is a full-frame copy, and doing it inside the loop meant three of them
	// for a mask that is the same all three times.
	const mask = compositableSource({ source, width, height });

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
		keepSourceAlpha({ ctx: surface.ctx, source: mask, width, height });

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
	// Written straight to the target rather than back to the scratch and then
	// blitted across. `putImageData` replaces the pixels it covers outright —
	// which is the `copy` semantics this needs anyway, so a caller may still map a
	// surface in place — and skipping the round trip halves the full-frame traffic
	// of a per-pixel effect. On a 1080p green screen that is several milliseconds
	// a frame, on top of what the loop itself costs.
	ctx.putImageData(image, 0, 0);
}
