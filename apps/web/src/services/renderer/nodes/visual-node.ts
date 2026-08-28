import { BaseNode } from "./base-node";
import type { AdjustmentLayerBinding, ResolvedAdjustments } from "@/adjustments/types";
import type { ParamValues } from "@/params";
import type { Effect, EffectPass, ResolvedEffect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { CropInsets } from "@/crop";
import type { BlendMode, Transform } from "@/rendering";
import type { FadeConfig, RetimeConfig, VisualElement } from "@/timeline";
import type { TransitionBinding } from "@/transitions";
import type {
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
	/**
	 * How much of each edge of the source the clip throws away. Resolved once at
	 * scene-build time rather than per frame, because crop is not keyframable —
	 * the cropped size is the geometry everything else fits to the canvas.
	 */
	crop?: CropInsets;
	/**
	 * Extra ticks the clip keeps drawing past its own end, holding its last
	 * frame, to cover a seam narrower than a frame before the next clip starts.
	 *
	 * A trim or a drag can leave a few ticks of nothing between two clips that
	 * look flush on the timeline. At the project's frame rate that sliver cannot
	 * be a frame of its own, but the playhead can still land inside it — and then
	 * neither clip is on and the clear colour shows through as a black flash at
	 * the join. Set by the scene builder, which is the only place that can see
	 * both neighbours.
	 */
	tailHold?: number;
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
