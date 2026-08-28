import {
	MAX_FEATHER as _MAX_FEATHER,
	getDefaultBaseMaskParams as _getDefaultBaseMaskParams,
	getStrokeOffset as _getStrokeOffset,
	getDefaultSquareMaskParams as _getDefaultSquareMaskParams,
	getBoxLikeGeometry as _getBoxLikeGeometry,
	computeFeatherUpdate as _computeFeatherUpdate,
	computeBoxMaskParamUpdate as _computeBoxMaskParamUpdate,
} from "bluper-wasm";
import type {
	BaseMaskParams,
	MaskDefaultContext,
	MaskFeatures,
	MaskInteractionDefinition,
	MaskParamUpdateArgs,
	RectangleMaskParams,
} from "@/masks/types";
import type { NumberParamDefinition, ParamDefinition } from "@/params";
import {
	getBoxMaskHandlePositions,
	getBoxMaskOverlays,
} from "@/wasm/mask-handles";
import { snapBoxMaskInteraction } from "@/masks/snap";

/**
 * Box-like mask parameter defaults, geometry helpers and handle-drag dispatch.
 * Owned by `editor-core::masks::builtin::box_like` (and `computeFeatherUpdate`
 * folded in from the old `masks/param-update.ts`).
 *
 * `BOX_LIKE_MASK_PARAMS` and `buildBoxMaskInteraction` stay TS — they're
 * plugin-layer data (the params spec is a list of `ParamDefinition`s, the
 * interaction is a closure-returning factory) that wasm-bindgen cannot bridge.
 */

const PERCENTAGE_DISPLAY: Pick<
	NumberParamDefinition,
	"displayMultiplier" | "step"
> = {
	displayMultiplier: 100,
	step: 1,
};

export const BOX_LIKE_MASK_PARAMS: ParamDefinition<
	keyof RectangleMaskParams & string
>[] = [
	{
		key: "centerX",
		label: "X",
		type: "number",
		default: 0,
		min: -100,
		max: 100,
		...PERCENTAGE_DISPLAY,
	},
	{
		key: "centerY",
		label: "Y",
		type: "number",
		default: 0,
		min: -100,
		max: 100,
		...PERCENTAGE_DISPLAY,
	},
	{
		key: "width",
		label: "Width",
		type: "number",
		default: 0.6,
		min: 1,
		...PERCENTAGE_DISPLAY,
	},
	{
		key: "height",
		label: "Height",
		type: "number",
		default: 0.6,
		min: 1,
		...PERCENTAGE_DISPLAY,
	},
	{
		key: "rotation",
		label: "Rotation",
		type: "number",
		default: 0,
		min: 0,
		max: 360,
		step: 1,
	},
	{
		key: "scale",
		label: "Scale",
		type: "number",
		default: 1,
		min: 1,
		max: 500,
		...PERCENTAGE_DISPLAY,
	},
	{
		key: "strokeAlign",
		label: "Stroke Align",
		type: "select",
		default: "center",
		options: [
			{ value: "inside", label: "Inside" },
			{ value: "center", label: "Center" },
			{ value: "outside", label: "Outside" },
		],
	},
];

export function getDefaultBaseMaskParams(): BaseMaskParams {
	const result = _getDefaultBaseMaskParams();
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result as BaseMaskParams;
}

export function getStrokeOffset({
	strokeAlign,
	strokeWidth,
}: Pick<BaseMaskParams, "strokeAlign" | "strokeWidth">): number {
	return _getStrokeOffset({
		stroke_align: strokeAlign,
		stroke_width: strokeWidth,
	});
}

export function getDefaultSquareMaskParams({
	elementSize,
}: MaskDefaultContext): RectangleMaskParams {
	const result = _getDefaultSquareMaskParams({
		elementSize: elementSize
			? { width: elementSize.width, height: elementSize.height }
			: undefined,
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result as RectangleMaskParams;
}

export function getBoxLikeGeometry({
	params,
	width,
	height,
}: {
	params: RectangleMaskParams;
	width: number;
	height: number;
}) {
	return _getBoxLikeGeometry({ params, width, height });
}

export function buildBoxMaskInteraction({
	sizeMode,
	buildOverlayPath,
	showBoundingBox = true,
}: {
	sizeMode: MaskFeatures["sizeMode"];
	buildOverlayPath?: (args: { width: number; height: number }) => string;
	showBoundingBox?: boolean;
}): MaskInteractionDefinition<RectangleMaskParams> {
	return {
		getInteraction({ params, bounds, displayScale, scaleX, scaleY }) {
			return {
				handles: getBoxMaskHandlePositions({
					centerX: params.centerX,
					centerY: params.centerY,
					width: params.width,
					height: params.height,
					rotation: params.rotation,
					feather: params.feather,
					sizeMode,
					bounds,
					displayScale,
				}),
				overlays: getBoxMaskOverlays({
					params,
					bounds,
					pathData: buildOverlayPath?.({
						width: params.width * bounds.width * scaleX,
						height: params.height * bounds.height * scaleY,
					}),
					showBoundingBox,
				}),
			};
		},
		snap(args) {
			return snapBoxMaskInteraction(args);
		},
	};
}

export function computeBoxMaskParamUpdate({
	handleId,
	startParams,
	deltaX,
	deltaY,
	bounds,
}: MaskParamUpdateArgs<RectangleMaskParams>): Partial<RectangleMaskParams> {
	return _computeBoxMaskParamUpdate({
		handleId,
		startParams,
		deltaX,
		deltaY,
		bounds,
	}) as Partial<RectangleMaskParams>;
}

/**
 * Read at module load so the param registry doesn't round-trip through wasm at
 * import time; the Rust source of truth lives in
 * `editor-core::masks::builtin::box_like`.
 */
export const MAX_FEATHER = _MAX_FEATHER();

/**
 * Re-exported so existing callers (`computeBoxMaskParamUpdate`'s `feather` case)
 * can keep their import path. Trivial 5-line math, but the bridge gives a single
 * place to keep the JS-rounding rule (half-tie break toward positive infinity,
 * preserving sign of zero) and lets `compute_text_mask_param_update` and
 * `compute_split_mask_param_update` deduplicate to one implementation later.
 */
export function computeFeatherUpdate({
	startFeather,
	deltaX,
	deltaY,
	directionX,
	directionY,
}: {
	startFeather: number;
	deltaX: number;
	deltaY: number;
	directionX: number;
	directionY: number;
}): { feather: number } {
	return {
		feather: _computeFeatherUpdate({
			startFeather,
			deltaX,
			deltaY,
			directionX,
			directionY,
		}),
	};
}
