import {
	clampMediaTime,
	mediaTime,
	mediaTimeToSeconds,
	type MediaTime,
	roundMediaTime,
	TICKS_PER_SECOND,
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
	type TransitionBinding,
} from "@/transitions";
import type {
	TransitionOverlay,
	TransitionSideState,
} from "@/transitions/types";
import type { VideoSample } from "@/media/video-sample";
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
import { VideoNode, type ResolvedVideoNodeState } from "./nodes/video-node";
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
	// Opens the decoder cache's pass so it can retire decoders nothing has
	// asked for lately. Has to be here rather than in the preview loop: the
	// exporter, thumbnails and freeze bakes all resolve through this function
	// too, and a decoder they opened leaks just as readily.
	videoCache.beginFrame();
	await resolveNode({
		node,
		context: {
			renderer,
			time,
		},
	});
}

/**
 * Resolves `node` and then everything under it.
 *
 * Returns a promise only when something actually has to be waited for. Most of
 * a tree resolves synchronously — type, shapes, effect layers, and every clip
 * the playhead is not inside — and the walk used to be `async` throughout, so
 * each of those still cost a promise, a `Promise.all` over an empty array, and a
 * microtask hop. On a long timeline that is thousands of allocations a second
 * spent on nodes that had nothing to do.
 */
