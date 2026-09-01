import type { FrameRate } from "bluper-wasm";
import type { SceneTracks, TimelineTrack, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import type { MediaAsset } from "@/media/types";
import { createMediaSource } from "@/media/source";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";
import { pickClipAdjustmentParams } from "@/adjustments/clip";
import { readCropFromParams } from "@/crop";
import { resolveSampledSourceTime } from "@/freeze";
import {
	findTransitions,
	getTransitionBindingsForElement,
} from "@/transitions";
import type { TransitionPlacement } from "@/transitions";
const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

/**
 * One track's elements and cuts, read once per scene build.
 *
 * Both halves are more expensive than they look. `findTransitions` crosses into
 * wasm, which deserialises the whole track — every element with its params,
 * animations, keyframes and masks — and the sort's tiebreak is an Intl
 * collation. `buildScene` needs them from three places (the decoder keys, the
 * clip nodes, the blur backdrop), so they are read here and handed round rather
 * than recomputed per consumer.
 */
interface TrackView {
	track: TimelineTrack;
	elements: ReturnType<typeof getVisibleSortedElements>;
	/**
	 * Transitions come from the track as stored, not from `elements`: the
	 * transition commands resolve neighbours the same way, so a hidden clip keeps
	 * owning its cut and unhiding it does not silently move the transition.
	 */
	transitions: TransitionPlacement[];
}

function readTrackView({ track }: { track: TimelineTrack }): TrackView {
	return {
		track,
		elements: getVisibleSortedElements({ track }),
		transitions: findTransitions({ track }),
	};
}

/**
 * Where in its file a clip reads at `clipTime`. At zero that is the clip's
 * in-point; at its whole duration, the source time just past its last frame —
 * which is where a clip carrying straight on from it would begin.
 */
function sourceTimeAt({
	element,
	clipTime,
}: {
	element: VideoElement;
	clipTime: number;
}): number {
	return resolveSampledSourceTime({
		freeze: element.freeze,
		trimStart: element.trimStart,
		clipTime,
		clipDuration: element.duration,
		retime: element.retime,
	});
}

/**
 * Whether `element` carries straight on from `previous`: the same file, joined
 * on the timeline, and entered on the very source frame `previous` stopped
 * before. One decoder running forwards serves both, so the cut between them
 * costs nothing at all.
 *
 * A clip on either side of a transition is excluded however continuous it looks.
 * A transition draws both clips at once and each wants a different frame of the
 * source at the same moment, which one decoder cannot be in two places to give.
 */
function continuesDecoding({
	previous,
	element,
	transitioning,
	ticksPerFrame,
}: {
	previous: VideoElement;
	element: VideoElement;
	transitioning: ReadonlySet<string>;
	ticksPerFrame: number | null;
}): boolean {
	// Without a frame rate there is no scale to judge "joined" or "the next
	// frame" against, so nothing is treated as continuous and every clip decodes
	// from a position of its own.
	if (!ticksPerFrame || ticksPerFrame <= 0) return false;
	if (previous.mediaId !== element.mediaId) return false;
	if (transitioning.has(previous.id) || transitioning.has(element.id)) {
		return false;
	}
	// A freeze pins its clip's decoder to one source time, so neither the clip
	// before it nor the one after runs through it.
	if (previous.freeze || element.freeze) return false;

	const gap = element.startTime - (previous.startTime + previous.duration);
	if (gap < 0 || gap >= ticksPerFrame) return false;

	const previousOut = sourceTimeAt({
		element: previous,
		clipTime: previous.duration,
	});
	const inPoint = sourceTimeAt({ element, clipTime: 0 });
	return Math.abs(inPoint - previousOut) < ticksPerFrame;
}

/**
 * Which decoder each video clip on a track samples from, keyed by element id.
 *
 * Two clips share one only when the second continues the first — a split clip,
 * where the decoder's iterator simply keeps running across the cut. That case is
 * free, and it is the only one that is: a decoder holds a single position, so any
 * other pair of clips reading one file makes the later request supersede the
 * earlier one, which then silently receives whatever frame happens to be current.
 *
 * Everything else gets a decoder of its own, and the reason is prewarming. A clip
 * the playhead is about to reach has its decoder opened and positioned a couple
 * of seconds early — see `prewarmUpcomingVideoNode` — and that can only happen
 * under a key nothing is using, because a decoder that already exists is serving
 * the picture on screen and cannot be moved off it. One key per asset quietly
 * excluded every clip whose file was already open somewhere on the timeline: the
 * later halves of an A/B/A/B cut, a shot used twice, two trims of one recording
 * butted together. Those joins got no prewarm at all and paid the whole cold
 * start — a container probe, a GOP demux and a shell decode — inside the render
 * pass the preview was waiting on, which is why some cuts on a timeline stuttered
 * and the ones beside them did not.
 */
function getSinkKeysByElementId({
	view,
	ticksPerFrame,
}: {
	view: TrackView;
	ticksPerFrame: number | null;
}): Map<string, string> {
	const keys = new Map<string, string>();
	const transitioning = new Set(
		view.transitions.flatMap((placement) =>
			placement.sides.map((side) => side.elementId),
		),
	);

	let previous: { element: VideoElement; key: string } | null = null;

	for (const element of view.elements) {
		if (element.type !== "video") continue;

		// Annotated because the inference is circular: the key of a continuation
		// is the previous clip's, and the previous clip's is set from this.
		const key: string =
			previous &&
			continuesDecoding({
				previous: previous.element,
				element,
				transitioning,
				ticksPerFrame,
			})
				? previous.key
				: `${element.mediaId}:${element.id}`;

		keys.set(element.id, key);
		previous = { element, key };
	}

	return keys;
}

/**
 * How long each clip must keep drawing past its own end to cover a seam narrower
 * than a frame, keyed by element id.
 *
 * Trimming and dragging leave clips a few ticks apart while looking flush on the
 * timeline. Playback drives its clock from audio and lands on arbitrary ticks, so
 * the playhead can sit inside such a sliver — and with neither clip on, the clear
 * colour shows through as a black flash at the join. A gap that is genuinely a
 * frame or longer is left alone: that one the author meant.
 */
function getSeamHoldsByElementId({
	track,
	elements,
	ticksPerFrame,
}: {
	track: TimelineTrack;
	/** The clips actually being drawn; only their ids are needed. */
	elements: ReadonlyArray<{ id: string }>;
	ticksPerFrame: number | null;
}): Map<string, number> {
	const holds = new Map<string, number>();
	if (!ticksPerFrame || ticksPerFrame <= 0) {
		return holds;
	}

	// Every clip on the track, not just the visible ones: a hidden neighbour
	// still says where the next material begins.
	const spans = [...track.elements]
		.map((element) => ({
			id: element.id,
			startTime: element.startTime,
			endTime: element.startTime + element.duration,
		}))
		.sort((first, second) => first.startTime - second.startTime);

	const visibleIds = new Set(elements.map((element) => element.id));
	for (let index = 0; index < spans.length; index++) {
		const span = spans[index];
		if (!visibleIds.has(span.id)) continue;

		const next = spans[index + 1];
		if (!next) continue;

		const gap = next.startTime - span.endTime;
		// A butt-joined cut extends by zero: clip B is the same source frame as
		// clip A's end, so the GPU work would double for no visible gain. A
		// decoder warm run (added in `buildScene` below) makes this safe — the
		// incoming clip is ready before the playhead lands here. A sub-frame gap
		// still extends by exactly the gap so the seam is closed without
		// overlapping the incoming clip.
		if (gap === 0) {
			holds.set(span.id, 0);
		} else if (gap > 0 && gap < ticksPerFrame) {
			holds.set(span.id, gap);
		}
	}

	return holds;
}

function buildTrackNodes({
	trackViews,
	mediaMap,
	canvasSize,
	isPreview,
	uncroppedElementId,
	ticksPerFrame,
	sinkKeys,
}: {
	trackViews: TrackView[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	uncroppedElementId?: string | null;
	ticksPerFrame: number | null;
	/** Which decoder each clip samples from; see {@link getSinkKeysByElementId}. */
	sinkKeys: Map<string, string>;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const {
		track,
		elements,
		transitions: transitionPlacements,
	} of trackViews) {
		const seamHolds = getSeamHoldsByElementId({
			track,
			elements,
			ticksPerFrame,
		});

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				const mediaSource = mediaAsset
					? createMediaSource({ asset: mediaAsset })
					: null;
				if (!mediaAsset?.url || !mediaSource) {
					continue;
				}

				const transitions = getTransitionBindingsForElement({
					placements: transitionPlacements,
					elementId: element.id,
				});
				// The clip being cropped draws whole, so the edges the user is about
				// to trim — or to give back — are still on screen for the overlay to
				// dim and for the handles to reach.
				const crop =
					element.id === uncroppedElementId
						? undefined
						: readCropFromParams({ params: element.params });

				if (element.type === "video" && mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							source: mediaSource,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							freeze: element.freeze,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							adjustParams: pickClipAdjustmentParams({ params: element.params }),
							crop,
							tailHold: seamHolds.get(element.id),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							transitions,
							fade: element.fade,
							sinkKey: sinkKeys.get(element.id),
						}),
					);
				}
				if (element.type === "image" && mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							adjustParams: pickClipAdjustmentParams({ params: element.params }),
							crop,
							tailHold: seamHolds.get(element.id),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							transitions,
							fade: element.fade,
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						adjustParams: pickClipAdjustmentParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						adjustParams: pickClipAdjustmentParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						adjustParams: pickClipAdjustmentParams({ params: element.params }),
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	view,
	mediaMap,
	blurIntensity,
	uncroppedElementId,
	sinkKeys,
}: {
	view: TrackView | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
	uncroppedElementId?: string | null;
	/**
	 * The foreground clips' decoder keys. The backdrop is the same frame of the
	 * same file at the same moment, so it must ask the same decoder — given a key
	 * of its own it would open a second one per clip, and the prewarm that the
	 * foreground clip gets would not cover it.
	 */
	sinkKeys: Map<string, string>;
}): AnyBaseNode[] {
	if (!view) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = view.elements;

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		const mediaSource = mediaAsset
			? createMediaSource({ asset: mediaAsset })
			: null;
		if (
			!mediaSource ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				source: mediaSource,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				freeze: element.type === "video" ? element.freeze : undefined,
				crop:
					element.id === uncroppedElementId
						? undefined
						: readCropFromParams({ params: element.params }),
				sinkKey: sinkKeys.get(element.id),
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
	/**
	 * The clip the preview is cropping, drawn whole so the overlay can dim the
	 * trimmed edges rather than the renderer removing them. Never set for an
	 * export — a crop in progress is still a crop.
	 */
	uncroppedElementId?: string | null;
	/**
	 * The project's frame rate, which is what says whether a gap between two
	 * clips is a real one or rounding noise too narrow to be a frame. Without it
	 * no seam is closed.
	 */
	fps?: FrameRate;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	uncroppedElementId,
	fps,
}: BuildSceneParams) {
	const ticksPerFrame = fps
		? Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator)
		: null;
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const trackViews = visibleTracks.map((track) => readTrackView({ track }));
	const mainTrackView = tracks.main.hidden
		? undefined
		: trackViews.find((view) => view.track === tracks.main);

	// Element ids are unique across the project, so one flat map covers every
	// track. Built here rather than per builder so the blur backdrop and the clip
	// it sits behind cannot disagree about which decoder they read.
	const sinkKeys = new Map<string, string>();
	for (const view of trackViews) {
		for (const [elementId, sinkKey] of getSinkKeysByElementId({
			view,
			ticksPerFrame,
		})) {
			sinkKeys.set(elementId, sinkKey);
		}
	}

	const allNodes = buildTrackNodes({
		trackViews: trackViews.slice().reverse(),
		mediaMap,
		canvasSize,
		isPreview,
		uncroppedElementId,
		ticksPerFrame,
		sinkKeys,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			view: mainTrackView,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
			uncroppedElementId,
			sinkKeys,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
