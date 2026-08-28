import {
	getCropPlacementValue as _getCropPlacementValue,
	hashCropValue as _hashCropValue,
	readCropFromParamsValue as _readCropFromParamsValue,
	resolveCropRectValue as _resolveCropRectValue,
	setCropEdgeValue as _setCropEdgeValue,
} from "bluper-wasm";
import type { ParamValues } from "@/params";

/**
 * Cropping, owned by `editor-core::clip::crop`.
 *
 * Insets rather than a rect, because that is what the four controls in the panel
 * are, and because it keeps the value meaningful when the same crop is copied
 * onto a clip of a different size.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

/**
 * How much of each edge of the source is thrown away, as a fraction of that
 * axis.
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

/** Which source edge a crop inset trims. */
export type CropEdge = "left" | "right" | "top" | "bottom";

/**
 * Moves one edge to `value`, holding the opposite edge still and stopping before
 * the two would leave less than the minimum span between them. Dragging past the
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
	return _setCropEdgeValue({ crop, edge, value });
}

export function readCropFromParams({
	params,
}: {
	params: ParamValues;
}): CropInsets {
	return _readCropFromParamsValue(wasmArgs({ args: { params } }));
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
	return _resolveCropRectValue({ crop, width, height }).rect ?? null;
}

/**
 * Where the kept region sits inside the layer's box, as fractions of it.
 *
 * Cropping never changes how big the clip is drawn: the box is still fitted from
 * the whole frame, and the crop takes a sub-rectangle of it. `keptFraction` is
 * how much of each axis survives; `centerFraction` is how far the kept region's
 * middle sits from the box's middle, signed towards positive x/y.
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
	return _getCropPlacementValue({
		cropRect: cropRect ?? undefined,
		width,
		height,
	});
}

/**
 * A texture cache key. The empty string means "not cropped", so an uncropped clip
 * shares one entry however its params are written.
 */
export function hashCrop({ crop }: { crop: CropInsets | undefined }): string {
	return _hashCropValue({ crop });
}