function resolveNode({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> | void {
	const pending = resolveNodeSelf({ node, context });
	if (pending) {
		return pending.then(() => resolveChildren({ node, context }));
	}
	return resolveChildren({ node, context });
}

function resolveChildren({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> | void {
	let pending: Promise<void>[] | null = null;
	for (const child of node.children) {
		const result = resolveNode({ node: child, context });
		if (result) {
			(pending ??= []).push(result);
		}
	}
	if (pending) {
		return Promise.all(pending).then(() => undefined);
	}
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
	frame: unknown;
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

/**
 * The `VideoFrame` to hand downstream for `sample`, reusing the one `previous`
 * already holds when the decoder has not moved on.
 *
 * One decoded sample covers every rendered frame it is current for, which is
 * more than one whenever the source runs slower than the timeline — a 24fps clip
 * on a 30fps project, a freeze, a clip retimed below 1x, or a playhead held
 * still while an animation moves the layer. Cloning it again for each of those
 * hands the texture caches a `VideoFrame` they have never seen, because both of
 * them compare by identity, and the unchanged picture is read back out of a
 * canvas and uploaded to the GPU all over again.
 *
 * `previous` must be the state from the pass before, which is still what
 * `node.resolved` holds while a resolve runs — `resolveNodeSelf` assigns the new
 * one only once it settles. That state's frame is released against whatever is
 * returned here, so handing the same object back is what keeps it open rather
 * than leaking it; {@link releaseVideoFrame} is the other half of that pairing,
 * which is why the two live together.
 */
function frameForSample({
	previous,
	sample,
}: {
	previous:
		| { sample?: VideoSample; source: CanvasImageSource }
		| null
		| undefined;
	sample: VideoSample;
}): CanvasImageSource {
	return previous?.sample === sample ? previous.source : sample.toVideoFrame();
}

/**
 * Closes every decoded frame a tree is holding and clears its resolved state.
 *
 * A render tree is rebuilt from scratch on any timeline change — which during a
 * drag is every mousemove — and the outgoing tree's nodes still hold the
 * `VideoFrame`s their last resolve produced. Nothing used to release them: the
 * replacement tree's nodes are new objects, so `resolveNode` sees no `previous`
 * to swap out, and the frames were left for the garbage collector.
 *
 * A `VideoFrame` holds a decoder buffer, and the decoder's pool is small and
 * fixed, so handing those to the GC is what starves it — the same failure the
 * per-node swap in `resolveNode` exists to prevent, arriving by a different
 * route. On HD media each orphan is megabytes and the pool empties quickly.
 */
export function releaseNodeFrames({ node }: { node: AnyBaseNode }): void {
	// `resolved` is per-node-type, so this walks it structurally rather than
	// naming a shape. `releaseVideoFrame` ignores anything that is not a
	// `VideoFrame`, which is what makes reading the two known keys enough.
	const resolved: unknown = node.resolved;
	if (typeof resolved === "object" && resolved !== null) {
		if ("source" in resolved) {
			releaseVideoFrame({ frame: resolved.source, keep: undefined });
		}
		if ("backdropSource" in resolved) {
			const backdrop: unknown = resolved.backdropSource;
			if (
				typeof backdrop === "object" &&
				backdrop !== null &&
				"source" in backdrop
			) {
				releaseVideoFrame({ frame: backdrop.source, keep: undefined });
			}
		}
	}
	node.resolved = null;

	for (const child of node.children) {
		releaseNodeFrames({ node: child });
	}
}

/**
 * Resolves one node, without its children.
 *
 * The visibility gate runs here rather than inside each node's resolver, so a
 * clip the playhead is not inside is answered with nothing at all — no decode
 * asked for, and no promise to wait on either.
 */
function resolveNodeSelf({
	node,
	context,
}: {
	node: AnyBaseNode;
	context: ResolveContext;
}): Promise<void> | void {
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
		const gate = resolveVisualGate({ params: node.params, context });
		if (!gate) {
			node.resolved = null;
			releaseVideoFrame({ frame: previous, keep: undefined });
			prewarmUpcomingVideoNode({ node, context });
			return;
		}
		return resolveVideoNode({ node, context, gate }).then((resolved) => {
			node.resolved = resolved;
			releaseVideoFrame({ frame: previous, keep: resolved?.source });
		});
	}

	if (node instanceof ImageNode) {
		const gate = resolveVisualGate({ params: node.params, context });
		if (!gate) {
			node.resolved = null;
			return;
		}
		return resolveImageNode({ node, context, gate }).then((resolved) => {
			node.resolved = resolved;
		});
	}

	if (node instanceof StickerNode) {
		const gate = resolveVisualGate({ params: node.params, context });
		if (!gate) {
			node.resolved = null;
			return;
		}
		return resolveStickerNode({ node, context, gate }).then((resolved) => {
			node.resolved = resolved;
		});
	}

	if (node instanceof GraphicNode) {
		node.resolved = resolveGraphicNode({ node, context });
		return;
	}

	if (node instanceof TextNode) {
		node.resolved = resolveTextNode({ node, context });
		return;
	}

	if (node instanceof BlurBackgroundNode) {
		const clipTime = context.time - node.params.timeOffset;
		if (clipTime < 0 || clipTime >= node.params.duration) {
			node.resolved = null;
			return;
		}
		return resolveBlurBackgroundNode({ node, context, clipTime }).then(
			(resolved) => {
				node.resolved = resolved;
			},
		);
	}

	if (node instanceof EffectLayerNode) {
		node.resolved = resolveEffectLayerNode({ node, context });
	}
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
 * Split out from `resolveVisualState` so `resolveNodeSelf` can decide whether a
 * clip contributes anything before paying to decode a frame or load a still it
 * would throw away. The resolver walks every node in the tree on every frame, so
 * on a long timeline nearly every gate answers "no" — and the ones that do are
 * also the common transition case, a side pushed outside its own clip
 * head/tail. The result is passed on to `resolveVisualState` rather than
 * recomputed, so `resolveTransitionFrame` runs once per clip per frame.
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
	return videoCache.getSampleAt({
		mediaId: node.params.mediaId,
		sinkKey: node.params.sinkKey,
		source: node.params.source,
		time: sourceSecondsAtClipTime({ node, clipTime }),
	});
}

/** Where in the file `clipTime` reads from, in seconds, clamped to the material. */
function sourceSecondsAtClipTime({
	node,
	clipTime,
}: {
	node: VideoNode;
	clipTime: number;
}): number {
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
	return mediaTimeToSeconds({ time: clampedSourceTime });
}

/**
 * How far ahead of the playhead a clip is opened for.
 *
 * Long enough to cover the whole cold start of a decoder — probing the
 * container, demuxing the first GOP, one shell decode and the iterator opened
 * behind it, which on a source re-encoded with almost no keyframes is most of a
 * second on its own. Short enough that a timeline of short clips is not opening
 * decoders for material the playhead may never reach, and that a run of them
 * cannot crowd out the decoders drawing the current frame — `VideoCache.prewarm`
 * holds that second line.
 */
const PREWARM_LOOKAHEAD_TICKS = 2 * TICKS_PER_SECOND;

/**
 * Opens the decoder for a clip that is about to start, while the frames still
 * being drawn come from somewhere else.
 *
 * Called from the same visibility gate that skips the clip: a node the playhead
 * is not inside costs nothing to resolve, and this is the one thing worth doing
 * for it. Everything expensive about a cut belongs to the incoming clip's first
 * frame, so it is worth paying for while there is still a frame's worth of
 * slack — see `VideoCache.prewarm`, which decides whether the moment is right.
 */
const clipStartSecondsCache = new WeakMap<VideoNode["params"], number>();

/**
 * Where the clip's own first frame reads from, in seconds — the position a
 * prewarm opens its decoder at.
 *
 * Cached on the params, which cannot change while the node lives. Without it
 * `resolveSampledSourceTime`'s wasm crossing — which deserialises the freeze and
 * retime options on every call — is paid for every clip inside the lookahead on
 * every pass, and thrown away entirely during a scrub, where {@link
 * VideoCache.prewarm} declines to do anything with the answer.
 */
function clipStartSourceSeconds({ node }: { node: VideoNode }): number {
	const cached = clipStartSecondsCache.get(node.params);
	if (cached !== undefined) return cached;

	const seconds = sourceSecondsAtClipTime({ node, clipTime: 0 });
	clipStartSecondsCache.set(node.params, seconds);
	return seconds;
}

function prewarmUpcomingVideoNode({
	node,
	context,
}: {
	node: VideoNode;
	context: ResolveContext;
}): void {
	const untilStart = node.params.timeOffset - context.time;
	if (untilStart <= 0 || untilStart > PREWARM_LOOKAHEAD_TICKS) {
		return;
	}

	videoCache.prewarm({
		mediaId: node.params.mediaId,
		sinkKey: node.params.sinkKey,
		source: node.params.source,
		// The clip's own first frame, which is where playback will enter it.
		time: clipStartSourceSeconds({ node }),
	});
}

async function resolveVideoNode({
	node,
	context,
	gate,
}: {
	node: VideoNode;
	context: ResolveContext;
	gate: VisualGate;
}): Promise<ResolvedVideoNodeState | null> {
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
		source: frameForSample({ previous: node.resolved, sample: frame }),
		sample: frame,
		sourceWidth,
		sourceHeight,
	};
}

async function resolveImageNode({
	node,
	context,
	gate,
}: {
	node: ImageNode;
	context: ResolveContext;
	gate: VisualGate;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadImageSource({
		url: node.params.url,
		maxSourceSize: node.params.maxSourceSize,
	});

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
	gate,
}: {
	node: StickerNode;
	context: ResolveContext;
	gate: VisualGate;
}): Promise<ResolvedVisualSourceNodeState | null> {
	const source = await loadStickerSource({ stickerId: node.params.stickerId });
	const sourceWidth = node.params.intrinsicWidth ?? source.width;
	const sourceHeight = node.params.intrinsicHeight ?? source.height;

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
	clipTime,
}: {
	node: BlurBackgroundNode;
	context: ResolveContext;
	clipTime: number;
}): Promise<ResolvedBlurBackgroundNodeState | null> {
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
	// finalizer logs a stall warning each time.
	//
	// Resolve the replacement *before* releasing what it replaces. Closing
	// first and then awaiting the decode leaves `node.resolved` pointing at a
	// freed frame for the whole await, and on WebKitGTK drawing one of those is
	// a use-after-free that takes the web process down rather than throwing —
	// which reads as the window freezing with nothing in the page left to
	// report it. Same resolve-then-release order as `resolveNode`.
	const previous = node.resolved?.backdropSource?.source;
	const next = await decodeBackdropSource({ node, clipTime });
	releaseVideoFrame({ frame: previous, keep: next?.source });
	return next;
}

async function decodeBackdropSource({
	node,
	clipTime,
}: {
	node: BlurBackgroundNode;
	clipTime: number;
}): Promise<BackdropSource | null> {
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
			sinkKey: node.params.sinkKey,
			source: node.params.source,
			time: mediaTimeToSeconds({ time: sourceTime }),
		});
		if (!frame) {
			return null;
		}

		return {
			source: frameForSample({
				previous: node.resolved?.backdropSource,
				sample: frame,
			}),
			sample: frame,
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
