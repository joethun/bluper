import type { FrameRate } from "opencut-wasm";
import type { SceneTracks, TimelineTrack } from "@/timeline";
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
import {
	findTransitions,
	getTransitionBindingsForElement,
} from "@/transitions";
import type { TransitionPlacement } from "@/transitions/types";

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
 * The clips that must decode from a position of their own rather than the one
 * shared per asset. Both sides of a transition need a different frame of their
 * source at the same moment, and one decoder can only be in one place — the
 * later request supersedes the earlier one, which then receives whatever frame
 * happens to be current. Splitting a clip and putting a transition on the cut is
 * the usual way to end up with two clips reading one file at once.
 *
 * Only the incoming side moves onto its own decoder, so the outgoing clip keeps
 * the shared one and an ordinary timeline never pays for a second.
 */
function getOwnDecoderElementIds({
	placements,
	track,
}: {
	placements: TransitionPlacement[];
	track: TimelineTrack;
}): Set<string> {
	const mediaIdOf = new Map(
		track.elements.map((element) => [
			element.id,
			"mediaId" in element ? element.mediaId : undefined,
		]),
	);
	const ids = new Set<string>();

	for (const placement of placements) {
		if (placement.sides.length < 2) {
			continue;
		}
		const mediaIds = placement.sides.map((side) =>
			mediaIdOf.get(side.elementId),
		);
		if (mediaIds[0] === undefined || mediaIds[0] !== mediaIds[1]) {
			continue;
		}
		const incoming = placement.sides.find((side) => side.role === "incoming");
		if (incoming) {
			ids.add(incoming.elementId);
		}
	}

	return ids;
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
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
	uncroppedElementId,
	ticksPerFrame,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	uncroppedElementId?: string | null;
	ticksPerFrame: number | null;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		// Transitions come from the track as stored, not from `elements`: the
		// transition commands resolve neighbours the same way, so a hidden clip
		// keeps owning its cut and unhiding it does not silently move the
		// transition.
		const transitionPlacements = findTransitions({ track });
		const ownDecoderElementIds = getOwnDecoderElementIds({
			placements: transitionPlacements,
			track,
		});
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
							...(ownDecoderElementIds.has(element.id) && {
								sinkKey: `${mediaAsset.id}:${element.id}`,
							}),
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
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
	uncroppedElementId,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
	uncroppedElementId?: string | null;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

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
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
		uncroppedElementId,
		ticksPerFrame,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
			uncroppedElementId,
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
