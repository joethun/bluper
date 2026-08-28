import { readMediaSourceBytes, type MediaSourceRef } from "@/media/source";
import { decodeNativeAudioBuffer } from "@/media/native-audio";

/**
 * Decoding a whole audio source to an `AudioBuffer`, for every caller that needs
 * one: preview playback, export mixing and waveform summaries.
 *
 * The shell's decoder does the work. It reads the container in Rust — a longer
 * list of containers than any webview's — and resamples and mixes down on the
 * way out, so peak memory is a window rather than the file and the page never
 * sees a packet.
 *
 * But `AudioDecoder` coverage is not the same on every engine, and it cannot be
 * asked in advance: WebKitGTK — the webview behind the desktop build — answers
 * `AudioDecoder.isConfigSupported` for FLAC with `supported: true` and then
 * fails the first packet with a bare `Decode error`, so `canDecode()` reports
 * true for a track it will never decode. The same engine's `decodeAudioData`
 * handles that FLAC perfectly, because it runs the platform decoders behind
 * `<audio>` rather than WebCodecs.
 *
 * So neither path covers everything the editor accepts, and support can only be
 * established by trying: a source WebCodecs refuses falls back to
 * `decodeAudioData` over the raw bytes. Without the fallback a FLAC on the
 * timeline is silent in preview, has no waveform, and — worst of all — is
 * silently dropped from the exported mix.
 *
 * "Refuses" has to include "stops answering". The same engine decodes AAC and
 * Opus by never yielding the next buffer at all — no error, no rejection, just a
 * promise that stays pending — and a fallback that waits for a verdict it will
 * never get is no fallback. So the attempt is bounded, and what it returns is
 * checked against the track's own duration rather than trusted: a decode that
 * quietly comes back short is what puts gaps in an exported soundtrack.
 */

/** Rate to decode at when the caller has no context rate to match. */
const DEFAULT_DECODE_SAMPLE_RATE = 48000;

type DecodeOutcome =
	| { status: "decoded"; buffer: AudioBuffer }
	| { status: "no-audio" }
	| { status: "failed"; error: unknown };

export interface DecodeAudioBufferOptions {
	ref: MediaSourceRef;
	/**
	 * Rate the returned buffer is resampled to — pass the rate of the context it
	 * will be played through. Omit to keep the source's own rate.
	 */
	sampleRate?: number;
	/** Upper bound on channels. Omit to keep every channel the source has. */
	maxChannels?: number;
}

/**
 * Decodes every sample of an audio source. Returns null when the source has no
 * audio track, or when no available decoder could read it.
 */
export async function decodeAudioBufferFromRef({
	ref,
	sampleRate,
	maxChannels,
}: DecodeAudioBufferOptions): Promise<AudioBuffer | null> {
	// The shell's decoder. It reads the container in Rust and does the
	// resample and mixdown on the way out, rather than making the page render
	// them afterwards. It declines — rather than throwing — for a source it
	// cannot reach: an asset the user dropped a moment ago that the store has
	// not finished writing.
	const native = await decodeNativeAudioBuffer({
		ref,
		sampleRate,
		maxChannels,
		createBuffer: createEmptyAudioBuffer,
	});
	if (native) return native;

	// The one fallback left, and the only route that reads the whole file: a
	// container ffmpeg declined goes to the platform's own `decodeAudioData`
	// as bytes. Peak memory here is the file plus the decoded track, which is
	// why it is the last resort rather than a routine path.
	const decoded = await decodeWithPlatformDecoder({
		ref,
		sampleRate,
		maxChannels,
	});
	if (decoded.status === "decoded") return decoded.buffer;

	console.warn(
		"Failed to decode audio source:",
		decoded.status === "failed" ? decoded.error : "(no audio track)",
	);
	return null;
}


