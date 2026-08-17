import {
	clampMediaTime,
	mediaTime,
	mediaTimeToSeconds,
	type MediaTime,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { getElementLocalTime } from "@/animation";
import { resolveEffectParamsAtTime } from "@/animation/effect-param-channel";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/effects/definitions/blur";
import {
	effectsRegistry,
	resolveCanvasEffects,
	resolveEffectPasses,
} from "@/effects";
import type { Effect, EffectPass } from "@/effects/types";
import { resolveClipAdjustmentsAtTime } from "@/adjustments/clip";
import {
	logTransitionFrameMiss,
	logTransitionSide,
} from "@/diagnostics/transition-debug";
import { resolveFadeOpacity } from "@/fades";
import { resolveSampledSourceTime } from "@/freeze";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	DEFAULT_GRAPHIC_SOURCE_SIZE,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import {
	buildTextBackgroundFromElement,
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { resolveColorAtTime, resolveOpacityAtTime } from "@/animation/values";
import type { Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import {
	getActiveTransitionBinding,
	getTransitionRenderExtension,
	isShapeFullyOpaque,
	isShapeFullyTransparent,
	resolveTransitionFrame,
} from "@/transitions";
import type {
	TransitionBinding,
	TransitionOverlay,
	TransitionSideState,
} from "@/transitions/types";
import type { VideoSample } from "mediabunny";
import { videoCache } from "@/services/video-cache/service";
import type { CanvasRenderer } from "./canvas-renderer";
import type { AnyBaseNode } from "./nodes/base-node";
import {
	BlurBackgroundNode,
	type BackdropSource,
	type ResolvedBlurBackgroundNodeState,
} from "./nodes/blur-background-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "./nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "./nodes/graphic-node";
import { ImageNode, loadImageSource } from "./nodes/image-node";
import { StickerNode, loadStickerSource } from "./nodes/sticker-node";
import { TextNode, type ResolvedTextNodeState } from "./nodes/text-node";
import { VideoNode } from "./nodes/video-node";
import type {
	ResolvedVisualNodeState,
	ResolvedVisualSourceNodeState,
	VisualNodeParams,
} from "./nodes/visual-node";

type ResolveContext = {
	renderer: CanvasRenderer;
	time: number;
};

export async function resolveRenderTree({
	node,
	renderer,
	time,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	time: number;
}): Promise<void> {
	await resolveNode({
		node,
		context: {
			renderer,
			time,
		},
	});
}

/**
 * Closes a decoded frame that has been replaced, unless the replacement is the
 * very same frame. The `keep` guard matters because a resolve that bails out
 * early leaves the previous state in place, and closing it then would blank the
 * layer that is still on screen.
 */
function releaseVideoFrame({
	frame,
	keep,
}: {
	frame: CanvasImageSource | undefined;
	keep: CanvasImageSource | undefined;
}): void {
	if (typeof VideoFrame === "undefined") return;
	if (!(frame instanceof VideoFrame) || frame === keep) return;
	try {
		frame.close();
	} catch {
		// already closed
	}
}

async function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> {
	if (node instanceof VideoNode) {
		// `resolveVideoNode` mints a fresh `VideoFrame` for every frame it
		// resolves, and a `VideoFrame` holds a decoder buffer until it is closed.
		// The decoder's pool is small and fixed, so a frame per tick left to the
		// garbage collector starves it within seconds of playback and it starts
		// handing back frames that were never fully written — which is what the
		// torn, smeared preview was. Releasing the outgoing frame as the new one
		// lands keeps exactly one alive per node, the same swap
		// `resolveBackdropSource` does for the blur-background path.
		const previous = node.resolved?.source;
		node.resolved = await resolveVideoNode({ node, context });
		releaseVideoFrame({ frame: previous, keep: node.resolved?.source });
	} else if (node instanceof ImageNode) {
		node.resolved = await resolveImageNode({ node, context });
	} else if (node instanceof StickerNode) {
		node.resolved = await resolveStickerNode({ node, context });
	} else if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
	} else if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
	} else if (node instanceof BlurBackgroundNode) {
		node.resolved = await resolveBlurBackgroundNode({ node, context });
	} else if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}

	await Promise.all(
		node.children.map((child) => resolveNode({ node: child, context })),
	);
}

