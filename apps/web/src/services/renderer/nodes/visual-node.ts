import { BaseNode } from "./base-node";
import type { AdjustmentLayerBinding, ResolvedAdjustments } from "@/adjustments/types";
import type { ParamValues } from "@/params";
import type { Effect, EffectPass, ResolvedEffect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { FadeConfig, RetimeConfig, VisualElement } from "@/timeline";
import type {
	TransitionBinding,
	TransitionOverlay,
	TransitionShape,
} from "@/transitions/types";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/** Both sides of every cut this clip takes part in. */
	transitions?: TransitionBinding[];
	/** Opacity ramps on the clip's own head and tail. */
	fade?: FadeConfig;
	/** Adjustment layers stacked above this clip, innermost first. */
	adjustmentLayers?: AdjustmentLayerBinding[];
	/**
	 * The clip's Adjust sliders as stored. Folded per frame rather than at
	 * scene-build time because they can be keyframed.
	 */
	adjustParams?: ParamValues;
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	/**
	 * The entries of the clip's effect stack that paint on the canvas, in stack
	 * order. Kept apart from `effectPasses` because these run while the layer's
	 * texture is being drawn rather than on the composited quad.
	 */
	canvasEffects: ResolvedEffect[];
	/**
	 * The reveal geometry for an in-flight transition, in the layer's own pixel
	 * box. Rasterised into a mask by the compositor; `null` outside a transition.
	 */
	transitionShape: TransitionShape | null;
	/** A full-canvas wash to draw above this layer, e.g. a white flash. */
	transitionOverlay: TransitionOverlay | null;
	adjustments: ResolvedAdjustments | null;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
