/**
 * Audio read by the desktop shell rather than by the page.
 *
 * The in-page routes exist because no single browser decoder covers everything
 * the editor accepts: `AudioDecoder` answers `isConfigSupported` with `true`
 * for FLAC on WebKitGTK and then fails the first packet, and some codecs stop
 * answering entirely rather than erroring, so the page's decode path is a chain
 * of bounded attempts with a coverage check to catch the ones that come back
 * quietly short. ffmpeg has none of that ambiguity, so where the shell is
 * available these two functions replace the whole chain — and where it is not,
 * they return null and the chain runs as before.
 *
 * Both are also faster on the material that made this matter. Measured against
 * a 68-minute AAC track: a waveform's first window arrives in 29ms against
 * ~210ms, the full summary in 2.1s against 5.9s, and a complete decode to
 * samples in 1.9s against 10.4s.
 */

import {
	tauriAudioWaveformSegment,
	tauriAvailable,
	tauriConvertFileSrc,
	tauriAudioShape,
	tauriDecodeAudioPcm,
	tauriDecodeAudioWindow,
	tauriReleaseAudioPcm,
	type NativeAudioShape,
	type NativeWaveformSegment,
} from "@/lib/tauri-runtime";
import { nativeSourcePath, type MediaSourceRef } from "@/media/source";

/**
 * How much of a track each waveform call reads.
 *
 * A window rather than the whole track so the wave can draw as it fills — an
 * hour-long source still takes seconds to read, and a clip that paints
 * progressively beats one that stays blank and snaps into place. Sixty seconds
 * measured 29ms per call on an hour-long AAC, which is well inside a frame and
 * far enough from the per-call overhead to be worth it.
 */
const WAVEFORM_WINDOW_SECONDS = 60;

/**
 * Frames of one channel read per range request. 4M frames is 16MB, which keeps
 * the transient buffer small next to the `AudioBuffer` being filled — the whole
 * point of not fetching the channel file in one piece.
 */
const PCM_CHUNK_FRAMES = 1 << 22;

/**
 * How many reads each route has served this session.
 *
 * The fallback is deliberately silent — a source the shell cannot read has to
 * keep playing — which means a native path that stopped working would look
 * exactly like one that was never reached. The desktop self-check asserts
 * against these so that cannot pass unnoticed.
 */
const nativeAudioCounts = { waveforms: 0, buffers: 0 };

export function getNativeAudioStats(): { waveforms: number; buffers: number } {
	return { ...nativeAudioCounts };
}

/** Whether the shell can read this source at all. */
function nativeAudioPath({ ref }: { ref: MediaSourceRef }): string | null {
	if (!tauriAvailable()) return null;
	return nativeSourcePath({ ref });
}

function decodePeaks(base64: string): Float32Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	// `atob` hands back a fresh buffer at offset zero, so the view is aligned.
	return new Float32Array(
		bytes.buffer,
		0,
		Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT),
	);
}

/** What one window contributed, folded into the track-wide array. */
export interface NativeWaveformProgress {
	sampleRate: number;
	totalSamples: number;
	amplitudes: Float32Array;
	highestBucket: number;
}

/**
 * Reads a source's peaks a window at a time, calling `onWindow` after each one
 * so the caller can repaint. Returns null when the shell cannot read the
 * source, which leaves the caller its own decoders to try.
 *
 * The array is allocated at its final length from the first window's track
 * shape, so every partial handed over has the same geometry as the finished
 * summary — a clip drawing from one cannot come out structurally short, only
 * unfilled.
 */
