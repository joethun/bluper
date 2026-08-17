import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import type { AudioCodec } from "mediabunny";
import {
	readMediaSourceBytes,
	toInputSource,
	type MediaSourceRef,
} from "@/media/source";

/**
 * Decoding a whole audio source to an `AudioBuffer`, for every caller that needs
 * one: preview playback, export mixing and waveform summaries.
 *
 * Mediabunny is tried first. It pulls packets through WebCodecs, so peak memory
 * is a chunk rather than the file, and it reads the containers the built-in
 * decoders don't (`decodeAudioData` wants a file it recognises from the first
 * bytes, not a track inside an arbitrary container).
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

/**
 * Longest a single decoded chunk may take before the WebCodecs attempt is
 * abandoned for the platform decoder. Per chunk rather than for the whole
 * decode, because a long file legitimately takes a long time and a stall does
 * not — a decoder that is working answers every few milliseconds.
 */
const DECODE_STALL_TIMEOUT_MS = 5_000;

/**
 * How much of a track's own duration a decode has to account for to be believed.
 * Not 1: a lossy codec's first and last packets are partly priming, so a frame
 * or two of slack is normal. Anything below this is missing audio, which is
 * worth another decoder's opinion rather than a silent gap in the export.
 */
const MIN_DECODE_COVERAGE = 0.98;

/**
 * Codecs whose WebCodecs decode has already stalled in this session, so the next
 * clip in the same codec goes straight to the platform decoder. Whether an engine
 * can decode a codec through WebCodecs is a property of the engine, not of the
 * file, and paying [`DECODE_STALL_TIMEOUT_MS`] again per clip would put that wait
 * in front of every export on an engine where the answer is already known.
 */
const stalledCodecs = new Set<AudioCodec>();

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
	const streamed = await decodeWithMediabunny({ ref, sampleRate, maxChannels });
	if (streamed.status === "decoded") return streamed.buffer;
	if (streamed.status === "no-audio") return null;

	const decoded = await decodeWithPlatformDecoder({
		ref,
		sampleRate,
		maxChannels,
	});
	if (decoded.status === "decoded") return decoded.buffer;

	console.warn(
		"Failed to decode audio source:",
		streamed.error,
		decoded.status === "failed" ? decoded.error : "(no audio track)",
	);
	return null;
}

async function decodeWithMediabunny({
	ref,
	sampleRate,
	maxChannels,
}: DecodeAudioBufferOptions): Promise<DecodeOutcome> {
	const input = new Input({
		source: toInputSource({ ref }),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return { status: "no-audio" };

		const codec = await audioTrack.getCodec();
		if (codec && stalledCodecs.has(codec)) {
			return {
				status: "failed",
				error: new Error(
					`WebCodecs has already stalled decoding ${codec} on this engine`,
				),
			};
		}

		const trackDuration = await audioTrack.computeDuration();
		const sink = new AudioBufferSink(audioTrack);
		const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
		let decodedFrames = 0;

		// Stepped by hand rather than with `for await`, so each step can be given
		// a deadline. A stalled step abandons the whole attempt to the caller's
		// fallback instead of hanging the export that is waiting on it.
		const buffers = sink.buffers(0)[Symbol.asyncIterator]();
		try {
			for (;;) {
				const next = await withTimeout({
					label: "Decoding an audio chunk",
					timeoutMs: DECODE_STALL_TIMEOUT_MS,
					promise: buffers.next(),
					onTimeout: () => {
						if (codec) stalledCodecs.add(codec);
					},
				});
				if (next.done) break;
				chunks.push({
					buffer: next.value.buffer,
					timestamp: next.value.timestamp,
				});
				decodedFrames += next.value.buffer.length;
			}
		} finally {
			// Not awaited: the reason for being here may well be that this iterator
			// is the thing that stopped answering.
			void Promise.resolve(buffers.return?.()).catch(() => {});
		}

		if (chunks.length === 0 || decodedFrames === 0) {
			return {
				status: "failed",
				error: new Error("Audio source produced no samples"),
			};
		}

		const nativeSampleRate = chunks[0].buffer.sampleRate;
		const channelCount = clampChannelCount({
			channelCount: chunks[0].buffer.numberOfChannels,
			maxChannels,
		});

		// Each chunk is laid down at the timestamp it carries instead of after the
		// one before it. Appending assumes every packet arrived; when one doesn't,
		// appending shifts all the audio after it earlier and the whole track drifts
		// out of sync, where placing it leaves the hole where it actually is.
		const expectedFrames =
			trackDuration > 0 ? Math.round(trackDuration * nativeSampleRate) : 0;
		const decodedEnd = chunks.reduce(
			(end, chunk) =>
				Math.max(
					end,
					Math.max(0, Math.round(chunk.timestamp * nativeSampleRate)) +
						chunk.buffer.length,
				),
			0,
		);
		const frameCount = Math.max(1, expectedFrames, decodedEnd);

		if (expectedFrames > 0 && decodedFrames < expectedFrames * MIN_DECODE_COVERAGE) {
			return {
				status: "failed",
				error: new Error(
					`Audio source decoded ${(decodedFrames / expectedFrames).toFixed(3)} of its own duration`,
				),
			};
		}

		const channels = Array.from(
			{ length: channelCount },
			() => new Float32Array(new ArrayBuffer(frameCount * 4)),
		);
		for (const chunk of chunks) {
			const offset = Math.max(0, Math.round(chunk.timestamp * nativeSampleRate));
			const length = Math.min(chunk.buffer.length, frameCount - offset);
			if (length <= 0) continue;
			for (let channel = 0; channel < channelCount; channel++) {
				channels[channel].set(
					chunk.buffer
						.getChannelData(Math.min(channel, chunk.buffer.numberOfChannels - 1))
						.subarray(0, length),
					offset,
				);
			}
		}

		const native = createAudioBuffer({
			channels,
			frameCount,
			sampleRate: nativeSampleRate,
		});

		return {
			status: "decoded",
			buffer: await resampleBuffer({ buffer: native, sampleRate }),
		};
	} catch (error) {
		return { status: "failed", error };
	} finally {
		input.dispose();
	}
}

/**
 * Rejects if `promise` hasn't settled in time. The promise itself is left to its
 * own devices — there is no cancelling a pending decode — so callers must not
 * assume the work stopped, only that they are no longer waiting for it.
 */
async function withTimeout<T>({
	label,
	timeoutMs,
	promise,
	onTimeout,
}: {
	label: string;
	timeoutMs: number;
	promise: Promise<T>;
	onTimeout?: () => void;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					onTimeout?.();
					reject(new Error(`${label} stalled for ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
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

export function createAudioBuffer({
	channels,
	frameCount,
	sampleRate,
}: {
	channels: Float32Array<ArrayBuffer>[];
	frameCount: number;
	sampleRate: number;
}): AudioBuffer {
	bufferFactory ??= new OfflineAudioContext(1, 1, DEFAULT_DECODE_SAMPLE_RATE);

	const buffer = bufferFactory.createBuffer(
		channels.length,
		frameCount,
		sampleRate,
	);
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
