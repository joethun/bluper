/**
 * Reading what a file holds, before anything is decided about it.
 *
 * The kind is reported rather than assumed: an `.mp4` with no video track is
 * an audio file however it is named, and importing it as a video would put a
 * clip on the timeline that renders nothing. `.m4a`, `.mka` and audio-only
 * `.webm` files all arrive this way.
 *
 * ## Two ways in
 *
 * The probe runs in the shell, against a path — that is the whole point of it,
 * since ffmpeg reads containers the webview has never heard of and needs no
 * decoder in the page to answer.
 *
 * Media imported by reference already is a path, so {@link probeMediaPath}
 * reads the user's own file where it lies and writes nothing at all.
 *
 * Media that arrives as bytes — pasted, or dropped from another app — has no
 * path anywhere, so {@link probeStagedFile} streams it to a scratch file and
 * probes that. The scratch is *kept* and handed back: the import moves it into
 * the media store rather than streaming the same bytes a second time, which is
 * what a rename costs instead of a copy. An import that is abandoned deletes
 * it, and `sweep_stale_scratch_files` reclaims anything a crash leaves behind.
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
export async function probeMediaPath({
	path,
}: {
	path: string;
}): Promise<MediaProbeResult> {
	if (!tauriAvailable()) {
		return { status: "unreadable", reason: "container" };
	}

	let native: NativeMediaProbe;
	try {
		native = await tauriProbeMedia({ path });
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
			? await tauriMediaThumbnail({ path }).catch(() => null)
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
}

/**
 * Probes bytes that have no path of their own, keeping what it wrote.
 *
 * `stagedPath` is a scratch file holding the whole of `file`. The caller owns
 * it from here: an import that goes on to store the media moves it into place,
 * and one that gives up deletes it.
 */
export type StagedProbe = {
	result: MediaProbeResult;
	stagedPath: string | null;
};

export async function probeStagedFile({
	file,
}: {
	file: File;
}): Promise<StagedProbe> {
	if (!tauriAvailable()) {
		return {
			result: { status: "unreadable", reason: "container" },
			stagedPath: null,
		};
	}

	let stagedPath: string;
	try {
		stagedPath = await writeToScratch({ file });
	} catch (error) {
		return {
			result: { status: "unreadable", reason: "container", error },
			stagedPath: null,
		};
	}

	return { result: await probeMediaPath({ path: stagedPath }), stagedPath };
}

/** Deletes a scratch file left by {@link probeStagedFile}. */
export async function discardStagedFile({
	stagedPath,
}: {
	stagedPath: string | null;
}): Promise<void> {
	if (!stagedPath) return;
	await tauriRemoveFile({ path: stagedPath }).catch(() => {});
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