export async function readNativeWaveform({
	ref,
	bucketSize,
	onWindow,
}: {
	ref: MediaSourceRef;
	bucketSize: number;
	onWindow?: (progress: NativeWaveformProgress) => void;
}): Promise<NativeWaveformProgress | null> {
	const mediaPath = nativeAudioPath({ ref });
	if (!mediaPath) return null;

	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	let amplitudes = new Float32Array(0);
	// Settled by the first window and never revisited: every offset below is in
	// decoded frames, so a rate that changed partway would move the whole wave.
	let shape: NativeAudioShape | null = null;
	let totalSamples = 0;
	let highestBucket = -1;
	let startSeconds: number | null = 0;

	const ensureCapacity = (bucketIndex: number) => {
		if (bucketIndex < amplitudes.length) return;
		let capacity = Math.max(1024, amplitudes.length);
		while (capacity <= bucketIndex) capacity *= 2;
		const grown = new Float32Array(capacity);
		grown.set(amplitudes);
		amplitudes = grown;
	};

	try {
		while (startSeconds !== null) {
			const segment: NativeWaveformSegment = await tauriAudioWaveformSegment({
				mediaPath,
				startSeconds,
				durationSeconds: WAVEFORM_WINDOW_SECONDS,
				bucketSize: safeBucketSize,
			});

			if (!shape) {
				if (segment.shape.sampleRate <= 0) return null;
				shape = segment.shape;
				totalSamples = Math.max(1, Math.round(shape.totalFrames));
				amplitudes = new Float32Array(
					Math.max(1, Math.ceil(totalSamples / safeBucketSize)),
				);
			}

			const peaks = decodePeaks(segment.peaksBase64);
			if (peaks.length > 0) {
				ensureCapacity(segment.firstBucket + peaks.length - 1);
				for (let index = 0; index < peaks.length; index += 1) {
					const bucket = segment.firstBucket + index;
					const peak = peaks[index]!;
					// Merged with max rather than assigned: windows are cut on
					// frame boundaries, so consecutive ones can both touch the
					// bucket they meet in.
					if (peak > amplitudes[bucket]!) amplitudes[bucket] = peak;
					if (bucket > highestBucket) highestBucket = bucket;
				}
				onWindow?.({
					sampleRate: shape.sampleRate,
					totalSamples,
					amplitudes,
					highestBucket,
				});
			}

			startSeconds = segment.nextStartSeconds;
		}
	} catch (error) {
		console.warn("Native waveform read failed:", error);
		return null;
	}

	if (!shape || highestBucket < 0) return null;
	nativeAudioCounts.waveforms += 1;
	return {
		sampleRate: shape.sampleRate,
		totalSamples,
		amplitudes,
		highestBucket,
	};
}

/**
 * Reads one channel file into `buffer`.
 *
 * Range requests rather than one fetch: a channel of an hour-long track is
 * ~700MB, and pulling it whole would hold it in the page on top of the
 * `AudioBuffer` it is being copied into. A shell that answers with the whole
 * file anyway (status 200 rather than 206) is handled by taking that response
 * as the entire channel and stopping — being wrong about a range would
 * otherwise write the head of the file over and over.
 */
async function readChannelInto({
	path,
	frames,
	buffer,
	channel,
}: {
	path: string;
	frames: number;
	buffer: AudioBuffer;
	channel: number;
}): Promise<void> {
	const url = tauriConvertFileSrc(path);
	const bytesPerFrame = Float32Array.BYTES_PER_ELEMENT;
	let offset = 0;

	while (offset < frames) {
		const count = Math.min(PCM_CHUNK_FRAMES, frames - offset);
		const firstByte = offset * bytesPerFrame;
		const lastByte = firstByte + count * bytesPerFrame - 1;
		const response = await fetch(url, {
			headers: { Range: `bytes=${firstByte}-${lastByte}` },
		});
		if (!response.ok) {
			throw new Error(`Could not read decoded audio: ${response.status}`);
		}

		const bytes = await response.arrayBuffer();
		const samples = new Float32Array(
			bytes,
			0,
			Math.floor(bytes.byteLength / bytesPerFrame),
		);

		if (response.status !== 206) {
			buffer.copyToChannel(
				samples.subarray(0, Math.min(samples.length, buffer.length)),
				channel,
				0,
			);
			return;
		}

		if (samples.length === 0) {
			throw new Error("Decoded audio ended before the frames it reported");
		}
		buffer.copyToChannel(
			samples.subarray(0, Math.min(samples.length, buffer.length - offset)),
			channel,
			offset,
		);
		offset += samples.length;
	}
}

