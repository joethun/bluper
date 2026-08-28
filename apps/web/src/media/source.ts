/**
 * How the editor reads bytes out of a media asset.
 *
 * There are two shapes, and neither loads the media into memory:
 *
 * - `blob` — a `File` the user just handed over, from a picker, a drop, or the
 *   clipboard. The engine keeps its bytes on disk and reads slices on demand.
 * - `url` — an `asset:` URL served by the shell straight off the filesystem,
 *   with range requests. This is what every stored asset uses. Nothing about
 *   the file is copied into the page, which is what lets a project hold more
 *   media than the process could ever address.
 *
 * Everything that decodes media takes a {@link MediaSourceRef} rather than a
 * `File`, so a freshly imported clip and a reloaded one go down one path.
 */

import type { MediaAsset } from "./types";

export type MediaSourceRef =
	| { kind: "blob"; blob: Blob }
	| {
			kind: "url";
			url: string;
			/**
			 * The real filesystem path behind `url`. Every decoder reads a
			 * path — the shell demuxes, decodes and probes — so an asset
			 * without one cannot be read at all until the store has written
			 * it.
			 */
			path?: string;
	  };

/**
 * Describes where an asset's bytes are. Returns null for an asset that has
 * neither — a media item whose file failed to load.
 */
export function createMediaSource({
	asset,
}: {
	asset: Pick<MediaAsset, "file" | "path" | "url">;
}): MediaSourceRef | null {
	if (asset.path && asset.url) {
		return { kind: "url", url: asset.url, path: asset.path };
	}
	if (asset.file) {
		return { kind: "blob", blob: asset.file };
	}
	return null;
}

/**
 * The real filesystem path behind a reference, for the decoders in the desktop
 * shell — which open a file rather than fetch a URL. Null for an asset the
 * user has only just dropped in, whose bytes are still a `Blob` in the page
 * and which therefore cannot be decoded yet.
 */
export function nativeSourcePath({ ref }: { ref: MediaSourceRef }): string | null {
	return ref.kind === "url" ? (ref.path ?? null) : null;
}

/**
 * Reads a whole source into memory. Only for things that genuinely need every
 * byte at once — decoding an audio track, sniffing SVG markup — never for
 * video, which is sampled frame by frame instead.
 */
export async function readMediaSourceBytes({
	ref,
}: {
	ref: MediaSourceRef;
}): Promise<ArrayBuffer> {
	if (ref.kind === "url") {
		const response = await fetch(ref.url);
		if (!response.ok) {
			throw new Error(`Failed to read media source: ${response.status}`);
		}
		return await response.arrayBuffer();
	}
	return await ref.blob.arrayBuffer();
}
