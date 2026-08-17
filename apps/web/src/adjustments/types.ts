import type { ParamDefinition, ParamValues } from "@/params";
import type { LucideIcon } from "lucide-react";

/** One entry in an adjustment layer's stack. */
export interface Adjustment {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

/**
 * A colour wash multiplied over the layer. `compositeOperation` is a canvas blend
 * mode, which is how temperature/tint tinting and vignetting are expressed
 * without a dedicated shader.
 */
export interface AdjustmentWash {
	kind: "wash";
	color: string;
	alpha: number;
	compositeOperation: GlobalCompositeOperation;
}

/** Darkens the frame towards its corners. */
export interface AdjustmentVignette {
	kind: "vignette";
	/** 0 = untouched, 1 = corners crushed to black. */
	amount: number;
	/** Fraction of the half-diagonal that stays untouched. */
	radius: number;
}

/** Monochrome film grain, tiled from a cached noise patch. */
export interface AdjustmentGrain {
	kind: "grain";
	amount: number;
	size: number;
}

/**
 * Local-contrast sharpening via the high-pass trick: the layer is redrawn
 * blurred and inverted with an `overlay` blend, which lifts edge contrast the
 * way an unsharp mask does. A real convolution would need a shader.
 */
export interface AdjustmentHighPass {
	kind: "highPass";
	amount: number;
	radius: number;
}

/**
 * Redraws the layer over itself with a blend mode. `screen` lifts shadows far
 * more than highlights and `multiply` deepens them, which is what makes this a
 * usable stand-in for tone-range sliders.
 */
interface AdjustmentToneCurve {
	kind: "toneCurve";
	compositeOperation: GlobalCompositeOperation;
	alpha: number;
}

export type AdjustmentOverlay =
	| AdjustmentWash
	| AdjustmentVignette
	| AdjustmentGrain
	| AdjustmentHighPass
	| AdjustmentToneCurve;

/**
 * What an adjustment contributes to a layer: a chunk of CSS filter chain plus
 * any passes that cannot be expressed as a filter.
 */
export interface AdjustmentContribution {
	filters: string[];
	overlays: AdjustmentOverlay[];
}

export interface AdjustmentDefinition {
	type: string;
	name: string;
	description: string;
	icon: LucideIcon;
	keywords: string[];
	params: ParamDefinition[];
	/** Returns nothing when every slider sits at its neutral value. */
	resolve(args: { params: ParamValues }): AdjustmentContribution;
}

/** The combined effect of a whole stack, ready for the compositor. */
export interface ResolvedAdjustments {
	filter: string;
	overlays: AdjustmentOverlay[];
}

/**
 * An adjustment layer as the renderer sees it: a stack plus the span it covers.
 * A layer beneath it only picks the stack up while the playhead is inside that
 * span, so the same clip can pass in and out of an adjustment mid-shot.
 */
export interface AdjustmentLayerBinding {
	startTime: number;
	duration: number;
	adjustments: Adjustment[];
}
