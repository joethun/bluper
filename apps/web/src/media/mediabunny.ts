import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	type AudioCodec,
	type InputAudioTrack,
	type InputVideoTrack,
	type VideoCodec,
} from "mediabunny";
import { renderThumbnailDataUrl } from "./thumbnail";
import type { MediaType } from "./types";

/**
 * What a file turned out to hold, read from the container itself.
 *
 * The kind is reported rather than assumed: an `.mp4` with no video track is an
 * audio file however it is named, and importing it as a video would put a clip
 * on the timeline that renders nothing. `.m4a`, `.mka` and audio-only `.webm`
 * files all arrive this way.
 */
export type MediaProbe = {
	type: Extract<MediaType, "video" | "audio">;
	duration: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	hasAudio: boolean;
	videoCodec: VideoCodec | null;
	audioCodec: AudioCodec | null;
	/**
	 * Whether a decoder took the track. False means the container was read fine
	 * but this engine has no decoder for what's inside it — HEVC outside Safari
	 * is the usual case.
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
 * Every container mediabunny demuxes goes through here — MP4, MOV, Matroska,
 * WebM, MPEG-TS, Ogg, WAVE, FLAC, ADTS and raw MP3 — so the same probe answers
 * for a camcorder's `.m2ts` and for a `.flac`.
 */
export async function probeMediaFile({
	file,
}: {
	file: File;
}): Promise<MediaProbeResult> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		let videoTrack: InputVideoTrack | null;
		let audioTrack: InputAudioTrack | null;
		try {
			[videoTrack, audioTrack] = await Promise.all([
				input.getPrimaryVideoTrack(),
				input.getPrimaryAudioTrack(),
			]);
		} catch (error) {
			// Thrown while sniffing the container, so nothing was recognised.
			return { status: "unreadable", reason: "container", error };
		}

		if (!videoTrack && !audioTrack) {
			return { status: "unreadable", reason: "no-tracks" };
		}

		const duration = await input.computeDuration();

		if (!videoTrack) {
			return {
				status: "ok",
				probe: {
					type: "audio",
					duration,
					width: null,
					height: null,
					fps: null,
					hasAudio: true,
					videoCodec: null,
					audioCodec: audioTrack?.codec ?? null,
					canDecodeVideo: false,
					canDecodeAudio: (await audioTrack?.canDecode()) ?? false,
					thumbnailUrl: null,
				},
			};
		}

		const [canDecodeVideo, packetStats] = await Promise.all([
			videoTrack.canDecode(),
			videoTrack.computePacketStats(100),
		]);

		return {
			status: "ok",
			probe: {
				type: "video",
				duration,
				width: videoTrack.displayWidth,
				height: videoTrack.displayHeight,
				fps: Number.isFinite(packetStats.averagePacketRate)
					? packetStats.averagePacketRate
					: null,
				hasAudio: audioTrack !== null,
				videoCodec: videoTrack.codec,
				audioCodec: audioTrack?.codec ?? null,
				canDecodeVideo,
				canDecodeAudio: (await audioTrack?.canDecode()) ?? false,
				thumbnailUrl: canDecodeVideo
					? await renderTrackThumbnail({ track: videoTrack })
					: null,
			},
		};
	} catch (error) {
		return { status: "unreadable", reason: "container", error };
	} finally {
		input.dispose();
	}
}

async function renderTrackThumbnail({
	track,
}: {
	track: InputVideoTrack;
}): Promise<string | null> {
	const sink = new VideoSampleSink(track);
	// A second in is past the fade-in most clips open with, but a clip can be
	// shorter than that — a phone burst or a sticker loop — and asking past the
	// end returns nothing at all, so the first frame stands in.
	const frame = (await sink.getSample(1)) ?? (await sink.getSample(0));
	if (!frame) return null;

	try {
		return renderThumbnailDataUrl({
			width: track.displayWidth,
			height: track.displayHeight,
			draw: ({ context, width, height }) => {
				frame.draw(context, 0, 0, width, height);
			},
		});
	} finally {
		frame.close();
	}
}
