import {
	buildDefaultParamValuesValue as _buildDefaultParamValuesValue,
	coerceParamValue as _coerceParamValue,
	formatLinearRgbaValue as _formatLinearRgbaValue,
	getFractionDigitsForStep as _getFractionDigitsForStep,
	getParamDefaultInterpolation as _getParamDefaultInterpolation,
	getParamNumericRange as _getParamNumericRange,
	parseColorToLinearRgbaValue as _parseColorToLinearRgbaValue,
	snapToStepValue as _snapToStepValue,
} from "bluper-wasm";
import type { ParamDefinition, ParamValue, ParamValues } from "@/params";

/**
 * Parameter values and colour handling, now owned by `editor-core::params`.
 *
 * The colour parser replaces `culori` for the formats this editor produces and
 * accepts — hex in all four lengths, `rgb()`/`rgba()`, `hsl()`/`hsla()`, the CSS
 * named colours — and refuses what culori refused, including the
 * `hsl(var(--background))` a theme hands in. It was compared against culori on
 * every format the codebase contains before the swap.
 */

export interface LinearRgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * A CSS colour in *linear* light, or `null` when the string is not a colour.
 *
 * Linear rather than sRGB because that is the space a colour keyframe
 * interpolates in: blending two sRGB numbers directly darkens the midpoint,
 * which reads as a muddy band halfway through the transition.
 */
export function parseColorToLinearRgba({
	color,
}: {
	color: string;
}): LinearRgba | null {
	return _parseColorToLinearRgbaValue({ color }).color ?? null;
}

/** Back to hex, with an alpha pair only when it is not fully opaque. */
export function formatLinearRgba({ color }: { color: LinearRgba }): string {
	return _formatLinearRgbaValue({ color });
}

/**
 * Narrow a value to what the parameter can hold, or `null` to refuse it.
 * A number is snapped to its step and clamped to its bounds; a select only
 * accepts one of its own options.
 */
export function coerceParamValue({
	param,
	value,
}: {
	param: ParamDefinition;
	value: unknown;
}): ParamValue | null {
	return (
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		_coerceParamValue({ param: param as never, value: value as never }).value ??
		null
	);
}

export function getParamNumericRange({
	param,
}: {
	param: ParamDefinition;
}): { min?: number; max?: number; step?: number } | undefined {
	return (
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		_getParamNumericRange({ param: param as never }).range ?? undefined
	);
}

export function getParamDefaultInterpolation({
	param,
}: {
	param: ParamDefinition;
}): "linear" | "hold" {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _getParamDefaultInterpolation({ param: param as never });
}

/**
 * Snap to the nearest multiple of `step`, then trim the float noise the
 * multiplication leaves behind.
 *
 * Rust reproduces JavaScript's two different tie rules here — `Math.round`
 * breaks a tie toward positive infinity, `toFixed` breaks one away from zero —
 * because getting either wrong moves a snapped value by a whole step at exactly
 * the boundaries a slider lands on.
 */
export function snapToStep({
	value,
	step,
}: {
	value: number;
	step: number;
}): number {
	return _snapToStepValue({ value, step });
}

export function getFractionDigitsForStep({ step }: { step: number }): number {
	return _getFractionDigitsForStep({ step });
}

/**
 * Build the `{ key: default }` bag a freshly created element starts with, now
 * owned by `editor-core::params::registry`. The TS version walked the array
 * once and wrote each `param.default`; Rust does the same thing on the other
 * side of the boundary.
 */
export function buildDefaultParamValues({
	params,
}: {
	params: readonly ParamDefinition[];
}): ParamValues {
	return (
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		(_buildDefaultParamValuesValue({ params: params as never })
			.values as ParamValues) ?? {}
	);
}