function resolveEffectPassGroups({
	effects,
	animations,
	localTime,
	width,
	height,
}: {
	effects: Effect[] | undefined;
	animations: VisualNodeParams["animations"];
	localTime: number;
	width: number;
	height: number;
}): EffectPass[][] {
	return (
		(effects ?? [])
			.filter((effect) => effect.enabled && effectsRegistry.has(effect.type))
			.map((effect) => {
				const resolvedParams = resolveEffectParamsAtTime({
					effectId: effect.id,
					params: effect.params,
					animations,
					localTime,
				});
				const definition = effectsRegistry.get(effect.type);
				return resolveEffectPasses({
					definition,
					effectParams: resolvedParams,
					width,
					height,
				});
			})
			// An effect that paints on the canvas contributes no shader passes, and the
			// compositor treats an empty pass group as an error rather than a no-op.
			.filter((passes) => passes.length > 0)
	);
}

/**
 * How far outside its own span a clip still has to be drawn. A transition
 * overlaps the two clips it joins without moving either one, so the incoming
 * clip has to start drawing before its `startTime` and the outgoing clip has to
 * keep drawing past its end.
 *
 * Cached per `VisualNodeParams` reference: every input is constant for a given
 * clip, so the per-frame calls only need to hit a property read after the
 * first call.
 */
const renderExtensionCache = new WeakMap<
	VisualNodeParams,
	{ head: number; tail: number }
>();

function getRenderExtension({ params }: { params: VisualNodeParams }): {
	head: number;
	tail: number;
} {
	const cached = renderExtensionCache.get(params);
	if (cached) return cached;
	const result =
		!params.transitions || params.transitions.length === 0
			? { head: 0, tail: 0 }
			: getTransitionRenderExtension({ bindings: params.transitions });
	renderExtensionCache.set(params, result);
	return result;
}

/**
 * Whether the clip contributes pixels at `time`, counting the overlap its
 * transitions borrow on either side of the cut.
 */
function isWithinRenderWindow({
	params,
	time,
}: {
	params: VisualNodeParams;
	time: number;
}): boolean {
	const { head, tail } = getRenderExtension({ params });
	const clipTime = time - params.timeOffset;
	return clipTime >= -head && clipTime < params.duration + tail;
}

/**
 * Everything about a clip's visibility at `context.time` that doesn't depend on
 * the source's dimensions: whether it draws at all, and the transition/fade
 * state the draw needs. Returns `null` when the clip contributes no pixels.
 *
 * Split out from `resolveVisualState` so the video path can decide whether to
 * decode a frame before paying for one it would throw away — the common case is
 * a transition side pushed outside its own clip head/tail. Callers pass the
 * result back into `resolveVisualState` rather than letting it recompute, so
 * `resolveTransitionFrame` runs once per clip per frame instead of twice.
 */
interface VisualGate {
	clipTime: number;
	binding: TransitionBinding | null;
	fadeOpacity: number;
	transitionSide: TransitionSideState | null;
	overlay: TransitionOverlay | null;
	isSideHidden: boolean;
}

function resolveVisualGate({
	params,
	context,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
}): VisualGate | null {
	if (!isWithinRenderWindow({ params, time: context.time })) {
		return null;
	}

	const clipTime = context.time - params.timeOffset;
	// Fades multiply in alongside a transition rather than replacing it: a clip can
	// legitimately fade up from the background at the top of the timeline and still
	// cross-fade into its neighbour at the other end.
	const fadeOpacity = resolveFadeOpacity({
		fade: params.fade,
		clipTime,
		duration: params.duration,
	});
	const binding = getActiveTransitionBinding({
		bindings: params.transitions ?? [],
		time: context.time,
	});
	// Outside its own span the clip exists only to fill one side of a transition.
	// With no transition running there is nothing to draw.
	if (!binding && (clipTime < 0 || clipTime >= params.duration)) {
		return null;
	}

	const transitionFrame = binding
		? resolveTransitionFrame({
				binding,
				time: context.time,
				width: context.renderer.width,
				height: context.renderer.height,
			})
		: null;
	const transitionSide =
		binding && transitionFrame
			? binding.role === "incoming"
				? transitionFrame.incoming
				: transitionFrame.outgoing
			: null;

	// The wash rides on the incoming clip's node, so that node has to survive even
	// when its own pixels are hidden — "flash white" hides the incoming clip for
	// the first half of the window, which is exactly when the flash ramps up.
	const overlay =
		binding?.role === "incoming" && transitionFrame?.overlay
			? transitionFrame.overlay
			: null;
	const isSideHidden =
		fadeOpacity <= 0 ||
		Boolean(
			transitionSide &&
			(transitionSide.opacity <= 0 ||
				(transitionSide.shape &&
					isShapeFullyTransparent({ shape: transitionSide.shape }))),
		);
	// Nothing of this side is visible and it carries no wash: skip the layer
	// rather than upload a fully transparent mask for it.
	if (isSideHidden && !overlay) {
		return null;
	}

	return { clipTime, binding, fadeOpacity, transitionSide, overlay, isSideHidden };
}

