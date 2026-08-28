import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface ImageNodeParams extends VisualNodeParams {
	url: string;
	maxSourceSize?: number;
}

export interface CachedImageSource {
	source: HTMLImageElement | OffscreenCanvas;
	width: number;
	height: number;
}

const imageSourceCache = new Map<string, Promise<CachedImageSource>>();

/**
 * How many decoded stills stay resident.
 *
 * A preview entry is a canvas of up to `PREVIEW_MAX_IMAGE_SIZE` on its longest
 * side, so ~16MB of RGBA each at the cap; an export entry is the full-size
 * image. Unbounded, a project with a few dozen stills held every one of them
 * for the rest of the session — nothing evicted, and the project-close path
 * cleared the video and waveform caches but not this one. `Map` iterates in
 * insertion order and a hit re-inserts, so the first key is the least recently
 * used.
 */
const MAX_CACHED_IMAGE_SOURCES = 24;

/**
 * Drops every decoded still. Called when the media set is torn down, so
 * switching projects does not carry the previous one's images.
 */
export function clearImageSourceCache(): void {
	imageSourceCache.clear();
}

/**
 * Drops the decoded stills for one asset, at whatever source sizes were
 * cached for it.
 */
export function clearImageSource({ url }: { url: string }): void {
	for (const cacheKey of [...imageSourceCache.keys()]) {
		if (cacheKey.startsWith(`${url}::`)) {
			imageSourceCache.delete(cacheKey);
		}
	}
}

export function loadImageSource({
	url,
	maxSourceSize,
}: {
	url: string;
	maxSourceSize?: number;
}): Promise<CachedImageSource> {
	const cacheKey = `${url}::${maxSourceSize ?? "full"}`;

	const cached = imageSourceCache.get(cacheKey);
	if (cached) {
		// Re-insert so this key counts as the most recently used.
		imageSourceCache.delete(cacheKey);
		imageSourceCache.set(cacheKey, cached);
		return cached;
	}

	const promise = (async (): Promise<CachedImageSource> => {
		const image = new Image();

		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error("Image load failed"));
			image.src = url;
		});

		const naturalWidth = image.naturalWidth;
		const naturalHeight = image.naturalHeight;
		const exceedsLimit =
			maxSourceSize &&
			(naturalWidth > maxSourceSize || naturalHeight > maxSourceSize);

		if (exceedsLimit) {
			const scale = Math.min(
				maxSourceSize / naturalWidth,
				maxSourceSize / naturalHeight,
			);
			const scaledWidth = Math.round(naturalWidth * scale);
			const scaledHeight = Math.round(naturalHeight * scale);

			const offscreen = new OffscreenCanvas(scaledWidth, scaledHeight);
			const ctx = offscreen.getContext("2d");

			if (ctx) {
				ctx.drawImage(image, 0, 0, scaledWidth, scaledHeight);
				return { source: offscreen, width: scaledWidth, height: scaledHeight };
			}
		}

		return { source: image, width: naturalWidth, height: naturalHeight };
	})();

	imageSourceCache.set(cacheKey, promise);

	// A failed decode must not be remembered as a permanent failure: the URL
	// can become readable again (a blob URL re-minted, an asset re-imported).
	void promise.catch(() => {
		if (imageSourceCache.get(cacheKey) === promise) {
			imageSourceCache.delete(cacheKey);
		}
	});

	while (imageSourceCache.size > MAX_CACHED_IMAGE_SOURCES) {
		const oldest = imageSourceCache.keys().next();
		if (oldest.done || oldest.value === cacheKey) break;
		imageSourceCache.delete(oldest.value);
	}

	return promise;
}

export class ImageNode extends VisualNode<
	ImageNodeParams,
	ResolvedVisualSourceNodeState
> {}
