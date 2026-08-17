import type { ParamValues } from "@/params";
import { clamp } from "@/utils/math";

/**
 * How much of each edge of the source is thrown away, as a fraction of that
 * axis. Insets rather than a rect because that is what the four controls in the
 * panel are, and because it keeps the value meaningful when the same crop is
 * copied onto a clip of a different size.
 */
export interface CropInsets {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface CropRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const NO_CROP: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };

export const CROP_PARAM_KEYS = [
	"crop.left",
	"crop.right",
	"crop.top",
	"crop.bottom",
] as const;

/**
 * The least of an axis a crop may leave behind. A clip cropped to nothing has no
 * pixels to composite and no box to grab in the preview, so the pair of insets
 * on an axis is scaled back to leave this much rather than being allowed to meet.
 */
const MIN_CROP_SPAN = 0.02;

/** Which source edge a crop inset trims. */
export type CropEdge = "left" | "right" | "top" | "bottom";

/**
 * Moves one edge to `value`, holding the opposite edge still and stopping before
 * the two would leave less than `MIN_CROP_SPAN` between them. Dragging past the
 * far edge pins rather than inverting, which is what a crop handle should do.
 */
export function setCropEdge({
	crop,
	edge,
	value,
}: {
	crop: CropInsets;
	edge: CropEdge;
	value: number;
}): CropInsets {
	const opposite: Record<CropEdge, CropEdge> = {
		left: "right",
		right: "left",
		top: "bottom",
		bottom: "top",
	};
	const limit = 1 - MIN_CROP_SPAN - crop[opposite[edge]];
	return {
		...crop,
		[edge]: clamp({ value, min: 0, max: Math.max(0, limit) }),
	};
}

function readInset({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): number {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value)
		? clamp({ value, min: 0, max: 1 })
		: 0;
}

export function readCropFromParams({
	params,
}: {
	params: ParamValues;
}): CropInsets {
	return {
		left: readInset({ params, key: "crop.left" }),
		right: readInset({ params, key: "crop.right" }),
		top: readInset({ params, key: "crop.top" }),
		bottom: readInset({ params, key: "crop.bottom" }),
	};
}

function isCropActive({ crop }: { crop: CropInsets | undefined }): boolean {
	if (!crop) return false;
	return (
		crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0
	);
}

/**
 * Pulls a pair of opposing insets back until they leave `MIN_CROP_SPAN` between
 * them, keeping their ratio so the kept region stays where the user put it.
 */
function normalizeAxis({
	start,
	end,
}: {
	start: number;
	end: number;
}): { start: number; end: number } {
	const clampedStart = clamp({ value: start, min: 0, max: 1 });
	const clampedEnd = clamp({ value: end, min: 0, max: 1 });
	const total = clampedStart + clampedEnd;
	const maxTotal = 1 - MIN_CROP_SPAN;

	if (total <= maxTotal || total === 0) {
		return { start: clampedStart, end: clampedEnd };
	}

	const scale = maxTotal / total;
	return { start: clampedStart * scale, end: clampedEnd * scale };
}

function normalizeCrop({ crop }: { crop: CropInsets }): CropInsets {
	const horizontal = normalizeAxis({ start: crop.left, end: crop.right });
	const vertical = normalizeAxis({ start: crop.top, end: crop.bottom });
	return {
		left: horizontal.start,
		right: horizontal.end,
		top: vertical.start,
		bottom: vertical.end,
	};
}

/**
 * The region of the source the clip keeps, in source pixels. `null` when nothing
 * is cropped, which is the signal for every caller to stay on its uncropped fast
 * path rather than blitting a full-size copy for no reason.
 */
export function resolveCropRect({
	crop,
	width,
	height,
}: {
	crop: CropInsets | undefined;
	width: number;
	height: number;
}): CropRect | null {
	if (!crop || !isCropActive({ crop }) || width <= 0 || height <= 0) {
		return null;
	}

	const normalized = normalizeCrop({ crop });
	// Rounded to whole pixels: a fractional source rect resamples the frame on
	// every draw, which softens a picture the user only asked to trim.
	const x = Math.round(normalized.left * width);
	const y = Math.round(normalized.top * height);
	const right = Math.round((1 - normalized.right) * width);
	const bottom = Math.round((1 - normalized.bottom) * height);

	return {
		x,
		y,
		width: Math.max(1, right - x),
		height: Math.max(1, bottom - y),
	};
}

/**
 * Where the kept region sits inside the layer's box, as fractions of it.
 *
 * Cropping never changes how big the clip is drawn: the box is still fitted from
 * the whole frame, and the crop takes a sub-rectangle of it. `keptFraction` is
 * how much of each axis survives; `centerFraction` is how far the kept region's
 * middle sits from the box's middle, signed towards positive x/y. Fitting the
 * cropped region to the canvas instead would zoom the shot on every edge drag,
 * which reads as the picture stretching.
 *
 * Taken from the rounded rect the texture was actually cut to, so the quad and
 * its pixels agree to the pixel rather than to the param.
 */
export function getCropPlacement({
	cropRect,
	width,
	height,
}: {
	cropRect: CropRect | null;
	width: number;
	height: number;
}): {
	keptFractionX: number;
	keptFractionY: number;
	centerFractionX: number;
	centerFractionY: number;
} {
	if (!cropRect || width <= 0 || height <= 0) {
		return {
			keptFractionX: 1,
			keptFractionY: 1,
			centerFractionX: 0,
			centerFractionY: 0,
		};
	}

	return {
		keptFractionX: cropRect.width / width,
		keptFractionY: cropRect.height / height,
		centerFractionX: (cropRect.x + cropRect.width / 2) / width - 0.5,
		centerFractionY: (cropRect.y + cropRect.height / 2) / height - 0.5,
	};
}

export function hashCrop({ crop }: { crop: CropInsets | undefined }): string {
	if (!crop || !isCropActive({ crop })) return "";
	const normalized = normalizeCrop({ crop });
	return `${normalized.left}:${normalized.top}:${normalized.right}:${normalized.bottom}`;
}