function resolveVisualState({
	params,
	context,
	gate,
	sourceWidth,
	sourceHeight,
}: {
	params: VisualNodeParams;
	context: ResolveContext;
	gate: VisualGate;
	sourceWidth: number;
	sourceHeight: number;
}): ResolvedVisualNodeState {
	const { clipTime, binding, fadeOpacity, transitionSide, overlay, isSideHidden } =
		gate;

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: params.timeOffset,
		elementDuration: params.duration,
	});
	const baseTransform = resolveTransformAtTime({
		baseTransform: params.transform,
		animations: params.animations,
		localTime,
	});
	const baseOpacity = resolveOpacityAtTime({
		baseOpacity: params.opacity,
		animations: params.animations,
		localTime,
	});
	const transform = transitionSide
		? applyTransitionSideToTransform({
				transform: baseTransform,
				side: transitionSide,
			})
		: baseTransform;
	const opacity =
		(transitionSide ? baseOpacity * transitionSide.opacity : baseOpacity) *
		fadeOpacity;
	const containScale = Math.min(
		context.renderer.width / sourceWidth,
		context.renderer.height / sourceHeight,
	);
	const effectWidth = Math.round(
		Math.abs(sourceWidth * containScale * transform.scaleX),
	);
	const effectHeight = Math.round(
		Math.abs(sourceHeight * containScale * transform.scaleY),
	);
	const effectPasses = resolveEffectPassGroups({
		effects: params.effects,
		animations: params.animations,
		localTime,
		width: effectWidth,
		height: effectHeight,
	});
	// The transition's own defocus runs after the clip's effects so it reads as a
	// camera move on the finished look rather than something baked underneath it.
	const transitionBlur =
		transitionSide && transitionSide.blurSigma > 0
			? buildGaussianBlurPasses({
					sigmaX: transitionSide.blurSigma,
					sigmaY: transitionSide.blurSigma,
				})
			: [];

	if (transitionSide) {
		logTransitionSide({
			clipTime,
			role: binding?.role ?? "?",
			opacity: isSideHidden ? 0 : opacity,
			hasShape: Boolean(transitionSide.shape),
		});
	}

	return {
		localTime,
		transform,
		// A hidden side that only survived to carry the wash contributes no pixels.
		opacity: isSideHidden ? 0 : opacity,
		effectPasses:
			transitionBlur.length > 0
				? [...effectPasses, transitionBlur]
				: effectPasses,
		canvasEffects: resolveCanvasEffects({
			effects: params.effects,
			animations: params.animations,
			localTime,
			duration: params.duration,
		}),
		transitionShape:
			!isSideHidden &&
			transitionSide?.shape &&
			!isShapeFullyOpaque({ shape: transitionSide.shape })
				? transitionSide.shape
				: null,
		// Both sides of a cut resolve the same frame, so the wash is emitted once —
		// from the incoming clip, which composites above the outgoing one.
		transitionOverlay: overlay,
		adjustments: resolveClipAdjustmentsAtTime({
			params: params.adjustParams,
			animations: params.animations,
			localTime,
		}),
	};
}

/**
 * Folds one side of a transition into the transform the clip already resolved:
 * offsets and rotation add, scale multiplies, so a transition composes with a
 * clip that is already moved, scaled or keyframed rather than overriding it.
 */
function applyTransitionSideToTransform({
	transform,
	side,
}: {
	transform: Transform;
	side: TransitionSideState;
}): Transform {
	return {
		...transform,
		position: {
			x: transform.position.x + side.offsetX,
			y: transform.position.y + side.offsetY,
		},
		scaleX: transform.scaleX * side.scale,
		scaleY: transform.scaleY * side.scale,
		rotate: transform.rotate + side.rotateDegrees,
	};
}

/**
 * The last source time this clip can sample. `trimStart` and `trimEnd` are exactly
 * the material the trim is hiding on either side, so the clip's own trim says how
 * far its handles reach — `trimStart + span + trimEnd` is the source's full length.
 * A tick short of the end keeps the request inside the final frame.
 *
 * Cached per `VideoNode["params"]` reference: every input here is constant for a
 * given clip, so a cache hit turns this from a curve-integral evaluation + tick
 * round into a property read. Export hits it on every frame for every video
 * clip; the savings are negligible per call but add up over thousands of frames.
 */
