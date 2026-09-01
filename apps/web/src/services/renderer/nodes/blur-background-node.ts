import type { CropInsets } from "@/crop";
import type { EffectPass } from "@/effects/types";
import type { MediaSourceRef } from "@/media/source";
import type { VideoSample } from "@/media/video-sample";
import type { FreezeConfig, RetimeConfig } from "@/timeline";
import { BaseNode } from "./base-node";

export type BlurBackgroundNodeParams = {
	mediaId: string;
	url: string;
	/** Where the clip's bytes are read from; see {@link MediaSourceRef}. */
	source: MediaSourceRef;
	mediaType: "video" | "image";
	/**
	 * Which decoder the backdrop samples from — the same one as the clip it sits
	 * behind, because it is the same frame of the same file at the same moment.
	 * See `getSinkKeysByElementId`.
	 */
	sinkKey?: string;
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	/** Mirrors the foreground clip's freeze so the backdrop holds the same frame. */
	freeze?: FreezeConfig;
	/**
	 * Mirrors the foreground clip's crop, so the wash behind a cropped shot is
	 * made of the part of the frame that is still on screen rather than of the
	 * part it was trimmed to remove.
	 */
	crop?: CropInsets;
	blurIntensity: number;
};

export type BackdropSource = {
	source: CanvasImageSource;
	width: number;
	height: number;
	/**
	 * The decoded sample `source` was cloned from, for a video backdrop.
	 *
	 * The backdrop is uploaded through the compositor's "rendered" branch, whose
	 * cache key is the source's identity, so a fresh clone of an unchanged sample
	 * re-blits the whole backdrop onto a canvas and re-uploads it. Comparing the
	 * sample is what lets a held picture keep the texture it already has. Absent
	 * for an image backdrop, which is a stable object already.
	 */
	sample?: VideoSample;
};

export interface ResolvedBlurBackgroundNodeState {
	backdropSource: BackdropSource;
	passes: EffectPass[];
}

export class BlurBackgroundNode extends BaseNode<
	BlurBackgroundNodeParams,
	ResolvedBlurBackgroundNodeState
> {}
