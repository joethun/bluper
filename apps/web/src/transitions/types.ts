import type { ParamDefinition, ParamValues } from "@/params";
import type { MediaTime } from "@/wasm";

/**
 * A transition instance, stored on the *incoming* clip. Its window straddles the
 * cut that clip shares with the element immediately before it on the same track:
 * the first half eats into the outgoing clip's tail, the second half into the
 * incoming clip's head. Neither clip's `startTime`/`duration` changes and the
 * project keeps its length — the overlap exists only at render time, paid for out
 * of the material each clip's trim is hiding.
 *
 * A transition therefore always needs two clips. Fading a single clip against
 * the background is a separate thing entirely; see `@/fades`.
 */
export interface ElementTransition {
	id: string;
	type: string;
	duration: MediaTime;
	params: ParamValues;
}

export type TransitionCategory = "basic" | "wipe" | "motion" | "camera";

/**
 * The reveal geometry for one side of a transition, expressed in the layer's own
 * pixel box (0,0 = top-left of the drawn quad). Rasterised into a mask texture
 * by the compositor.
 */
export type TransitionShape =
	| {
			kind: "linear";
			/** Sweep direction: 0 = left→right, 90 = top→bottom, 180 = right→left. */
			angleDegrees: number;
			/** 0 = nothing revealed, 1 = fully revealed. */
			progress: number;
			/** Width of the soft edge as a fraction of the sweep length. */
			softness: number;
	  }
	| {
			kind: "radial";
			progress: number;
			softness: number;
			/** When true the disc closes over the layer instead of opening it up. */
			inverted: boolean;
	  }
	| {
			kind: "angular";
			progress: number;
			softness: number;
			/** Where the sweep starts, in degrees clockwise from 12 o'clock. */
			startDegrees: number;
	  }
	| {
			kind: "tiles";
			progress: number;
			/**
			 * Tiles along the layer's longer axis. The shorter axis takes however many
			 * keep them square, which is why this is a count rather than a grid: the
			 * mask is rasterised in the layer's own box, whose shape is not known here.
			 */
			count: number;
			/**
			 * How much of the window is spent spreading the tiles' start times, 0–1. At
			 * 0 every tile arrives together and the reveal is a plain dissolve; at 1
			 * they arrive strictly one after another.
			 */
			stagger: number;
	  };

/** How one of the two clips is drawn at a point in the transition. */
export interface TransitionSideState {
	/** Multiplied onto the layer's own resolved opacity. */
	opacity: number;
	offsetX: number;
	offsetY: number;
	/** Multiplied onto the layer's own resolved scale. */
	scale: number;
	/** Added to the layer's own resolved rotation. */
	rotateDegrees: number;
	blurSigma: number;
	shape: TransitionShape | null;
}

/**
 * A full-canvas wash drawn above both clips — how "flash white" and friends get
 * their colour. Emitted as its own compositor layer.
 */
export interface TransitionOverlay {
	color: string;
	opacity: number;
}

export interface TransitionFrame {
	outgoing: TransitionSideState;
	incoming: TransitionSideState;
	overlay?: TransitionOverlay;
}

interface TransitionResolveArgs {
	/** 0 at the start of the window, 1 at the end. */
	progress: number;
	params: ParamValues;
	width: number;
	height: number;
}

export interface TransitionDefinition {
	type: string;
	name: string;
	category: TransitionCategory;
	keywords: string[];
	defaultDuration: MediaTime;
	params: ParamDefinition[];
	resolve(args: TransitionResolveArgs): TransitionFrame;
}