const lastSampleableSourceTimeCache = new WeakMap<
	VideoNode["params"],
	MediaTime
>();

function getLastSampleableSourceTime({
	params,
}: {
	params: VideoNode["params"];
}): MediaTime {
	const cached = lastSampleableSourceTimeCache.get(params);
	if (cached !== undefined) return cached;

	// The span is snapped before it becomes a tick count: a speed curve is an
	// integral, so it almost never lands on a whole tick the way a uniform rate
	// does, and `mediaTime` only accepts whole ticks.
	const sourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: params.duration,
			clipDuration: params.duration,
			retime: params.retime,
		}),
	});
	const result = mediaTime({
		ticks: Math.max(0, params.trimStart + sourceSpan + params.trimEnd - 1),
	});
	lastSampleableSourceTimeCache.set(params, result);
	return result;
}

/**
 * The frame to show at `clipTime`. A transition pushes each side outside its own
 * span — the incoming clip is asked to draw before its in-point, the outgoing one
 * after its out-point — and both answer by reaching into the material their trim
 * is hiding. That is the whole point: each clip keeps playing its own footage
 * through the blend, so the picture never stops and the two sides show different
 * moments rather than a pair of stills.
 *
 * The reach stops at the ends of the file. A clip already using every frame it has
 * holds its edge frame there, because there is genuinely nothing further to show.
 */
function sampleVideoFrame({
	node,
	clipTime,
}: {
	node: VideoNode;
	clipTime: number;
}): Promise<VideoSample | null> {
	const sourceTime = resolveSampledSourceTime({
		freeze: node.params.freeze,
		trimStart: node.params.trimStart,
		clipTime,
		clipDuration: node.params.duration,
		retime: node.params.retime,
	});
	const clampedSourceTime = clampMediaTime({
		time: sourceTime,
		min: ZERO_MEDIA_TIME,
		max: getLastSampleableSourceTime({ params: node.params }),
	});

	return videoCache.getSampleAt({
		mediaId: node.params.mediaId,
		sinkKey: node.params.sinkKey,
		source: node.params.source,
		time: mediaTimeToSeconds({ time: clampedSourceTime }),
	});
}

async function resolveVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	// The gate doesn't depend on sourceWidth/sourceHeight, so run it before
	// paying for a sample we would throw away — the common case is a transition
	// side outside its own clip head/tail, which the resolver still walks even
	// when the destination never gets the frame.
	const gate = resolveVisualGate({ params: node.params, context });
	if (!gate) {
		return null;
	}

	const frame = await sampleVideoFrame({ node, clipTime: gate.clipTime });
	if (!frame) {
		logTransitionFrameMiss({
			mediaId: node.params.mediaId,
			sinkKey: node.params.sinkKey,
			clipTime: gate.clipTime,
		});
		return null;
	}

	const sourceWidth = frame.displayWidth;
	const sourceHeight = frame.displayHeight;

	const visualState = resolveVisualState({
		params: node.params,
		context,
		gate,
		sourceWidth,
		sourceHeight,
	});

	return {
		...visualState,
		source: frame.toVideoFrame(),
		sourceWidth,
		sourceHeight,
	};
}

async function resolveImageNode({
	node,
	context,
}: {
	node: ImageNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});
	const gate = resolveVisualGate({ params: node.params, context });
	if (!gate) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		gate,
		sourceWidth: source.width,
		sourceHeight: source.height,
	});

	return {
		...visualState,
		source: source.source,
		sourceWidth: source.width,
		sourceHeight: source.height,
	};
}

async function resolveStickerNode({
	node,
	context,
}: {
	node: StickerNode;
	context: ResolveContext;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadStickerSource({ stickerId: node.params.stickerId });
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;
	const gate = resolveVisualGate({ params: node.params, context });
	if (!gate) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		gate,
		sourceWidth,
		sourceHeight,
	});

	return {
		...visualState,
		source: source.source,
		sourceWidth,
		sourceHeight,
	};
}

function resolveGraphicNode({
	node,
	context,
}: {
	node: GraphicNode;
	context: ResolveContext;
}): ResolvedGraphicNodeState | null {
	const gate = resolveVisualGate({ params: node.params, context });
	if (!gate) {
		return null;
	}

	const visualState = resolveVisualState({
		params: node.params,
		context,
		gate,
		sourceWidth: DEFAULT_GRAPHIC_SOURCE_SIZE,
		sourceHeight: DEFAULT_GRAPHIC_SOURCE_SIZE,
	});

	return {
		...visualState,
		resolvedParams: resolveGraphicElementParamsAtTime({
			element: node.params,
			localTime: visualState.localTime,
		}),
	};
}

