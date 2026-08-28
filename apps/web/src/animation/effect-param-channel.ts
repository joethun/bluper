import type {
	ElementAnimations,
	EffectParamPath,
} from "@/animation/types";
import type { ParamValues } from "@/params";
import { removeElementKeyframe } from "@/wasm/keyframes";
import {
	effectParamPath as _effectParamPath,
	parseEffectParamPath as _parseEffectParamPath,
} from "@/wasm/path";
import { resolveAnimationPathValueAtTime } from "./resolve";

/**
 * Effect-param paths, owned by `editor-core::animation::path`. The two
 * functions below are thin wrappers over the wasm facade so the rest of the
 * app keeps its existing call shape — option-struct there, positional here.
 */

export function buildEffectParamPath({
	effectId,
	paramKey,
}: {
	effectId: string;
	paramKey: string;
}): EffectParamPath {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _effectParamPath({ effectId, paramKey }) as EffectParamPath;
}

export function parseEffectParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { effectId: string; paramKey: string } | null {
	return _parseEffectParamPath({ propertyPath });
}

export function resolveEffectParamsAtTime({
	effectId,
	params,
	animations,
	localTime,
}: {
	effectId: string;
	params: ParamValues;
	animations: ElementAnimations | undefined;
	localTime: number;
}): ParamValues {
	if (!animations) {
		// No channels to consult, so every param resolves to its stored value.
		// Worth its own branch because the loop below builds an animation path
		// string per param, and this runs for every effect on every frame.
		return { ...params };
	}

	const safeLocalTime = Math.max(0, localTime);
	const resolved: ParamValues = {};

	for (const [paramKey, staticValue] of Object.entries(params)) {
		const path = buildEffectParamPath({ effectId, paramKey });
		resolved[paramKey] = animations[path]
			? resolveAnimationPathValueAtTime({
					animations,
					propertyPath: path,
					localTime: safeLocalTime,
					fallbackValue: staticValue,
				})
			: staticValue;
	}

	return resolved;
}

export function removeEffectParamKeyframe({
	animations,
	effectId,
	paramKey,
	keyframeId,
}: {
	animations: ElementAnimations | undefined;
	effectId: string;
	paramKey: string;
	keyframeId: string;
}): ElementAnimations | undefined {
	return removeElementKeyframe({
		animations,
		propertyPath: buildEffectParamPath({ effectId, paramKey }),
		keyframeId,
	});
}