import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import type { ElementAnimations } from "@/animation/types";
import { effectsRegistry } from "./registry";
import type { Effect, ResolvedEffect } from "./types";

/**
 * Folds a layer's effect stack down to what the canvas painter needs for one
 * frame: this frame's param values, and where in the element this frame sits.
 *
 * Only the entries that paint are returned. An effect backed by a compositor
 * shader is resolved separately into passes (see `resolveEffectPasses`), and a
 * disabled one contributes nothing either way.
 */
export function resolveCanvasEffects({
	effects,
	animations,
	localTime,
	duration,
}: {
	effects: Effect[] | undefined;
	animations: ElementAnimations | undefined;
	localTime: number;
	duration: number;
}): ResolvedEffect[] {
	if (!effects || effects.length === 0) {
		return [];
	}

	const time = Math.max(0, localTime);
	const progress = duration > 0 ? Math.min(1, time / duration) : 0;

	return effects
		.filter((effect) => effect.enabled && effectsRegistry.has(effect.type))
		.filter((effect) => Boolean(effectsRegistry.get(effect.type).paint))
		.map((effect) => ({
			type: effect.type,
			params: resolveEffectParamsAtTime({
				effectId: effect.id,
				params: effect.params,
				animations,
				localTime: time,
			}),
			time,
			progress,
			animated: effectsRegistry.get(effect.type).animated === true,
		}));
}