async function decodeWithPlatformDecoder({
	ref,
	sampleRate,
	maxChannels,
}: DecodeAudioBufferOptions): Promise<DecodeOutcome> {
	try {
		const bytes = await readMediaSourceBytes({ ref });

		// `decodeAudioData` resamples to the context's rate on the way out, so
		// decoding straight into the requested rate saves a second pass.
		const context = new OfflineAudioContext(
			1,
			1,
			sampleRate ?? DEFAULT_DECODE_SAMPLE_RATE,
		);
		const decoded = await decodeAudioData({ context, bytes });

		const channelCount = clampChannelCount({
			channelCount: decoded.numberOfChannels,
			maxChannels,
		});

		if (channelCount === decoded.numberOfChannels) {
			return {
				status: "decoded",
				buffer: await resampleBuffer({ buffer: decoded, sampleRate }),
			};
		}

		const channels = Array.from({ length: channelCount }, (_, channel) =>
			decoded.getChannelData(channel).slice(),
		);
		const clamped = createAudioBuffer({
			channels,
			frameCount: decoded.length,
			sampleRate: decoded.sampleRate,
		});

		return {
			status: "decoded",
			buffer: await resampleBuffer({ buffer: clamped, sampleRate }),
		};
	} catch (error) {
		return { status: "failed", error };
	}
}

/**
 * `decodeAudioData` predates promises and WebKit still implements the callback
 * form, where the return value is undefined rather than a promise.
 */
function decodeAudioData({
	context,
	bytes,
}: {
	context: BaseAudioContext;
	bytes: ArrayBuffer;
}): Promise<AudioBuffer> {
	return new Promise((resolve, reject) => {
		const pending = context.decodeAudioData(bytes, resolve, reject);
		if (pending) void pending.then(resolve, reject);
	});
}

function clampChannelCount({
	channelCount,
	maxChannels,
}: {
	channelCount: number;
	maxChannels?: number;
}): number {
	return Math.max(
		1,
		maxChannels ? Math.min(maxChannels, channelCount) : channelCount,
	);
}

/**
 * Minting an `AudioBuffer` needs some context to mint it from, but not a context
 * shaped like the buffer — so one shared no-op context serves every size and
 * rate, rather than allocating a whole file's worth of render graph per call.
 */
let bufferFactory: OfflineAudioContext | null = null;

export function createEmptyAudioBuffer({
	channelCount,
	frameCount,
	sampleRate,
}: {
	channelCount: number;
	frameCount: number;
	sampleRate: number;
}): AudioBuffer {
	bufferFactory ??= new OfflineAudioContext(1, 1, DEFAULT_DECODE_SAMPLE_RATE);
	return bufferFactory.createBuffer(channelCount, frameCount, sampleRate);
}

function createAudioBuffer({
	channels,
	frameCount,
	sampleRate,
}: {
	channels: Float32Array<ArrayBuffer>[];
	frameCount: number;
	sampleRate: number;
}): AudioBuffer {
	const buffer = createEmptyAudioBuffer({
		channelCount: channels.length,
		frameCount,
		sampleRate,
	});
	for (let channel = 0; channel < channels.length; channel++) {
		buffer.copyToChannel(channels[channel], channel);
	}

	return buffer;
}

/** Resamples through an offline render, which interpolates rather than drops. */
async function resampleBuffer({
	buffer,
	sampleRate,
}: {
	buffer: AudioBuffer;
	sampleRate?: number;
}): Promise<AudioBuffer> {
	if (sampleRate === undefined || buffer.sampleRate === sampleRate) {
		return buffer;
	}

	const frameCount = Math.max(
		1,
		Math.ceil(buffer.length * (sampleRate / buffer.sampleRate)),
	);
	const offline = new OfflineAudioContext(
		buffer.numberOfChannels,
		frameCount,
		sampleRate,
	);

	const source = offline.createBufferSource();
	source.buffer = buffer;
	source.connect(offline.destination);
	source.start(0);

	return await offline.startRendering();
}
