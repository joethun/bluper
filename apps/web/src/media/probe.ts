/**
 * Reading what a file holds, before anything is decided about it.
 *
 * The kind is reported rather than assumed: an `.mp4` with no video track is
 * an audio file however it is named, and importing it as a video would put a
 * clip on the timeline that renders nothing. `.m4a`, `.mka` and audio-only
 * `.webm` files all arrive this way.
 *
 * ## Why the file is written before it is read
 *
 * The probe runs in the shell, against a path — that is the whole point of it,
 * since ffmpeg reads containers the webview has never heard of and needs no
 * decoder in the page to answer. But a file the user has just dropped is a
 * `File` in the page with no path anywhere.
 *
 * So it is streamed to a scratch path first, probed, and the scratch removed.
 * That is one extra write per import, and it is a real cost on a large file.
 * The way to remove it is to write the file to its final place in the media
 * store *first* and probe it there — which is a change to the import flow's
 * order rather than to this module, and is worth doing on its own.
 */

import {
	TauriWriteStream,
	tauriAvailable,
	tauriMediaThumbnail,
	tauriProbeMedia,
	tauriRemoveFile,
	tauriScratchPath,
	type NativeMediaProbe,
} from "@/lib/tauri-runtime";
import type { MediaType } from "./types";

/** Bytes per write while streaming a file to scratch. */
const CHUNK_BYTES = 8 * 1024 * 1024;

export type MediaProbe = {
	type: Extract<MediaType, "video" | "audio">;
	duration: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	hasAudio: boolean;
	/** In the export panel's vocabulary (`avc`, `hevc`, …), or null. */
	videoCodec: string | null;
	audioCodec: string | null;
	/**
	 * Whether this build has a decoder for the track. False means the
	 * container was read fine but nothing here can show what is inside it.
	 */
	canDecodeVideo: boolean;
	canDecodeAudio: boolean;
	thumbnailUrl: string | null;
};

/**
 * `unreadable` separates "no demuxer for this container" from "the container
 * says it holds nothing", because the advice differs: the first needs a
 * different file, the second a different track.
 */
export type MediaProbeResult =
	| { status: "ok"; probe: MediaProbe }
	| { status: "unreadable"; reason: "container" | "no-tracks"; error?: unknown };

/**
 * Reads a file's shape without decoding more of it than a single frame.
 *
 * Every container ffmpeg demuxes goes through here, which is a longer list
 * than any webview's — so the same probe answers for a camcorder's `.m2ts`
 * and for a `.flac`.
 */
export async function probeMediaFile({
	file,
}: {
	file: File;
}): Promise<MediaProbeResult> {
	if (!tauriAvailable()) {
		return { status: "unreadable", reason: "container" };
	}

	let scratch: string | null = null;
	try {
		scratch = await writeToScratch({ file });
	} catch (error) {
		return { status: "unreadable", reason: "container", error };
	}

	try {
		let native: NativeMediaProbe;
		try {
			native = await tauriProbeMedia({ path: scratch });
		} catch (error) {
			// Thrown while sniffing the container, so nothing was recognised.
			return { status: "unreadable", reason: "container", error };
		}

		const isVideo = native.kind === "video";
		if (!isVideo && !native.hasAudio) {
			return { status: "unreadable", reason: "no-tracks" };
		}

		const thumbnailUrl =
			isVideo && native.canDecodeVideo
				? await tauriMediaThumbnail({ path: scratch }).catch(() => null)
				: null;

		return {
			status: "ok",
			probe: {
				type: isVideo ? "video" : "audio",
				duration: native.durationSeconds,
				width: native.width,
				height: native.height,
				fps: native.fps,
				hasAudio: native.hasAudio,
				videoCodec: native.videoCodec,
				audioCodec: native.audioCodec,
				canDecodeVideo: native.canDecodeVideo,
				// The shell decodes audio itself, so a track it found is a
				// track it can read. There is no second engine to disagree.
				canDecodeAudio: native.hasAudio,
				thumbnailUrl,
			},
		};
	} finally {
		await tauriRemoveFile({ path: scratch }).catch(() => {});
	}
}

/**
 * Streams a `File` to a scratch path. Sliced rather than read whole: a
 * `File.arrayBuffer()` on a long recording is the memory ceiling the desktop
 * build exists to avoid.
 */
async function writeToScratch({ file }: { file: File }): Promise<string> {
	const path = await tauriScratchPath({
		name: `probe-${crypto.randomUUID()}`,
	});
	const stream = await TauriWriteStream.open({ path });
	try {
		let offset = 0;
		while (offset < file.size) {
			const end = Math.min(offset + CHUNK_BYTES, file.size);
			const slice = new Uint8Array(
				await file.slice(offset, end).arrayBuffer(),
			);
			await stream.write({ bytes: slice });
			offset = end;
		}
		await stream.close();
		return path;
	} catch (error) {
		await stream.abort().catch(() => {});
		throw error;
	}
}
