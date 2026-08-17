/**
 * How the editor reads bytes out of a media asset.
 *
 * There are two shapes, and neither loads the media into memory:
 *
 * - `blob` — a `File` from an upload or from OPFS. The browser keeps its bytes
 *   on disk and reads slices on demand.
 * - `url` — an `asset:` URL served by the desktop shell straight off the
 *   filesystem, with range requests. Nothing about the file is copied into the
 *   page, which is what lets a project hold more media than the process could
 *   ever address.
 *
 * Everything that decodes media takes a {@link MediaSourceRef} rather than a
 * `File`, so both builds go down the same path.
 */

import { BlobSource, UrlSource, type Source } from "mediabunny";
import type { MediaAsset } from "./types";

export type MediaSourceRef =
	| { kind: "blob"; blob: Blob }
	| { kind: "url"; url: string };

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
		return { kind: "url", url: asset.url };
	}
	if (asset.file) {
		return { kind: "blob", blob: asset.file };
	}
	return null;
}

/** Builds the Mediabunny input source for a reference. */
export function toInputSource({ ref }: { ref: MediaSourceRef }): Source {
	return ref.kind === "url"
		? new UrlSource(ref.url)
		: new BlobSource(ref.blob);
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
