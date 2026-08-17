import type { ParamDefinition, ParamValues } from "@/params";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export type EffectUniformValue = number | number[];

export interface EffectPass {
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
}

interface EffectPassTemplate {
	shader: string;
	uniforms(params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}): Record<string, EffectUniformValue>;
}

interface EffectRendererConfig {
	passes: EffectPassTemplate[];
	buildPasses?: (params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}) => EffectPass[];
}

export type EffectContext2D =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

/** Everything an effect is handed to draw a single frame of itself. */
interface EffectPaintContext {
	/**
	 * The target for this stage of the chain. Cleared before the effect runs and
	 * owned by it alone, so composite tricks that spill outside the layer (a
	 * `lighter` wash, a `destination-in` alpha restore) cannot reach a
	 * neighbouring layer.
	 */
	ctx: EffectContext2D;
	/**
	 * This stage's input. Always a canvas rather than a raw video frame, so an
	 * effect may read its pixels back.
	 */
	source: OffscreenCanvas;
	width: number;
	height: number;
	/** This frame's param values, with any keyframes already resolved. */
	params: ParamValues;
	/** Seconds since the element started: raw local time, unscaled. */
	time: number;
	/** 0 at the element's first frame, 1 at its last. */
	progress: number;
}

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	/**
	 * Shader passes run by the wasm compositor. Only the shaders the compositor
	 * was built with can be named here, so the bundled effects paint on the
	 * canvas instead (see `paint`).
	 */
	renderer?: EffectRendererConfig;
	/** Draws one frame of the effect. */
	paint?: (context: EffectPaintContext) => void;
	/**
	 * Set when the output depends on `time` or `progress`. The compositor caches a
	 * layer's texture by content hash, so an animated effect has to declare
	 * itself or it would be drawn once and then held frozen.
	 */
	animated?: boolean;
}

/** One heading in the effects library, and the effects filed under it. */
export interface EffectGroup {
	title: string;
	types: readonly string[];
}

/** One entry of a layer's effect stack, resolved for a single frame. */
export interface ResolvedEffect {
	type: string;
	params: ParamValues;
	time: number;
	progress: number;
	animated: boolean;
}
