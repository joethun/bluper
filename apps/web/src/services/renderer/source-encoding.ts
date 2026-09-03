/**
 * Picks the bitrate and codec the exporter should use.
 *
 * The bitrate starts from the first video asset in the project, so an export at
 * the project's own resolution lands at the size and quality of what went in,
 * and is then scaled by the area the chosen resolution actually covers —
 * otherwise a 360p export of a 4K source would weigh what the 4K one does.
 * Opening a file just to read a header field is cheap (ffmpeg stops at the
 * moov), but we still cache by file identity so repeated exports in one session
 * don't reopen.
 *
 * The codec is no longer a question the source gets a say in. Every export asks
 * for `EXPORT_VIDEO_CODEC`, and `resolveExportVideoCodec` settles whether this
 * build can actually encode it — a preference, not an instruction, so a machine
 * without an H.264 encoder still exports using whatever MP4 offers instead.
 */

import { tauriProbeMedia } from "@/lib/tauri-runtime";
import type { MediaAsset } from "@/media/types";
import { createMediaSource, nativeSourcePath } from "@/media/source";
import { EXPORT_FORMAT, EXPORT_VIDEO_CODEC, resolveExportVideoCodec } from "@/export";
import type { ExportResolution, VideoCodecName } from "@/export";
import type { TCanvasSize } from "@/project/types";
import { exportVideoBitrate } from "@/wasm/export";

/**
 * Fallback bitrate when the source doesn't report one. Tuned for 1080p at
 * ~5 Mbps, which is in the same ballpark as a typical phone or screen
 * recording. It stands for the *project's* resolution, whatever that is, and
 * is scaled down from there like any other source bitrate.
 */
const FALLBACK_BITRATE = 5_000_000;

export type SourceEncoding = {
	bitrate: number;
	/** Null when the container holds video this engine has no encoder for. */
	codec: VideoCodecName | null;
};

const cache = new Map<string, Promise<number>>();

export async function resolveSourceEncoding({
	mediaAssets,
	canvas,
	resolution,
}: {
	mediaAssets: MediaAsset[];
	/** The project's canvas size — what the source bitrate is a bitrate *for*. */
	canvas: TCanvasSize;
	/** The size the export will actually be encoded at. */
	resolution: ExportResolution;
}): Promise<SourceEncoding> {
	const sourceBitrate = await readFirstVideoBitrate({ mediaAssets });

	return {
		bitrate: exportVideoBitrate({
			sourceBitrate,
			canvas,
			output: resolution,
		}),
		codec: await resolveExportVideoCodec({
			format: EXPORT_FORMAT,
			preferred: EXPORT_VIDEO_CODEC,
		}),
	};
}

async function readFirstVideoBitrate({
	mediaAssets,
}: {
	mediaAssets: MediaAsset[];
}): Promise<number> {
	const firstVideo = mediaAssets.find((asset) => asset.type === "video");
	if (!firstVideo) return FALLBACK_BITRATE;

	const source = createMediaSource({ asset: firstVideo });
	if (!source) return FALLBACK_BITRATE;
	const path = nativeSourcePath({ ref: source });
	// An asset the user has only just dropped in has no file on disk yet. Its
	// bitrate is a nicety — the export still runs on the fallback — so this
	// waits for the asset to be stored rather than reading the blob a second
	// way to find out.
	if (!path) return FALLBACK_BITRATE;

	const cacheKey = firstVideo.id;
	let promise = cache.get(cacheKey);
	if (!promise) {
		promise = readSourceBitrate({ path }).finally(() => {
			cache.delete(cacheKey);
		});
		cache.set(cacheKey, promise);
	}

	return promise;
}

async function readSourceBitrate({
	path,
}: {
	path: string;
}): Promise<number> {
	try {
		const probe = await tauriProbeMedia({ path });
		return probe.bitrate !== null && probe.bitrate > 0
			? probe.bitrate
			: FALLBACK_BITRATE;
	} catch {
		// A source the exporter can't read is not a reason to refuse the
		// export; the timeline may not even use its video.
		return FALLBACK_BITRATE;
	}
}
