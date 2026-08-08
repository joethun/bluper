/**
 * Picks the bitrate and codec the exporter should use, derived from the
 * first video asset in the project. Opening a file just to read two header
 * fields is cheap (mediabunny stops at the moov), but we still cache by
 * file identity so repeated exports in one session don't reopen.
 */

import {
	ALL_FORMATS,
	BlobSource,
	Input,
	canEncodeVideo,
} from "mediabunny";
import type { VideoCodec } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import type { ExportFormat } from "@/export";

const MP4_DEFAULT_CODEC: VideoCodec = "avc";
const WEBM_DEFAULT_CODEC: VideoCodec = "vp9";

/**
 * Fallback bitrate when the source doesn't report one. Tuned for 1080p at
 * ~5 Mbps, which is in the same ballpark as a typical phone or screen
 * recording. The export canvas may be a different size, but this is just
 * a target the encoder treats as a soft ceiling.
 */
const FALLBACK_BITRATE = 5_000_000;

export type SourceEncoding = {
	bitrate: number;
	codec: VideoCodec;
};

const cache = new Map<File, Promise<SourceEncoding>>();

export async function resolveSourceEncoding({
	mediaAssets,
	format,
}: {
	mediaAssets: MediaAsset[];
	format: ExportFormat;
}): Promise<SourceEncoding> {
	const firstVideo = mediaAssets.find((asset) => asset.type === "video");
	if (!firstVideo) {
		return {
			bitrate: FALLBACK_BITRATE,
			codec: format === "webm" ? WEBM_DEFAULT_CODEC : MP4_DEFAULT_CODEC,
		};
	}

	let promise = cache.get(firstVideo.file);
	if (!promise) {
		promise = readSourceEncoding({
			file: firstVideo.file,
			format,
		}).finally(() => {
			// Drop the cache entry once the input has been read so we don't
			// hold a closed `Input` reference forever.
			cache.delete(firstVideo.file);
		});
		cache.set(firstVideo.file, promise);
	}

	return promise;
}

async function readSourceEncoding({
	file,
	format,
}: {
	file: File;
	format: ExportFormat;
}): Promise<SourceEncoding> {
	const fallbackCodec: VideoCodec =
		format === "webm" ? WEBM_DEFAULT_CODEC : MP4_DEFAULT_CODEC;
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			return { bitrate: FALLBACK_BITRATE, codec: fallbackCodec };
		}

		const [sourceBitrate, sourceCodec] = await Promise.all([
			videoTrack.getBitrate(),
			videoTrack.getCodec(),
		]);

		// Match the source codec only if the browser can actually encode it.
		// Some browsers can't encode HEVC at all, and VP9 in an MP4 container
		// isn't a thing, so we always cross-check against the format's
		// supported set and fall back when needed.
		let codec: VideoCodec = fallbackCodec;
		if (sourceCodec) {
			const compatible =
				format === "mp4"
					? sourceCodec === "avc" ||
						sourceCodec === "hevc" ||
						sourceCodec === "av1"
					: sourceCodec === "vp9" ||
						sourceCodec === "vp8" ||
						sourceCodec === "av1";
			if (compatible) {
				const canEncode = await canEncodeVideo(sourceCodec, {
					width: videoTrack.displayWidth,
					height: videoTrack.displayHeight,
				});
				if (canEncode) {
					codec = sourceCodec;
				}
			}
		}

		return {
			bitrate:
				typeof sourceBitrate === "number" && sourceBitrate > 0
					? sourceBitrate
					: FALLBACK_BITRATE,
			codec,
		};
	} finally {
		input.dispose();
	}
}
