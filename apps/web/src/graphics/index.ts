import { resolveGraphicParamsAtTime } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamDefinition, ParamValues } from "@/params";
import { graphicsRegistry } from "./registry";
import {
	registerDefaultGraphics,
} from "./definitions";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	type GraphicInstance,
	type GraphicDefinition,
} from "./types";

const graphicPreviewUrlCache = new Map<string, string>();

const FALLBACK_CORNER_RADIUS_RATIO = 0.2;
const FALLBACK_FILL_OPACITY = 0.08;
const FALLBACK_MIN_FONT_SIZE = 12;
const FALLBACK_FONT_SIZE_RATIO = 0.15;

function buildFallbackPreviewUrl({
	name,
	size,
}: {
	name: string;
	size: number;
}): string {
	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
			<rect width="${size}" height="${size}" rx="${size * FALLBACK_CORNER_RADIUS_RATIO}" fill="white" fill-opacity="${FALLBACK_FILL_OPACITY}" />
			<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="white" font-size="${Math.max(FALLBACK_MIN_FONT_SIZE, size * FALLBACK_FONT_SIZE_RATIO)}" font-family="sans-serif">${name}</text>
		</svg>
	`;
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function getGraphicDefinition({
	definitionId,
}: {
	definitionId: string;
}): GraphicDefinition {
	registerDefaultGraphics();
	return graphicsRegistry.get(definitionId);
}

export function buildDefaultGraphicInstance({
	definitionId,
}: {
	definitionId: string;
}): GraphicInstance {
	const definition = getGraphicDefinition({ definitionId });
	return {
		definitionId,
		params: buildDefaultParamValues({ params: definition.params }),
	};
}

/**
 * Each definition's default param values, keyed on the definition's param list.
 *
 * A definition's params are declared once at module load and never change, but
 * `resolveGraphicParams` sits under the per-frame resolve for every graphic,
 * sticker and shape on screen, so it was rebuilding the same defaults bag on
 * every frame just to spread the element's stored values over it. The cached
 * bag is only ever read from — it is spread into a new object below, never
 * handed to a caller — so a single shared copy is safe.
 */
const defaultParamsByDefinition = new WeakMap<
	readonly ParamDefinition[],
	ParamValues
>();

function getDefaultGraphicParams({
	definition,
}: {
	definition: GraphicDefinition;
}): ParamValues {
	const cached = defaultParamsByDefinition.get(definition.params);
	if (cached) {
		return cached;
	}

	const defaults = buildDefaultParamValues({ params: definition.params });
	defaultParamsByDefinition.set(definition.params, defaults);
	return defaults;
}

function resolveGraphicParams({
	definition,
	params,
}: {
	definition: GraphicDefinition;
	params?: ParamValues;
}): ParamValues {
	return {
		...getDefaultGraphicParams({ definition }),
		...(params ?? {}),
	};
}

export function resolveGraphicElementParamsAtTime({
	element,
	localTime,
}: {
	element: {
		definitionId: string;
		params: ParamValues;
		animations?: ElementAnimations;
	};
	localTime: number;
}): ParamValues {
	const definition = getGraphicDefinition({
		definitionId: element.definitionId,
	});
	return resolveGraphicParamsAtTime({
		params: resolveGraphicParams({
			definition,
			params: element.params,
		}),
		definitions: definition.params,
		animations: element.animations,
		localTime,
	});
}

export function buildGraphicPreviewUrl({
	definitionId,
	params,
	size = DEFAULT_GRAPHIC_SOURCE_SIZE,
}: {
	definitionId: string;
	params?: ParamValues;
	size?: number;
}): string {
	const definition = getGraphicDefinition({ definitionId });
	const resolvedParams = resolveGraphicParams({ definition, params });
	const cacheKey = JSON.stringify({ definitionId, resolvedParams, size });
	const cachedUrl = graphicPreviewUrlCache.get(cacheKey);
	if (cachedUrl) {
		return cachedUrl;
	}

	if (typeof document === "undefined") {
		return buildFallbackPreviewUrl({ name: definition.name, size });
	}

	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return buildFallbackPreviewUrl({ name: definition.name, size });
	}

	definition.render({
		ctx,
		params: resolvedParams,
		width: size,
		height: size,
	});

	const previewUrl = canvas.toDataURL("image/png");
	graphicPreviewUrlCache.set(cacheKey, previewUrl);
	return previewUrl;
}

export {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	graphicsRegistry,
	registerDefaultGraphics,
};
export type { GraphicDefinition, GraphicInstance } from "./types";
