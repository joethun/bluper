import { generateUUID } from "@/utils/id";
import { buildDefaultParamValues } from "@/params/registry";
import { effectsRegistry } from "./registry";
import type { ParamValues } from "@/params";
import type { Effect, EffectDefinition, EffectPass } from "@/effects/types";

export { effectsRegistry } from "./registry";
export { EFFECT_GROUPS, registerDefaultEffects } from "./definitions";
export { resolveCanvasEffects } from "./clip";
export { hashResolvedEffects, paintEffectedLayer } from "./paint";

export function resolveEffectPasses({
	definition,
	effectParams,
	width,
	height,
}: {
	definition: EffectDefinition;
	effectParams: ParamValues;
	width: number;
	height: number;
}): EffectPass[] {
	if (!definition.renderer) {
		return [];
	}
	if (definition.renderer.buildPasses) {
		return definition.renderer.buildPasses({ effectParams, width, height });
	}
	return definition.renderer.passes.map((pass) => ({
		shader: pass.shader,
		uniforms: pass.uniforms({ effectParams, width, height }),
	}));
}

export function buildDefaultEffectInstance({
	effectType,
}: {
	effectType: string;
}): Effect {
	const definition = effectsRegistry.get(effectType);
	const params: ParamValues = buildDefaultParamValues(definition.params);

	return {
		id: generateUUID(),
		type: effectType,
		params,
		enabled: true,
	};
}
