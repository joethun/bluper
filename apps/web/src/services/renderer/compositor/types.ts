import type { BlendMode } from "@/rendering";
import type { EffectPass } from "@/effects/types";

export type FrameDescriptor = {
	/**
	 * The canvas space every transform, sigma and feather in the frame is
	 * written in: the project's resolution, whatever the frame is drawn at.
	 */
	width: number;
	height: number;
	/**
	 * What fraction of `width` x `height` the compositor actually renders, in
	 * (0, 1]. The layer pass maps canvas space onto whatever target it is given,
	 * so a lower scale is the same picture sampled to fewer pixels — see
	 * `preview/render-scale.ts`.
	 */
	renderScale: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type FrameItemDescriptor =
	| {
			type: "layer";
			textureId: string;
			transform: QuadTransformDescriptor;
			opacity: number;
			blendMode: BlendMode;
			effectPassGroups: EffectPass[][];
			mask: LayerMaskDescriptor | null;
	  }
	| {
			type: "sceneEffect";
			effectPassGroups: EffectPass[][];
	  };

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};

export type TextureCanvasDrawFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => void;

/**
 * A layer texture whose pixels come from somewhere outside the renderer —
 * typically a decoded image frame or a sticker that the editor drew into an
 * `OffscreenCanvas`. Cached by reference identity of the source object.
 */
export type ExternalTextureDescriptor = {
	kind: "external";
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
};

/**
 * A layer texture backed by a WebCodecs `VideoFrame`. The hot path for
 * decoded video: the frame is consumed directly by the GPU via
 * `copyExternalImageToTexture`, with no canvas intermediate.
 */
export type VideoFrameTextureDescriptor = {
	kind: "video";
	id: string;
	source: VideoFrame;
	width: number;
	height: number;
};

/**
 * A layer texture that the renderer rasterizes from scene state (color fill,
 * text layout, mask shape, blur backdrop). Cached by `contentHash`: when it
 * matches the previous frame's hash for this id, the upload is skipped
 * entirely and the persistent canvas is not even cleared.
 */
export type RenderedTextureDescriptor = {
	kind: "rendered";
	id: string;
	contentHash: string;
	/** Size of the texture that gets uploaded. */
	width: number;
	height: number;
	/**
	 * A transform applied to the context before `draw` runs, for a texture whose
	 * drawing code works in a coordinate space larger than the texture it lands
	 * on. Full-canvas textures below full render scale are the case: the draw
	 * code stays in canvas units and the rasterisation shrinks with the frame.
	 *
	 * `width`/`height` already carry the scale, so `contentHash` — which
	 * includes them — invalidates on a scale change without mentioning it.
	 */
	drawScale?: number;
	draw: TextureCanvasDrawFn;
};

export type TextureUploadDescriptor =
	| ExternalTextureDescriptor
	| VideoFrameTextureDescriptor
	| RenderedTextureDescriptor;
