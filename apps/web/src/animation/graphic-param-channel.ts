import type {
	ElementAnimations,
	GraphicParamPath,
} from "@/animation/types";
import type { ParamDefinition, ParamValues } from "@/params";
import {
	graphicParamPath as _graphicParamPath,
	parseGraphicParamPath as _parseGraphicParamPath,
} from "@/wasm/path";
import { resolveAnimationPathValueAtTime } from "./resolve";

/**
 * Graphic-param paths, owned by `editor-core::animation::path`. The two
 * functions below are thin wrappers over the wasm facade so the rest of the
 * app keeps its existing call shape — option-struct there, positional here.
 */

export function buildGraphicParamPath({
	paramKey,
}: {
	paramKey: string;
}): GraphicParamPath {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return _graphicParamPath({ paramKey }) as GraphicParamPath;
}

export function parseGraphicParamPath({
	propertyPath,
}: {
	propertyPath: string;
}): { paramKey: string } | null {
	return _parseGraphicParamPath({ propertyPath });
}

export function resolveGraphicParamsAtTime({
	params,
	definitions,
	animations,
	localTime,
}: {
	params: ParamValues;
	definitions: ParamDefinition[];
	animations?: ElementAnimations;
	localTime: number;
}): ParamValues {
	const resolved: ParamValues = { ...params };

	for (const param of definitions) {
		const path = buildGraphicParamPath({ paramKey: param.key });
		if (!animations?.[path]) {
			continue;
		}

		resolved[param.key] = resolveAnimationPathValueAtTime({
			animations,
			propertyPath: path,
			localTime: Math.max(0, localTime),
			fallbackValue: params[param.key] ?? param.default,
		});
	}

	return resolved;
}