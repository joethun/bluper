/**
 * Frames out of the desktop shell's demuxer instead of mediabunny's.
 *
 * The shell walks the container in Rust and writes one GOP's encoded packets to
 * a scratch file; this reads that file, feeds the packets to a `VideoDecoder`,
 * and hands the decoded frames back as {@link VideoSample}s so the cache
 * above it — and every consumer above that — cannot tell the difference. Only
 * the demuxing moved: the codec still runs in the browser, and no pixel data
 * ever crosses the IPC boundary.
 *
 * The web build has no shell, and an asset the user just dropped in has no path
 * on disk yet — {@link openNativeVideoSink} returns null then, and the caller
 * reports that the clip cannot be previewed until it has been stored. There is
 * no in-page demuxer behind it any more.
 */

import { VideoSample } from "@/media/video-sample";
import {
	tauriAvailable,
	tauriConvertFileSrc,
	tauriDecodeVideoFrame,
	tauriDecodeVideoGop,
	type NativeChunkInfo,
	type NativeGopInfo,
	type NativeVideoConfig,
} from "@/lib/tauri-runtime";
import { nativeSourcePath, type MediaSourceRef } from "@/media/source";

/**
 * How many frames may be decoded but not yet handed to the caller.
 *
 * This is the only thing standing between a long GOP and the whole of it
 * sitting in memory as raw pixels: a 4K frame is ~12MB, and a GOP can be a
 * hundred frames. The caller pulls one frame at a time, so the generator stops
 * feeding the decoder once this many are outstanding and only resumes as they
 * are taken.
 */
const MAX_FRAMES_IN_FLIGHT = 4;

/**
 * How long to wait for the decoder to produce a frame before feeding it another
 * chunk anyway.
 *
 * A decoder with B-frames holds several inputs before it can emit anything, so
 * "wait for a frame before sending more" can deadlock on a stream whose reorder
 * depth exceeds {@link MAX_FRAMES_IN_FLIGHT}. Letting the cap slip after a short
 * wait trades a little memory for never hanging.
 */
const FRAME_WAIT_MS = 8;

/** Presentation timestamps are seconds converted from integer ticks. */
const PTS_EPSILON = 1e-6;

/** Used only when a GOP holds a single frame and nothing can be measured. */
const FALLBACK_FRAME_DURATION = 1 / 30;