function resolveTextNode({
	node,
	context,
}: {
	node: TextNode;
	context: ResolveContext;
}): ResolvedTextNodeState | null {
	if (
		context.time < node.params.startTime ||
		context.time >= node.params.startTime + node.params.duration
	) {
		return null;
	}

	const localTime = getElementLocalTime({
		timelineTime: context.time,
		elementStartTime: node.params.startTime,
		elementDuration: node.params.duration,
	});
	const background = buildTextBackgroundFromElement({ element: node.params });
	// Text owns no transitions, so its fade is the only thing multiplying the
	// authored opacity down at the edges.
	const fadeOpacity = resolveFadeOpacity({
		fade: node.params.fade,
		clipTime: context.time - node.params.startTime,
		duration: node.params.duration,
	});

	return {
		transform: resolveTransformAtTime({
			baseTransform: node.params.transform,
			animations: node.params.animations,
			localTime,
		}),
		opacity:
			resolveOpacityAtTime({
				baseOpacity: node.params.opacity,
				animations: node.params.animations,
				localTime,
			}) * fadeOpacity,
		adjustments: resolveClipAdjustmentsAtTime({
			params: node.params.adjustParams,
			animations: node.params.animations,
			localTime,
		}),
		textColor: resolveColorAtTime({
			baseColor:
				typeof node.params.params.color === "string"
					? node.params.params.color
					: "#ffffff",
			animations: node.params.animations,
			propertyPath: "color",
			localTime,
		}),
		backgroundColor: resolveColorAtTime({
			baseColor: background.color,
			animations: node.params.animations,
			propertyPath: "background.color",
			localTime,
		}),
		measuredText: measureTextElement({
			element: node.params,
			canvasHeight: node.params.canvasHeight,
			localTime,
			ctx: getTextMeasurementContext(),
		}),
	};
}

async function resolveBlurBackgroundNode({
	node,
	context,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
	const clipTime = context.time - node.params.timeOffset;
	if (clipTime < 0 || clipTime >= node.params.duration) {
		return null;
	}

	const backdropSource = await resolveBackdropSource({ node, clipTime });
	if (!backdropSource) {
		return null;
	}

	return {
		backdropSource,
		passes: buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: node.params.blurIntensity,
				resolution: context.renderer.height,
				reference: 1080,
			}),
		}),
	};
}

async function resolveBackdropSource({
	node,
	clipTime,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
}): Promise<BackdropSource | null> {
	// The blur-background path goes through the compositor's "rendered" branch
	// (a 2D canvas blit, then `uploadTexture`), not the direct-GPU video path.
	// The video branch's `closeVideoFrame` cleanup never runs on this code
	// path, so the WebCodecs frame backing last frame's resolved state would
	// otherwise be GC'd without ever being closed — and the browser's
	// finalizer logs a stall warning each time. Release the previous frame
	// right before we mint a new one, so the swap is atomic from the GPU's
	// point of view.
	const previous = node.resolved?.backdropSource?.source;
	if (previous instanceof VideoFrame) {
		try {
			previous.close();
		} catch {
			// already closed
		}
	}

	if (node.params.mediaType === "video") {
		const sourceTime = resolveSampledSourceTime({
			freeze: node.params.freeze,
			trimStart: node.params.trimStart,
			clipTime,
			clipDuration: node.params.duration,
			retime: node.params.retime,
		});
		const frame = await videoCache.getSampleAt({
			mediaId: node.params.mediaId,
			source: node.params.source,
			time: mediaTimeToSeconds({ time: sourceTime }),
		});
		if (!frame) {
			return null;
		}

		return {
			source: frame.toVideoFrame(),
			width: frame.displayWidth,
			height: frame.displayHeight,
		};
	}

	const source = await loadImageSource({ url: node.params.url });
	return {
		source: source.source,
		width: source.width,
		height: source.height,
	};
}

function resolveEffectLayerNode({
	node,
	context,
}: {
	node: EffectLayerNode;
	context: ResolveContext;
}): ResolvedEffectLayerNodeState | null {
	const time = context.time;
	if (
		time < node.params.timeOffset - 1e-6 ||
		time >= node.params.timeOffset + node.params.duration + 1e-6
	) {
		return null;
	}

	const definition = effectsRegistry.get(node.params.effectType);
	const passes = resolveEffectPasses({
		definition,
		effectParams: node.params.effectParams,
		width: context.renderer.width,
		height: context.renderer.height,
	});
	if (passes.length === 0) {
		return null;
	}

	return {
		passes,
	};
}
