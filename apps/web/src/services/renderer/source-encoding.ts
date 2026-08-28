/**
 * Picks the bitrate and codec the exporter should use.
 *
 * The bitrate and the fallback codec both come from the first video asset in
 * the project, so an export lands at the size and quality of what went in.
 * Opening a file just to read two header fields is cheap (mediabunny stops at
 * the moov), but we still cache by file identity so repeated exports in one
 * session don't reopen.
 *
 * Which codec is finally used is settled by `resolveExportVideoCodec`: the
 * source's codec is a preference, not an instruction, and it only survives if
 * the chosen container takes it and this engine can encode it.
 */

import { tauriProbeMedia } from "@/lib/tauri-runtime";
import type { MediaAsset } from "@/media/types";
import { createMediaSource, nativeSourcePath } from "@/media/source";
import {
	asVideoCodecName,
	isAudioOnlyExportFormat,
	resolveExportVideoCodec,
} from "@/export";
import type {
	ExportFormat,
	ExportVideoCodec,
	VideoCodecName,
} from "@/export";

/**
 * Fallback bitrate when the source doesn't report one. Tuned for 1080p at
 * ~5 Mbps, which is in the same ballpark as a typical phone or screen
 * recording. The export canvas may be a different size, but this is just
 * a target the encoder treats as a soft ceiling.
 */
const FALLBACK_BITRATE = 5_000_000;

export type SourceEncoding = {
	bitrate: number;
	/** Null when the container holds video this engine has no encoder for. */
	codec: VideoCodecName | null;
};

type SourceHeader = {
	bitrate: number;
	codec: VideoCodecName | null;
};

const cache = new Map<string, Promise<SourceHeader>>();

export async function resolveSourceEncoding({
	mediaAssets,
	format,
	requestedCodec,
}: {
	mediaAssets: MediaAsset[];
	format: ExportFormat;
	/** The user's pick. `auto` (or absent) follows the source. */
	requestedCodec?: ExportVideoCodec;
}): Promise<SourceEncoding> {
	// An audio container has no video to match, and opening a clip to read a
	// bitrate nothing will use is a file read for nothing.
	if (isAudioOnlyExportFormat({ format })) {
		return { bitrate: FALLBACK_BITRATE, codec: null };
	}

	const header = await readFirstVideoHeader({ mediaAssets });

	const preferred =
		requestedCodec && requestedCodec !== "auto" ? requestedCodec : header.codec;

	const codec = await resolveExportVideoCodec({ format, preferred });

	return { bitrate: header.bitrate, codec };
}

async function readFirstVideoHeader({
	mediaAssets,
}: {
	mediaAssets: MediaAsset[];
}): Promise<SourceHeader> {
	const fallback: SourceHeader = { bitrate: FALLBACK_BITRATE, codec: null };

	const firstVideo = mediaAssets.find((asset) => asset.type === "video");
	if (!firstVideo) return fallback;

	const source = createMediaSource({ asset: firstVideo });
	if (!source) return fallback;
	const path = nativeSourcePath({ ref: source });
	// An asset the user has only just dropped in has no file on disk yet. Its
	// bitrate is a nicety — the export still runs on the fallback — so this
	// waits for the asset to be stored rather than reading the blob a second
	// way to find out.
	if (!path) return fallback;

	const cacheKey = firstVideo.id;
	let promise = cache.get(cacheKey);
	if (!promise) {
		promise = readSourceHeader({ path }).finally(() => {
			cache.delete(cacheKey);
		});
		cache.set(cacheKey, promise);
	}

	return promise;
}

async function readSourceHeader({
	path,
}: {
	path: string;
}): Promise<SourceHeader> {
	const fallback: SourceHeader = { bitrate: FALLBACK_BITRATE, codec: null };

	try {
		const probe = await tauriProbeMedia({ path });
		return {
			bitrate:
				probe.bitrate !== null && probe.bitrate > 0
					? probe.bitrate
					: FALLBACK_BITRATE,
			// The probe already speaks the export panel's vocabulary, but it
			// answers null for a codec outside it — a source this build can
			// decode but not re-encode. That is a reason to fall back to the
			// container's preference, not to refuse the export.
			codec: asVideoCodecName({ name: probe.videoCodec }),
		};
	} catch {
		// A source the exporter can't read is not a reason to refuse the
		// export; the timeline may not even use its video.
		return fallback;
	}
}