/**
 * Decodes a whole audio source through the shell. Returns null when the shell
 * cannot read it, so the caller falls back to its own decoders.
 *
 * `createBuffer` is passed in rather than imported to keep this file off
 * `decode-audio`'s import cycle — that module is the one calling this.
 */
export async function decodeNativeAudioBuffer({
	ref,
	sampleRate,
	maxChannels,
	createBuffer,
}: {
	ref: MediaSourceRef;
	sampleRate?: number;
	maxChannels?: number;
	createBuffer: (init: {
		channelCount: number;
		frameCount: number;
		sampleRate: number;
	}) => AudioBuffer;
}): Promise<AudioBuffer | null> {
	const mediaPath = nativeAudioPath({ ref });
	if (!mediaPath) return null;

	let token: string | null = null;
	try {
		const pcm = await tauriDecodeAudioPcm({
			mediaPath,
			sampleRate,
			maxChannels,
		});
		token = pcm.token;

		if (pcm.channelPaths.length === 0 || pcm.frames <= 0) return null;

		// Sized to hold everything decoded as well as everything declared: a
		// container's stated duration routinely runs a little past its last
		// sample, and occasionally a little short of it. Taking the larger keeps
		// the trailing audio and the declared length both intact.
		const frameCount = Math.max(1, pcm.frames, Math.round(pcm.shape.totalFrames));
		const buffer = createBuffer({
			channelCount: pcm.channelPaths.length,
			frameCount,
			sampleRate: pcm.shape.sampleRate,
		});

		// One read per channel, together rather than in turn: each reads a
		// different file into a different channel of the buffer, so nothing
		// orders them. A stereo track is two reads the size of the decoded
		// track, which serially is two full passes over the asset protocol.
		await Promise.all(
			pcm.channelPaths.map((path, channel) =>
				readChannelInto({ path, frames: pcm.frames, buffer, channel }),
			),
		);

		nativeAudioCounts.buffers += 1;
		return buffer;
	} catch (error) {
		console.warn("Native audio decode failed:", error);
		return null;
	} finally {
		if (token) {
			// These files are the size of the decoded track. Leaving them for the
			// startup sweep would mean gigabytes sitting in the cache all session.
			await tauriReleaseAudioPcm({ token }).catch(() => {
				// Losing a scratch directory costs disk, not correctness.
			});
		}
	}
}

/** One decoded window, with the source time its first sample belongs at. */
export interface NativeAudioWindow {
	buffer: AudioBuffer;
	timestamp: number;
}

/**
 * A clip's audio, decoded a window at a time by the shell.
 *
 * This is what playback streams from, and it used to begin by decoding the
 * *whole* track to disk: one `f32` file per channel, read back over range
 * requests. That made the decode shared and the memory bounded, and it made
 * starting playback wait for the entire track. Measured on the user's own
 * media, a 74-minute source took **4.1 seconds and 1.71GB of writes** before
 * the first sample could be heard, and a 49-minute one 2.7s / 1.12GB.
 *
 * A window is decoded on demand instead. The shell keeps the container and the
 * decoder open between calls, so the first window costs a container open and one
 * window's decode — about 15ms — and each one after it around 4ms, because a
 * window that begins where the last ended needs no seek. Nothing is staged, so
 * there is nothing to release and no gigabyte of scratch to clean up.
 *
 * The whole-track route is still there for export, which genuinely wants every
 * sample at once. See {@link decodeNativeAudioBuffer}.
 */
export class NativeAudioStream {
	private constructor({
		mediaPath,
		frames,
		sampleRate,
		channelCount,
		requestedSampleRate,
		maxChannels,
		createBuffer,
	}: {
		mediaPath: string;
		frames: number;
		sampleRate: number;
		channelCount: number;
		requestedSampleRate?: number;
		maxChannels?: number;
		createBuffer: CreateAudioBuffer;
	}) {
		this.mediaPath = mediaPath;
		this.frames = frames;
		this.sampleRate = sampleRate;
		this.channelCount = channelCount;
		this.requestedSampleRate = requestedSampleRate;
		this.maxChannels = maxChannels;
		this.createBuffer = createBuffer;
	}

