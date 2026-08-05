import { resolveAnimationPathValueAtTime } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import type { ParamValues } from "@/params";
import { resolveAdjustmentStacks } from "./index";
import type { Adjustment, ResolvedAdjustments } from "./types";

/**
 * The Adjust panel's sliders sit flat on the element's own params, but the maths
 * behind them already lives in the adjustment definitions. Each entry names the
 * definition that owns a slider and what that definition calls it, so a clip's
 * exposure and an adjustment layer's brightness cannot drift apart.
 */
const CLIP_ADJUSTMENT_BINDINGS: ReadonlyArray<{
	adjustmentType: string;
	params: Readonly<Record<string, string>>;
}> = [
	{
		adjustmentType: "basic",
		params: {
			brightness: "adjust.brightness",
			contrast: "adjust.contrast",
			saturation: "adjust.saturation",
		},
	},
	{
		adjustmentType: "light",
		params: {
			highlights: "adjust.highlight",
			shadows: "adjust.shadow",
		},
	},
	{
		adjustmentType: "color",
		params: {
			temperature: "adjust.temperature",
			hue: "adjust.hue",
		},
	},
	{
		adjustmentType: "stylize",
		params: {
			sharpen: "adjust.sharpness",
			vignette: "adjust.vignette",
			grain: "adjust.grain",
		},
	},
];

/**
 * Folds a clip's own Adjust sliders into one CSS filter chain plus the passes a
 * filter cannot express. Returns `null` when every slider sits at neutral, which
 * is what lets the compositor keep uploading the decoded frame itself rather
 * than a redrawn copy of it.
 */
export function resolveClipAdjustments({
	params,
}: {
	params: ParamValues;
}): ResolvedAdjustments | null {
	const stack: Adjustment[] = [];

	for (const binding of CLIP_ADJUSTMENT_BINDINGS) {
		const values: ParamValues = {};
		for (const [definitionKey, elementKey] of Object.entries(binding.params)) {
			const value = params[elementKey];
			if (typeof value === "number") {
				values[definitionKey] = value;
			}
		}
		stack.push({
			id: binding.adjustmentType,
			type: binding.adjustmentType,
			params: values,
			enabled: true,
		});
	}

	return resolveAdjustmentStacks({ stacks: [stack] });
}

/** Every element param key the Adjust panel can feed into the fold. */
const CLIP_ADJUSTMENT_PARAM_KEYS: readonly string[] =
	CLIP_ADJUSTMENT_BINDINGS.flatMap((binding) => Object.values(binding.params));

/**
 * The subset of an element's params the renderer needs in order to grade it.
 * Narrowing here rather than handing the node the whole bag keeps it obvious
 * which stored values the picture actually depends on.
 */
export function pickClipAdjustmentParams({
	params,
}: {
	params: ParamValues;
}): ParamValues {
	const picked: ParamValues = {};
	for (const key of CLIP_ADJUSTMENT_PARAM_KEYS) {
		const value = params[key];
		if (value !== undefined) {
			picked[key] = value;
		}
	}
	return picked;
}

/**
 * The grade for one frame. The sliders are keyframable, so the fold cannot happen
 * once when the scene is built — each value has to be read off its animation
 * channel at the clip's local time first.
 */
export function resolveClipAdjustmentsAtTime({
	params,
	animations,
	localTime,
}: {
	params: ParamValues | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
}): ResolvedAdjustments | null {
	if (!params) {
		return null;
	}
	if (!animations) {
		// Nothing is keyframed, so the stored values are already this frame's values.
		return resolveClipAdjustments({ params });
	}

	const atTime: ParamValues = {};
	for (const [key, value] of Object.entries(params)) {
		atTime[key] =
			typeof value === "number"
				? resolveAnimationPathValueAtTime({
						animations,
						propertyPath: key,
						localTime,
						fallbackValue: value,
					})
				: value;
	}
	return resolveClipAdjustments({ params: atTime });
}