function microseconds(seconds: number): number {
	return Math.round(seconds * 1e6);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function toDecoderConfig({
	config,
}: {
	config: NativeVideoConfig;
}): VideoDecoderConfig {
	const decoderConfig: VideoDecoderConfig = {
		codec: config.codec,
		optimizeForLatency: true,
	};
	if (config.codedWidth > 0 && config.codedHeight > 0) {
		decoderConfig.codedWidth = config.codedWidth;
		decoderConfig.codedHeight = config.codedHeight;
	}
	// An Annex-B stream carries its parameter sets inline and must be configured
	// with no `description` at all — an empty one is rejected outright.
	if (config.descriptionBase64) {
		decoderConfig.description = base64ToBytes(config.descriptionBase64);
	}
	return decoderConfig;
}

function configKeyOf({ config }: { config: NativeVideoConfig }): string {
	return [
		config.codec,
		config.codedWidth,
		config.codedHeight,
		config.descriptionBase64,
	].join("|");
}

function normalizeRotation(degrees: number): 0 | 90 | 180 | 270 {
	switch (degrees) {
		case 90:
			return 90;
		case 180:
			return 180;
		case 270:
			return 270;
		default:
			return 0;
	}
}

/**
 * How long each frame in the GOP is on screen, keyed by its microsecond
 * timestamp — which is what comes back on the decoded `VideoFrame`.
 *
 * The demuxer reports when frames start, never how long they last, and the
 * cache above this decides whether a frame is still current by `timestamp +
 * duration`. So each frame runs until the next one in *presentation* order
 * starts; packets arrive in decode order, which for B-frames is not the same.
 */
function frameDurations({ gop }: { gop: NativeGopInfo }): Map<number, number> {
	const starts = gop.chunks.map((chunk) => chunk.ptsSeconds).sort((a, b) => a - b);
	const durations = new Map<number, number>();

	for (let index = 0; index < starts.length; index += 1) {
		const start = starts[index]!;
		const next = starts[index + 1];
		// The GOP's last frame runs up to the next GOP's keyframe. At the end of
		// the file there is nothing to measure against, so it repeats the frame
		// before it.
		const end =
			next ??
			gop.nextGopStartSeconds ??
			(index > 0 ? start + (start - starts[index - 1]!) : Number.NaN);
		durations.set(
			microseconds(start),
			end > start ? end - start : FALLBACK_FRAME_DURATION,
		);
	}

	return durations;
}

async function readGopPackets({
	gop,
}: {
	gop: NativeGopInfo;
}): Promise<Uint8Array> {
	const response = await fetch(tauriConvertFileSrc(gop.scratchPath));
	if (!response.ok) {
		throw new Error(
			`Could not read demuxed GOP at ${gop.scratchPath}: ${response.status}`,
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * Demuxed GOPs held in memory, shared by every sink reading the same file.
 *
 * A scrub asks for a different time on every pointer move, and each one starts
 * a fresh `samples()`: an IPC round trip to the shell's demuxer, then a fetch
 * of the whole GOP file back over the asset protocol — for packets the step
 * before it had just read. The shell keys its own on-disk cache by a 100ms
 * bucket of the *requested* time, so dragging through a single two-second GOP
 * also re-demuxed and rewrote it about twenty times, once per bucket the
 * playhead touched.
 *
 * Entries here are keyed by the interval a GOP actually covers rather than by
 * the time that was asked for, so every request landing anywhere inside one is
 * a hit and the shell is asked at most once per GOP.
 *
 * ## Why an entry always holds its bytes
 *
 * A GOP file's name is that 100ms bucket, so its *contents* are not stable:
 * two requests in one bucket that straddle a keyframe want different GOPs, and
 * the second demux writes over the first's file. An entry that remembered only
 * where its packets were could therefore be handed another GOP's bytes under
 * its own chunk offsets, which decodes to garbage. So the packets are read as
 * part of filing the entry and the path is never used again — and the read is
 * serialised per file (see {@link inFileOrder}) so no demux of the same file
 * can overwrite what a read has in flight.
 */
const GOP_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** Also capped by count, so many small GOPs cannot grow the list without end. */
const GOP_CACHE_MAX_ENTRIES = 64;

type CachedGop = {
	mediaPath: string;
	gop: NativeGopInfo;
	packets: Uint8Array;
	/**
	 * This GOP was returned for a request at the start of the file, so there is
	 * nothing before it. What lets a request landing ahead of the first
	 * keyframe — a stream whose pictures begin a little after zero — be answered
	 * from here rather than sent to the shell to be told the same thing.
	 */
	isFirst: boolean;
};

/** Least-recently-used first, so eviction takes from the front. */
const gopCache: CachedGop[] = [];
let gopCacheBytes = 0;

/** One chain per file, so demuxes of it cannot overlap each other's reads. */
const fileOrder = new Map<string, Promise<unknown>>();

function inFileOrder<T>({
	mediaPath,
	run,
}: {
	mediaPath: string;
	run: () => Promise<T>;
}): Promise<T> {
	// Chained off a settled tail rather than the previous result, so one failed
	// demux does not reject every one queued behind it.
	const previous = fileOrder.get(mediaPath) ?? Promise.resolve();
	const result = previous.then(run, run);
	fileOrder.set(
		mediaPath,
		result.catch(() => undefined),
	);
	return result;
}

function touchGop(entry: CachedGop): CachedGop {
	const index = gopCache.indexOf(entry);
	if (index >= 0) gopCache.splice(index, 1);
	gopCache.push(entry);
	return entry;
}

/** The cached GOP covering `time`, if it has been demuxed before. */
function cachedGopAt({
	mediaPath,
	time,
}: {
	mediaPath: string;
	time: number;
}): CachedGop | null {
	let first: CachedGop | null = null;

	for (const entry of gopCache) {
		if (entry.mediaPath !== mediaPath) continue;

		const { startPtsSeconds, nextGopStartSeconds } = entry.gop;
		if (
			startPtsSeconds <= time + PTS_EPSILON &&
			(nextGopStartSeconds === null || time + PTS_EPSILON < nextGopStartSeconds)
		) {
			return touchGop(entry);
		}

		// Only the file's first GOP may answer for a time ahead of its own
		// start. Any other one has material before it that this cache may
		// simply not be holding, and handing it back would be a frame from the
		// wrong part of the file rather than a miss.
		if (entry.isFirst) first = entry;
	}

	if (first && time < first.gop.startPtsSeconds) {
		return touchGop(first);
	}
	return null;
}

function evictGops(): void {
	while (
		(gopCacheBytes > GOP_CACHE_BUDGET_BYTES ||
			gopCache.length > GOP_CACHE_MAX_ENTRIES) &&
		gopCache.length > 1
	) {
		const evicted = gopCache.shift();
		gopCacheBytes -= evicted?.packets.byteLength ?? 0;
	}
}

/** The GOP covering `startSeconds` with its packets, from memory where possible. */
async function loadGop({
	mediaPath,
	startSeconds,
}: {
	mediaPath: string;
	startSeconds: number;
}): Promise<CachedGop> {
	const cached = cachedGopAt({ mediaPath, time: startSeconds });
	if (cached) return cached;

	return await inFileOrder({
		mediaPath,
		run: async () => {
			// Another reader of this file may have filed exactly this GOP while
			// we waited our turn.
			const filed = cachedGopAt({ mediaPath, time: startSeconds });
			if (filed) return filed;

			const gop = await tauriDecodeVideoGop({ mediaPath, startSeconds });
			const packets = await readGopPackets({ gop });

			const entry = touchGop({
				mediaPath,
				gop,
				packets,
				isFirst: startSeconds <= 0,
			});
			gopCacheBytes += packets.byteLength;
			evictGops();
			return entry;
		},
	});
}

/**
 * Drops what is held for one file. Called when its asset leaves the project —
 * a sink going idle deliberately does not, because reopening it is exactly the
 * case this cache exists for.
 */
export function forgetCachedGops({ mediaPath }: { mediaPath: string }): void {
	for (let index = gopCache.length - 1; index >= 0; index -= 1) {
		const entry = gopCache[index]!;
		if (entry.mediaPath !== mediaPath) continue;
		gopCacheBytes -= entry.packets.byteLength;
		gopCache.splice(index, 1);
	}
	fileOrder.delete(mediaPath);
}

/**
 * Mediabunny's `VideoSampleSink` interface, backed by the shell's demuxer.
 * Only `samples` and `dispose` are implemented, because that is all the video
 * cache asks for.
 */
export class NativeVideoSampleSink {
	readonly mediaPath: string;
	private decoder: VideoDecoder | null = null;
	private configKey: string | null = null;
	private rotation: 0 | 90 | 180 | 270 = 0;
	private ready: VideoFrame[] = [];
	private onFrame: (() => void) | null = null;
	private failure: Error | null = null;
	private disposed = false;

	constructor({ mediaPath }: { mediaPath: string }) {
		this.mediaPath = mediaPath;
	}

	/**
	 * Decoded frames from `startTime` onward, in presentation order. Ends when
	 * the file does.
	 *
	 * The frames the GOP's keyframe needs in order to reach `startTime` are
	 * decoded and dropped rather than yielded, so the first frame out is the one
	 * covering the requested time — the same contract mediabunny's sink has.
	 */
	async *samples(
		startTime: number,
	): AsyncGenerator<VideoSample, void, unknown> {
		const from = Math.max(0, startTime);
		// A new iterator means a seek: anything the previous one left decoded is
		// at the wrong position now.
		this.reset();

		try {
			let gopStart: number | null = from;

			while (gopStart !== null && !this.disposed) {
				const { gop, packets } = await loadGop({
					mediaPath: this.mediaPath,
					startSeconds: gopStart,
				});
				this.configure({ config: gop.config });
				const durations = frameDurations({ gop });
				let inFlight = 0;

				for (const chunk of gop.chunks) {
					while (inFlight >= MAX_FRAMES_IN_FLIGHT) {
						if (this.failure) throw this.failure;
						if (this.ready.length === 0) {
							await this.waitForFrame();
							// Still nothing: the decoder is holding frames it cannot
							// emit until it has more input, so give it more.
							if (this.ready.length === 0) break;
						}
						inFlight -= 1;
						const sample = this.take({ durations, from });
						if (sample) yield sample;
					}
					this.decode({ chunk, packets });
					inFlight += 1;
				}

				// Every GOP starts on a keyframe, so the decoder can be drained at
				// each boundary without losing anything — and it has to be, or the
				// trailing B-frames never come out.
				await this.flush();
				while (this.ready.length > 0) {
					const sample = this.take({ durations, from });
					if (sample) yield sample;
				}
				if (this.failure) throw this.failure;

				gopStart = gop.nextGopStartSeconds;
			}
		} finally {
			this.reset();
		}
	}

	/**
	 * The single frame shown at `time`, decoded in the shell.
	 *
	 * Used for seeking and scrubbing, where {@link samples} is the wrong shape
	 * of work: a `VideoDecoder` handed a GOP has to decode from its keyframe to
	 * reach the requested time, and on a source re-encoded with almost no
	 * keyframes that is a whole minute of video for one picture — about 700ms,
	 * paid again on every pointer move. The shell decodes it across every core
	 * and sends back the one frame: 89ms for a jump, 5ms while dragging.
	 *
	 * Playing forwards still goes through {@link samples}. Per frame the
	 * webview's decoder is faster there — 0.71ms — and it moves no pixels over
	 * the IPC boundary.
	 */
	async frameAt(time: number): Promise<VideoSample | null> {
		if (this.disposed) return null;
		const decoded = await tauriDecodeVideoFrame({
			mediaPath: this.mediaPath,
			atSeconds: Math.max(0, time),
		});
		if (this.disposed) return null;
		if (decoded.codedWidth <= 0 || decoded.codedHeight <= 0) return null;

		const frame = new VideoFrame(decoded.planes, {
			format: "I420",
			codedWidth: decoded.codedWidth,
			codedHeight: decoded.codedHeight,
			timestamp: microseconds(decoded.ptsSeconds),
			layout: decoded.layout,
		});

		// How long this picture is on screen. The shell reports where the next
		// frame starts, which is the only honest answer — a container says when
		// frames begin and never how long they last. At the end of the file
		// there is no next one, and the fallback keeps the sample valid for a
		// frame rather than expiring it the instant it arrives.
		const duration =
			decoded.nextPtsSeconds !== null &&
			decoded.nextPtsSeconds > decoded.ptsSeconds
				? decoded.nextPtsSeconds - decoded.ptsSeconds
				: FALLBACK_FRAME_DURATION;

		return new VideoSample({
			frame,
			timestamp: decoded.ptsSeconds,
			duration,
			rotation: normalizeRotation(decoded.rotation),
		});
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
		const decoder = this.decoder;
		this.decoder = null;
		this.configKey = null;
		if (decoder && decoder.state !== "closed") {
			try {
				decoder.close();
			} catch {
				// Already closed, or closed underneath us by an error.
			}
		}
	}

	private configure({ config }: { config: NativeVideoConfig }): void {
		const key = configKeyOf({ config });
		if (
			this.decoder &&
			this.decoder.state === "configured" &&
			this.configKey === key
		) {
			return;
		}

		if (!this.decoder || this.decoder.state === "closed") {
			this.decoder = new VideoDecoder({
				output: (frame) => {
					if (this.disposed) {
						frame.close();
						return;
					}
					this.ready.push(frame);
					const waiter = this.onFrame;
					this.onFrame = null;
					waiter?.();
				},
				error: (error) => {
					this.failure =
						error instanceof Error ? error : new Error(String(error));
					const waiter = this.onFrame;
					this.onFrame = null;
					waiter?.();
				},
			});
		}

		this.decoder.configure(toDecoderConfig({ config }));
		this.configKey = key;
		this.rotation = normalizeRotation(config.rotation);
	}

	private decode({
		chunk,
		packets,
	}: {
		chunk: NativeChunkInfo;
		packets: Uint8Array;
	}): void {
		const decoder = this.decoder;
		if (!decoder || decoder.state !== "configured") return;
		decoder.decode(
			new EncodedVideoChunk({
				type: chunk.isKeyframe ? "key" : "delta",
				timestamp: microseconds(chunk.ptsSeconds),
				// A view, not a copy: `EncodedVideoChunk` takes its own copy, so
				// the GOP file is read into memory once for the whole GOP.
				data: packets.subarray(chunk.offset, chunk.offset + chunk.length),
			}),
		);
	}

	/**
	 * Takes the oldest decoded frame. Returns null for a frame that only exists
	 * to get the decoder to the requested time — it is closed rather than shown.
	 */
	private take({
		durations,
		from,
	}: {
		durations: Map<number, number>;
		from: number;
	}): VideoSample | null {
		const frame = this.ready.shift();
		if (!frame) return null;

		const duration = durations.get(frame.timestamp) ?? FALLBACK_FRAME_DURATION;
		const timestamp = frame.timestamp / 1e6;
		if (timestamp + duration <= from + PTS_EPSILON) {
			frame.close();
			return null;
		}

		return new VideoSample({
			frame,
			timestamp,
			duration,
			rotation: this.rotation,
		});
	}

	private waitForFrame(): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.onFrame = null;
				resolve();
			}, FRAME_WAIT_MS);
			this.onFrame = () => {
				clearTimeout(timer);
				resolve();
			};
		});
	}

	private async flush(): Promise<void> {
		const decoder = this.decoder;
		if (!decoder || decoder.state !== "configured") return;
		await decoder.flush();
	}

	/** Drops decoded frames and returns the decoder to a clean, unconfigured state. */
	private reset(): void {
		for (const frame of this.ready) {
			frame.close();
		}
		this.ready = [];
		this.onFrame = null;
		this.failure = null;

		const decoder = this.decoder;
		if (!decoder || decoder.state === "closed") return;
		try {
			decoder.reset();
		} catch {
			// Nothing to reset; the next `configure` will rebuild it.
		}
		// `reset` leaves the decoder unconfigured, so the next GOP reconfigures.
		this.configKey = null;
	}
}

/**
 * Opens a native sink for `ref`, or returns null when this clip has to go
 * through mediabunny instead — no shell, no file on disk yet, an unreadable
 * container, or a codec this browser's `VideoDecoder` will not take.
 *
 * The probe demuxes the first GOP, which is the only way to learn the codec
 * string; the shell caches it, so the first real seek does not pay for it twice.
 */
export async function openNativeVideoSink({
	ref,
}: {
	ref: MediaSourceRef;
}): Promise<NativeVideoSampleSink | null> {
	const mediaPath = nativeSourcePath({ ref });
	if (!mediaPath) return null;
	if (!tauriAvailable()) return null;
	if (typeof VideoDecoder === "undefined") return null;

	try {
		// Queued behind any demux of this file in flight, so the shell cannot
		// rewrite a GOP file that a read is part-way through.
		const probe = await inFileOrder({
			mediaPath,
			run: () => tauriDecodeVideoGop({ mediaPath, startSeconds: 0 }),
		});
		const support = await VideoDecoder.isConfigSupported(
			toDecoderConfig({ config: probe.config }),
		);
		if (!support.supported) return null;
		return new NativeVideoSampleSink({ mediaPath });
	} catch {
		return null;
	}
}
