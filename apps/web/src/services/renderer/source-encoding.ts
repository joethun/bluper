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

import { ALL_FORMATS, Input } from "mediabunny";
import type { VideoCodec } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import {
	createMediaSource,
	toInputSource,
	type MediaSourceRef,
} from "@/media/source";
import { isAudioOnlyExportFormat, resolveExportVideoCodec } from "@/export";
import type { ExportFormat, ExportVideoCodec } from "@/export";

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
	codec: VideoCodec | null;
};

type SourceHeader = {
	bitrate: number;
	codec: VideoCodec | null;
};

const cache = new Map<string, Promise<SourceHeader>>();

export async function resolveSourceEncoding({
	mediaAssets,
	format,
	requestedCodec,
	width,
	height,
}: {
	mediaAssets: MediaAsset[];
	format: ExportFormat;
	/** The user's pick. `auto` (or absent) follows the source. */
	requestedCodec?: ExportVideoCodec;
	width: number;
	height: number;
}): Promise<SourceEncoding> {
	// An audio container has no video to match, and opening a clip to read a
	// bitrate nothing will use is a file read for nothing.
	if (isAudioOnlyExportFormat({ format })) {
		return { bitrate: FALLBACK_BITRATE, codec: null };
	}

	const header = await readFirstVideoHeader({ mediaAssets });

	const preferred =
		requestedCodec && requestedCodec !== "auto" ? requestedCodec : header.codec;

	const codec = await resolveExportVideoCodec({
		format,
		preferred,
		width,
		height,
	});

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

	const cacheKey = firstVideo.id;
	let promise = cache.get(cacheKey);
	if (!promise) {
		promise = readSourceHeader({ source }).finally(() => {
			// Drop the cache entry once the input has been read so we don't
			// hold a closed `Input` reference forever.
			cache.delete(cacheKey);
		});
		cache.set(cacheKey, promise);
	}

	return promise;
}

async function readSourceHeader({
	source,
}: {
	source: MediaSourceRef;
}): Promise<SourceHeader> {
	const fallback: SourceHeader = { bitrate: FALLBACK_BITRATE, codec: null };
	const input = new Input({
		source: toInputSource({ ref: source }),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) return fallback;

		const [sourceBitrate, sourceCodec] = await Promise.all([
			videoTrack.getBitrate(),
			videoTrack.getCodec(),
		]);

		return {
			bitrate:
				typeof sourceBitrate === "number" && sourceBitrate > 0
					? sourceBitrate
					: FALLBACK_BITRATE,
			codec: sourceCodec,
		};
	} catch {
		// A source the exporter can't read is not a reason to refuse the export;
		// the timeline may not even use its video. Fall back to the defaults.
		return fallback;
	} finally {
		input.dispose();
	}
}
