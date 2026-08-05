import type { NumberParamDefinition } from "@/params";
import type { TransitionSideState } from "@/transitions/types";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

/** CapCut ships every transition at half a second by default. */
export const DEFAULT_TRANSITION_DURATION = mediaTime({
	ticks: Math.round(TICKS_PER_SECOND * 0.5),
});

export const SLOW_TRANSITION_DURATION = mediaTime({
	ticks: Math.round(TICKS_PER_SECOND * 0.8),
});

export const MIN_TRANSITION_DURATION = mediaTime({
	ticks: Math.round(TICKS_PER_SECOND * 0.1),
});

export const SOFTNESS_PARAM: NumberParamDefinition = {
	key: "softness",
	label: "Softness",
	type: "number",
	default: 12,
	min: 0,
	max: 100,
	step: 1,
	unit: "percent",
};

export const INTENSITY_PARAM: NumberParamDefinition = {
	key: "intensity",
	label: "Intensity",
	type: "number",
	default: 50,
	min: 0,
	max: 100,
	step: 1,
	unit: "percent",
};

const MIN_TILE_COUNT = 2;
const MAX_TILE_COUNT = 24;

export const TILE_COUNT_PARAM: NumberParamDefinition = {
	key: "tiles",
	label: "Tiles",
	type: "number",
	default: 6,
	min: MIN_TILE_COUNT,
	max: MAX_TILE_COUNT,
	step: 1,
};

export const TILE_STAGGER_PARAM: NumberParamDefinition = {
	key: "stagger",
	label: "Stagger",
	type: "number",
	default: 60,
	min: 0,
	max: 100,
	step: 1,
	unit: "percent",
};

/**
 * A layer that is drawn exactly as it would be without the transition. Returned
 * fresh every call: side states are handed to the renderer, which is free to
 * fold values into them.
 */
export function neutralSide(): TransitionSideState {
	return {
		opacity: 1,
		offsetX: 0,
		offsetY: 0,
		scale: 1,
		rotateDegrees: 0,
		blurSigma: 0,
		shape: null,
	};
}

export function side(
	overrides: Partial<TransitionSideState>,
): TransitionSideState {
	return { ...neutralSide(), ...overrides };
}

export function hiddenSide(): TransitionSideState {
	return side({ opacity: 0 });
}

/** Ease-in-out, the curve CapCut's motion transitions read as. */
export function smoothstep({ progress }: { progress: number }): number {
	const clamped = Math.min(1, Math.max(0, progress));
	return clamped * clamped * (3 - 2 * clamped);
}

/** 0 at both ends of the window, 1 in the middle. */
export function triangle({ progress }: { progress: number }): number {
	return 1 - Math.abs(progress * 2 - 1);
}

export function readSoftness({ value }: { value: unknown }): number {
	return typeof value === "number"
		? Math.min(1, Math.max(0, value / 100))
		: SOFTNESS_PARAM.default / 100;
}

export function readIntensity({ value }: { value: unknown }): number {
	return typeof value === "number"
		? Math.min(1, Math.max(0, value / 100))
		: INTENSITY_PARAM.default / 100;
}

/** Tiles across the long axis. Fractions would leave a part-tile at the edge. */
export function readTileCount({ value }: { value: unknown }): number {
	const count = typeof value === "number" ? value : TILE_COUNT_PARAM.default;
	return Math.round(Math.min(MAX_TILE_COUNT, Math.max(MIN_TILE_COUNT, count)));
}

export function readStagger({ value }: { value: unknown }): number {
	return typeof value === "number"
		? Math.min(1, Math.max(0, value / 100))
		: TILE_STAGGER_PARAM.default / 100;
}
