import type { CropInsets } from "@/crop";
import type { EffectPass } from "@/effects/types";
import type { MediaSourceRef } from "@/media/source";
import type { FreezeConfig, RetimeConfig } from "@/timeline";
import { BaseNode } from "./base-node";

export type BlurBackgroundNodeParams = {
	mediaId: string;
	url: string;
	/** Where the clip's bytes are read from; see {@link MediaSourceRef}. */
	source: MediaSourceRef;
	mediaType: "video" | "image";
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
};

export interface ResolvedBlurBackgroundNodeState {
	backdropSource: BackdropSource;
	passes: EffectPass[];
}

export class BlurBackgroundNode extends BaseNode<
	BlurBackgroundNodeParams,
	ResolvedBlurBackgroundNodeState
> {}