	private readonly mediaPath: string;
	private readonly frames: number;
	private readonly channelCount: number;
	/**
	 * Passed back on every window request so the shell resamples to the same
	 * shape it reported from {@link open} — asking for a different one would
	 * build a second decoder over the same file.
	 */
	private readonly requestedSampleRate?: number;
	private readonly maxChannels?: number;
	readonly sampleRate: number;
	private readonly createBuffer: CreateAudioBuffer;

	/**
	 * Reads what `ref` is and returns a reader over it, or null when the shell
	 * cannot reach the source — an asset the store has not finished writing.
	 *
	 * No audio is decoded here beyond the one frame the shell needs to settle
	 * the track's rate and channel count.
	 */
	static async open({
		ref,
		sampleRate,
		maxChannels,
		createBuffer,
	}: {
		ref: MediaSourceRef;
		sampleRate?: number;
		maxChannels?: number;
		createBuffer: CreateAudioBuffer;
	}): Promise<NativeAudioStream | null> {
		const mediaPath = nativeAudioPath({ ref });
		if (!mediaPath) return null;

		const shape = await tauriAudioShape({ mediaPath, sampleRate, maxChannels });
		if (shape.channels <= 0 || shape.sampleRate <= 0) return null;
		// A track whose container declares no duration reports no frames, and a
		// zero-length stream would yield nothing at all.
		const frames = Math.max(0, Math.round(shape.totalFrames));
		if (frames <= 0) return null;

		return new NativeAudioStream({
			mediaPath,
			frames,
			sampleRate: shape.sampleRate,
			channelCount: shape.channels,
			requestedSampleRate: sampleRate,
			maxChannels,
			createBuffer,
		});
	}

	/** Seconds of audio in one window. */
	static readonly WINDOW_SECONDS = 1;

	/**
	 * Windows from `startSeconds` to the end of the track. Each carries the
	 * source time it belongs at, so a consumer can schedule it without
	 * counting what came before — a window that arrived late cannot shift the
	 * ones after it.
	 */
	async *buffers(startSeconds: number): AsyncGenerator<
		NativeAudioWindow,
		void,
		unknown
	> {
		const total = this.frames / this.sampleRate;
		let at = Math.max(0, startSeconds);

		while (at < total) {
			const seconds = Math.min(
				NativeAudioStream.WINDOW_SECONDS,
				total - at,
			);
			const window = await tauriDecodeAudioWindow({
				mediaPath: this.mediaPath,
				startSeconds: at,
				durationSeconds: seconds,
				sampleRate: this.requestedSampleRate,
				maxChannels: this.maxChannels,
			});
			// A track can decode a frame or two short of its declared duration,
			// so an empty window at the end is the end rather than an error.
			if (window.frames <= 0) return;

			const buffer = this.createBuffer({
				channelCount: Math.max(1, Math.min(window.channels.length, this.channelCount)),
				frameCount: window.frames,
				sampleRate: window.sampleRate,
			});
			for (
				let channel = 0;
				channel < buffer.numberOfChannels;
				channel += 1
			) {
				// A mono source feeding a stereo buffer repeats its only channel
				// rather than leaving the second silent.
				const plane =
					window.channels[channel] ?? window.channels[0];
				if (plane) {
					buffer.copyToChannel(plane.subarray(0, buffer.length), channel, 0);
				}
			}

			// Placed by where the shell says the samples are, not by where they
			// were asked for: a seek lands on a packet boundary, and scheduling
			// by the request would drift by whatever the difference was.
			yield { buffer, timestamp: window.firstSeconds };
			at = window.firstSeconds + window.frames / window.sampleRate;
		}
	}

	/**
	 * Nothing to let go of — windows are decoded on demand and never staged.
	 * Kept so callers that opened a stream can close it without caring which
	 * route it used.
	 */
	async close(): Promise<void> {}
}

type CreateAudioBuffer = (init: {
	channelCount: number;
	frameCount: number;
	sampleRate: number;
}) => AudioBuffer;

