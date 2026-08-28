import { createCanvasSurface } from "./canvas-utils";
import {
	effectsRegistry,
	paintEffectedLayer,
	resolveEffectPasses,
} from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";
import { gpuRenderer } from "./gpu-renderer";

const PREVIEW_WIDTH = 180;
const PREVIEW_HEIGHT = 140;
const FALLBACK_IMAGE_PATH = "/effects/preview.jpg";
/**
 * Where in an animated effect's cycle a thumbnail is sampled. Early enough that a
 * beat is still near its peak, and late enough that a push has begun to move.
 */
const PREVIEW_TIME = 0.12;

class EffectPreviewService {
	private images = new Map<string, HTMLImageElement>();
	private sources = new Map<string, OffscreenCanvas>();
	private onReadyCallbacks = new Set<() => void>();

	readonly PREVIEW_WIDTH = PREVIEW_WIDTH;
	readonly PREVIEW_HEIGHT = PREVIEW_HEIGHT;

	/**
	 * Fires when a preview source finishes decoding. The browser draws its tiles on
	 * mount, which is usually before any image is ready, so it needs telling to
	 * draw them again.
	 */
	onPreviewImageReady({ callback }: { callback: () => void }): () => void {
		this.onReadyCallbacks.add(callback);
		return () => this.onReadyCallbacks.delete(callback);
	}

	renderPreview({
		effectType,
		params,
		targetCanvas,
		sourceUrl,
	}: {
		effectType: string;
		params: ParamValues;
		targetCanvas: HTMLCanvasElement;
		/**
		 * The clip the effect would be applied to, so the tiles preview the user's own
		 * footage. Falls back to a bundled still when the layer has no thumbnail.
		 */
		sourceUrl?: string;
	}): void {
		const width = PREVIEW_WIDTH;
		const height = PREVIEW_HEIGHT;
		const targetCtx = targetCanvas.getContext(
			"2d",
		) as CanvasRenderingContext2D | null;
		if (!targetCtx) {
			return;
		}

		targetCanvas.width = width;
		targetCanvas.height = height;

		const source = this.getSource({ url: sourceUrl, width, height });
		if (!source) {
			targetCtx.clearRect(0, 0, width, height);
			return;
		}

		try {
			const definition = effectsRegistry.get(effectType);
			const resolvedParams =
				Object.keys(params).length > 0
					? params
					: buildDefaultParamValues({ params: definition.params });

			if (definition.paint) {
				paintEffectedLayer({
					ctx: targetCtx,
					source,
					width,
					height,
					effects: [
						{
							type: effectType,
							params: resolvedParams,
							time: PREVIEW_TIME,
							// A progress-driven effect previews at the end of its travel, which
							// is the frame that shows what it did.
							progress: 1,
							animated: definition.animated === true,
						},
					],
				});
				return;
			}

			const passes = resolveEffectPasses({
				definition,
				effectParams: resolvedParams,
				width,
				height,
			});
			const result = gpuRenderer.applyEffect({
				source,
				width,
				height,
				passes,
			});
			targetCtx.drawImage(result, 0, 0, width, height);
		} catch (error) {
			console.warn("Failed to render effect preview", { effectType, error });
			targetCtx.clearRect(0, 0, width, height);
			targetCtx.drawImage(source, 0, 0, width, height);
		}
	}

	private loadImage({ url }: { url: string }): HTMLImageElement | null {
		if (typeof window === "undefined") {
			return null;
		}

		const existing = this.images.get(url);
		if (existing) {
			return existing;
		}

		const image = new Image();
		image.onload = () => {
			this.sources.delete(url);
			for (const callback of this.onReadyCallbacks) {
				callback();
			}
		};
		image.src = url;
		this.images.set(url, image);
		return image;
	}

	private getSource({
		url,
		width,
		height,
	}: {
		url: string | undefined;
		width: number;
		height: number;
	}): OffscreenCanvas | null {
		const resolvedUrl = url ?? FALLBACK_IMAGE_PATH;
		const cached = this.sources.get(resolvedUrl);
		if (cached && cached.width === width && cached.height === height) {
			return cached;
		}

		const image = this.loadImage({ url: resolvedUrl });
		const isReady = Boolean(
			image?.complete && (image?.naturalWidth ?? 0) > 0,
		);
		if (!image || !isReady) {
			// A clip thumbnail that has not decoded yet should not leave the tile empty
			// while the bundled still is sitting right there.
			return resolvedUrl === FALLBACK_IMAGE_PATH
				? null
				: this.getSource({ url: FALLBACK_IMAGE_PATH, width, height });
		}

		const { canvas, context } = createCanvasSurface({ width, height });
		// Cover rather than stretch, so a portrait thumbnail is not squashed into the
		// landscape tile.
		const scale = Math.max(
			width / image.naturalWidth,
			height / image.naturalHeight,
		);
		const drawWidth = image.naturalWidth * scale;
		const drawHeight = image.naturalHeight * scale;
		context.drawImage(
			image,
			(width - drawWidth) / 2,
			(height - drawHeight) / 2,
			drawWidth,
			drawHeight,
		);
		this.sources.set(resolvedUrl, canvas);
		return canvas;
	}
}

export const effectPreviewService = new EffectPreviewService();
