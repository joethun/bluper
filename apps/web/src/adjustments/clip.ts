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
 * The bindings above with their param maps flattened once, at module load.
 * `resolveClipAdjustments` runs for every graded element on every frame, and
 * reading `Object.entries` in there built a fresh array of pairs per binding
 * per call in order to walk constants that never change.
 */
const CLIP_ADJUSTMENT_BINDING_ENTRIES: ReadonlyArray<{
	adjustmentType: string;
	entries: ReadonlyArray<readonly [string, string]>;
}> = CLIP_ADJUSTMENT_BINDINGS.map((binding) => ({
	adjustmentType: binding.adjustmentType,
	entries: Object.entries(binding.params),
}));

/**
 * Folds a clip's own Adjust sliders into one CSS filter chain plus the passes a
 * filter cannot express. Returns `null` when every slider sits at neutral, which
 * is what lets the compositor keep uploading the decoded frame itself rather
 * than a redrawn copy of it.
 */
function resolveClipAdjustments({
	params,
}: {
	params: ParamValues;
}): ResolvedAdjustments | null {
	const stack: Adjustment[] = [];

	for (const binding of CLIP_ADJUSTMENT_BINDING_ENTRIES) {
		const values: ParamValues = {};
		for (const [definitionKey, elementKey] of binding.entries) {
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

/**
 * Folds for elements whose Adjust sliders are not keyframed, keyed on the param
 * bag they were folded from.
 *
 * `adjustParams` is built once per element when the scene is built, so for the
 * common case — a clip that is graded but not animated — the fold produces the
 * same filter chain on every frame the clip is on screen. Element params are
 * replaced rather than mutated on edit, so object identity is a sound key.
 */
const foldedClipAdjustments = new WeakMap<
	ParamValues,
	ResolvedAdjustments | null
>();

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
		// Nothing is keyframed, so the stored values are already this frame's
		// values — and the same values on every other frame, so the fold is
		// remembered against the bag it came from rather than redone per frame.
		const cached = foldedClipAdjustments.get(params);
		if (cached !== undefined) {
			return cached;
		}

		const folded = resolveClipAdjustments({ params });
		foldedClipAdjustments.set(params, folded);
		return folded;
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
