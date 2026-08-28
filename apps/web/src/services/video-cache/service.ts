import type { VideoSample } from "@/media/video-sample";
import { tauriClearDecodeCache } from "@/lib/tauri-runtime";
import type { MediaSourceRef } from "@/media/source";
import { forgetCachedGops, openNativeVideoSink } from "./native-sink";

/**
 * Where a decoder's frames come from: the desktop shell's demuxer, which walks
 * the container in Rust and hands the encoded packets to a `VideoDecoder` in
 * the page. There used to be a second implementation behind this — mediabunny
 * reading the file itself — and the interface survives it because it is still
 * the right seam: nothing below this line needs to know how a frame was found.
 */
interface SampleSource {
	samples(startTime: number): AsyncGenerator<VideoSample, void, unknown>;
	/**
	 * One frame, decoded in the shell rather than by feeding a `VideoDecoder`
	 * from a keyframe. Optional because only the native sink can do it.
	 *
	 * The two exist because seeking and playing forwards are different work.
	 * `samples` opens a decoder at a keyframe and walks to the requested time,
	 * which on a source re-encoded with almost no keyframes means decoding a
	 * whole minute of video for one picture — measured at ~700ms, paid again on
	 * every pointer move of a scrub. This decodes across every core and returns
	 * only the frame: 89ms for a jump, 5ms while dragging. Per *sequential*
	 * frame the decoder in `samples` wins instead, at 0.71ms and no pixels over
	 * the IPC boundary, so playback moves back onto it once it is warm.
	 */
	frameAt?(time: number): Promise<VideoSample | null>;
	dispose(): void;
}

interface VideoSinkData {
	/** The asset this decoder reads, so it can be released with its media. */
	mediaId: string;
	source: SampleSource;
	/**
	 * This decoder is fed by the shell's demuxer rather than by mediabunny.
	 * Reported by {@link VideoCache.getStats} because the fallback is silent:
	 * without it, a native path that quietly stopped working would look exactly
	 * like one that was never reached.
	 */
	native: boolean;
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	currentFrame: VideoSample | null;
	nextFrame: VideoSample | null;
	lastTime: number;
	/**
	 * The time this decoder was last asked for, so the next request can tell
	 * which way the playhead is travelling. See {@link VideoCache.startPrefetch}.
	 */
	lastRequestedTime: number;
	/** False while the playhead is running backwards over this decoder. */
	movingForward: boolean;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
	/**
	 * A `samples` iterator being opened in the background.
	 *
	 * A seek is answered from {@link SampleSource.frameAt} and deliberately
	 * leaves no iterator behind, because a scrub only ever wants one frame per
	 * position and opening a decoder for it costs more than the frame. When the
	 * playhead then starts advancing — playback rather than scrubbing — an
	 * iterator is worth having, but opening one blocks on the keyframe catch-up.
	 * So it is opened off to one side while the frames still come from the
	 * shell, and taken up once it is ready.
	 */
	openingIterator: Promise<void> | null;
	/**
	 * Bumped by every seek. A background iterator open records this and throws
	 * its result away if it changed, because the playhead has since gone
	 * somewhere the iterator is not.
	 *
	 * It also keeps two `samples()` calls off one sink: the sink resets its
	 * decoder when a new iterator is asked for, so a background open and a seek
	 * both starting one would leave the first reading through a decoder the
	 * second had cleared.
	 */
	iteratorEpoch: number;
	/**
	 * The current iterator has run out of samples. Cleared by the next seek,
	 * which builds a fresh one — possibly at an earlier position where there is
	 * material again.
	 */
	reachedEnd: boolean;
	/**
	 * The render pass this decoder was last asked for a frame in. Drives
	 * eviction: a decoder no pass has wanted for a while is not on screen.
	 */
	lastFrame: number;
}

/**
 * How many decoders may stay open once the frame they were opened for has
 * passed. Each one holds a `VideoDecoder`, an open `Input` over the file, and
 * up to two decoded samples — at 4K a sample is ~12MB, so the ceiling here is
 * what keeps a long timeline from ending the session with an out-of-memory
 * kill. It is a target rather than a hard limit: a decoder asked for a frame
 * in the current pass is on screen and is never evicted, so a scene that
 * genuinely composites more videos than this still renders correctly.
 */
const MAX_IDLE_SINKS = 8;

/**
 * How many render passes a decoder may go unasked-for before it is closed.
 * Long enough that scrubbing back and forth across a cut does not pay to
 * reopen a decoder every time (~2s of playback), short enough that dragging
 * the playhead down a long timeline does not accumulate them.
 */
const IDLE_FRAMES_BEFORE_EVICTION = 120;

/**
 * Releases the sample and any GPU resources its underlying `VideoFrame` holds.
 * Mediabunny's `VideoSampleSink` reuses samples from an internal pool, but
 * once we stop holding a sample the GPU texture the WebCodecs `VideoFrame`
 * points at can be reclaimed. Without this call we'd leak a `VideoFrame`
 * per scrubbed frame.
 */
function closeSample(sample: VideoSample | null) {
	if (!sample) return;
	try {
		sample.close();
	} catch {
		// already closed
	}
}

class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	/**
	 * Assets being read through the shell's demuxer, by id. The shell keeps the
	 * GOPs it demuxed on disk, and it is keyed by path rather than by asset, so
	 * this is what lets {@link clearVideo} tell it which files to drop.
	 */
	private nativePaths = new Map<string, string>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	private frameCounter = 0;

	/**
	 * Opens a render pass. Nothing here decodes — it advances the clock that
	 * eviction reads and retires the decoders that the last few passes stopped
	 * asking for.
	 *
	 * Without this the map only ever grew: `clearVideo` fires when an asset is
	 * removed from the project and `clearAll` when the project closes, so every
	 * clip the playhead ever crossed left a decoder, an open file handle and its
	 * decoded samples behind for the rest of the session. On a timeline with a
	 * few hundred clips that is what ran the web process out of memory.
	 *
	 * Renders are serialised process-wide (see `runExclusively` in
	 * `canvas-renderer.ts`), so every `getSampleAt` for a pass lands after that
	 * pass has begun and no eviction can run mid-resolve.
	 */
	beginFrame(): void {
		this.frameCounter++;
		this.evictSinks();
	}

	private evictSinks(): void {
		// Eviction runs at the *start* of a pass, before anything has asked for a
		// frame in it, so "used this pass" is not yet a usable signal — judging by
		// it would make every decoder look idle and evict the ones this pass is
		// about to need. The previous pass is the evidence available: a decoder it
		// wanted is on screen, and dropping it would force an immediate and far
		// more expensive reopen. So a decoder is only a candidate once two
		// consecutive passes have gone without it.
		const isEvictable = (sinkData: VideoSinkData) =>
			this.frameCounter - sinkData.lastFrame > 1;

		for (const [sinkKey, sinkData] of [...this.sinks]) {
			if (!isEvictable(sinkData)) continue;
			if (
				this.frameCounter - sinkData.lastFrame >
				IDLE_FRAMES_BEFORE_EVICTION
			) {
				this.clearSink({ sinkKey });
			}
		}

		let overCap = this.sinks.size - MAX_IDLE_SINKS;
		if (overCap <= 0) return;

		const leastRecentlyUsed = [...this.sinks]
			.filter(([, sinkData]) => isEvictable(sinkData))
			.sort(([, a], [, b]) => a.lastFrame - b.lastFrame);

		for (const [sinkKey] of leastRecentlyUsed) {
			if (overCap <= 0) break;
			this.clearSink({ sinkKey });
			overCap--;
		}
	}

	/**
	 * A decoder holds one position, so two clips needing different times of the
	 * same file at the same moment cannot share it: the later request supersedes
	 * the earlier one, which then silently receives whatever frame is current.
	 * `sinkKey` lets such a clip ask for a decoder of its own. Everything else
	 * keeps sharing one per asset, which is what makes ordinary playback cheap.
	 */
	async getSampleAt({
		mediaId,
		sinkKey = mediaId,
		source,
		time,
	}: {
		mediaId: string;
		sinkKey?: string;
		source: MediaSourceRef;
		time: number;
	}): Promise<VideoSample | null> {
		await this.ensureSink({ sinkKey, mediaId, source });

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;
		sinkData.lastFrame = this.frameCounter;
		// Read here rather than in `resolveSample`, which runs behind the chain
		// below and would see the requests in the order they were serviced
		// rather than the order they arrived.
		sinkData.movingForward = time >= sinkData.lastRequestedTime;
		sinkData.lastRequestedTime = time;

		// Superseding is per decoder: a newer request on this one is a stale scrub
		// and can be dropped, but a request from another clip is a frame that is
		// still needed.
		const generation = (this.seekGenerations.get(sinkKey) ?? 0) + 1;
		this.seekGenerations.set(sinkKey, generation);

		const previous = this.frameChain.get(sinkKey) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(sinkKey) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveSample({ sinkData, time });
		});
		this.frameChain.set(
			sinkKey,
			current.catch(() => {}),
		);
		return current;
	}

	private async resolveSample({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<VideoSample | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			closeSample(sinkData.currentFrame);
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		const continuing =
			sinkData.currentFrame !== null &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0;

		if (sinkData.iterator && continuing) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}

			// The stream ran out before reaching the asked-for time. Re-seeking
			// would only exhaust a fresh iterator at the same place, once per
			// rendered frame, so hold what we have instead.
			if (sinkData.reachedEnd) {
				return sinkData.currentFrame;
			}
		}

		// Playing forwards from a position a seek reached, with no iterator yet.
		// The shell can answer this frame now, and the iterator that will serve
		// the ones after it is opened alongside rather than waited on — opening
		// it means decoding from the GOP's keyframe, which is the stall this
		// whole path exists to avoid.
		if (!sinkData.iterator && continuing && sinkData.source.frameAt) {
			const frame = await this.nativeFrameAt({ sinkData, time });
			if (frame) {
				this.openIteratorInBackground({ sinkData, time });
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return frame;
		}

		// Nothing decodable at this time. The usual cause is a request that lands
		// past the last sample: a clip's span comes from the container's declared
		// duration, which routinely runs a little beyond the final frame's
		// presentation end, so every clip asks for a frame or two that do not
		// exist as it plays out. Returning null drops the layer for those frames
		// and the clear colour shows through — a black flash at each cut. Holding
		// the last picture that did decode is what a player does, and it is what
		// the frame after it will replace.
		return sinkData.currentFrame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: VideoSample;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<VideoSample | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					closeSample(sinkData.currentFrame);
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) {
						sinkData.reachedEnd = true;
						break;
					}

					closeSample(sinkData.currentFrame);
					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<VideoSample | null> {
		try {
			// Anything already reading this sink has to finish before the decoder
			// underneath it is pointed somewhere else.
			sinkData.iteratorEpoch += 1;
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}
			if (sinkData.openingIterator) {
				await sinkData.openingIterator;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			closeSample(sinkData.nextFrame);
			sinkData.nextFrame = null;
			sinkData.reachedEnd = false;

			// The shell decodes the one frame this seek is for, and no iterator
			// is opened. That is the whole point: a scrub is a run of seeks, one
			// frame wanted at each, and opening a decoder at the GOP's keyframe
			// for each of them was ~700ms of decoding thrown away per pointer
			// move. If the playhead turns out to be *playing* rather than being
			// dragged, `resolveSample` opens the iterator then.
			if (sinkData.source.frameAt) {
				const frame = await this.nativeFrameAt({ sinkData, time });
				if (frame) return frame;
				// The shell could not decode there. Fall through: the iterator
				// scans, so it can still find a frame where a direct decode found
				// none.
			}

			sinkData.iterator = sinkData.source.samples(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				closeSample(sinkData.currentFrame);
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	/**
	 * Takes one frame from the shell and makes it the current one.
	 */
	private async nativeFrameAt({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<VideoSample | null> {
		if (!sinkData.source.frameAt) return null;
		try {
			const frame = await sinkData.source.frameAt(time);
			if (!frame) return null;
			closeSample(sinkData.currentFrame);
			sinkData.currentFrame = frame;
			// Tracked by the frame's own timestamp, not the time requested, so the
			// next request is measured against where the picture actually starts.
			sinkData.lastTime = frame.timestamp;
			return frame;
		} catch (error) {
			console.warn("Native frame decode failed:", error);
			return null;
		}
	}

	/**
	 * Opens a `samples` iterator at `time` without blocking the frame being
	 * served, so sustained playback moves back onto the webview's decoder.
	 *
	 * Only ever one at a time, and the result is discarded if a seek has
	 * happened in the meantime — the iterator would be positioned somewhere the
	 * playhead has already left.
	 */
	private openIteratorInBackground({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): void {
		if (sinkData.openingIterator || sinkData.iterator) return;

		const epoch = sinkData.iteratorEpoch;
		const opening = (async () => {
			const iterator = sinkData.source.samples(time);
			try {
				const { value: frame } = await iterator.next();
				if (!frame) {
					await iterator.return();
					return;
				}
				// A seek landed while this was opening, or an iterator arrived
				// another way: this one is at the wrong place now.
				if (sinkData.iteratorEpoch !== epoch || sinkData.iterator) {
					closeSample(frame);
					await iterator.return();
					return;
				}
				sinkData.iterator = iterator;
				// The frame it produced is the one *at* `time`, which has already
				// been shown from the shell's decode. Keeping it as `nextFrame`
				// would show it twice, so it is dropped and the iterator's next
				// frame is the one that follows.
				closeSample(frame);
			} catch (error) {
				console.warn("Opening a decoder in the background failed:", error);
				await iterator.return().catch(() => {});
			}
		})();

		sinkData.openingIterator = opening.finally(() => {
			sinkData.openingIterator = null;
		});
	}

	/**
	 * Decodes the frame after the current one, so ordinary playback never waits
	 * on the decoder.
	 *
	 * Skipped while the playhead is running backwards. An iterator only goes
	 * forwards, so during a backward scrub the frame this decodes is one the
	 * next request will discard — and the cost is not only the wasted decode:
	 * both `seekToTime` and `iterateToTime` have to await a prefetch in flight
	 * before they may touch the iterator, so every step of the drag waited for
	 * a frame it had already decided not to use.
	 */
	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}
		if (!sinkData.movingForward) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.reachedEnd = true;
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			closeSample(sinkData.nextFrame);
			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		sinkKey,
		mediaId,
		source,
	}: {
		sinkKey: string;
		mediaId: string;
		source: MediaSourceRef;
	}): Promise<void> {
		if (this.sinks.has(sinkKey)) return;

		if (this.initPromises.has(sinkKey)) {
			await this.initPromises.get(sinkKey);
			return;
		}

		const initPromise = this.initializeSink({ sinkKey, mediaId, source });
		this.initPromises.set(sinkKey, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(sinkKey);
		}
	}
	private async initializeSink({
		sinkKey,
		mediaId,
		source,
	}: {
		sinkKey: string;
		mediaId: string;
		source: MediaSourceRef;
	}): Promise<void> {
		// The shell's demuxer is the only one. It declines — rather than
		// throwing — for a file that is not on disk yet, which is a clip the
		// user dropped in a moment ago and the store has not finished writing.
		// That is worth saying plainly rather than falling back to a second
		// demuxer in the page: a fallback that reads media inside the process
		// is the memory ceiling this shell exists to remove.
		const native = await openNativeVideoSink({ ref: source });
		if (!native) {
			throw new Error(
				`This clip can't be decoded yet: ${mediaId} has no file on disk for the shell's demuxer to read.`,
			);
		}
		this.nativePaths.set(mediaId, native.mediaPath);

		this.sinks.set(sinkKey, {
			mediaId,
			source: native,
			native: true,
			iterator: null,
			currentFrame: null,
			nextFrame: null,
			lastTime: -1,
			lastRequestedTime: -1,
			movingForward: true,
			prefetching: false,
			prefetchPromise: null,
			openingIterator: null,
			iteratorEpoch: 0,
			reachedEnd: false,
			lastFrame: this.frameCounter,
		});
	}

	/**
	 * Releases every decoder reading this asset. A clip that needed its own
	 * position has a key of its own, so there can be more than one.
	 */
	clearVideo({ mediaId }: { mediaId: string }): void {
		const keys = [...this.sinks]
			.filter(([, sinkData]) => sinkData.mediaId === mediaId)
			.map(([sinkKey]) => sinkKey);

		for (const sinkKey of keys) {
			this.clearSink({ sinkKey });
		}

		// The asset's own key can hold pending state with no sink built yet.
		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);

		this.forgetGops({ mediaId });
		this.releaseNativeCache({ mediaId });
	}

	/**
	 * Drops the demuxed GOPs held for this asset. Paired with
	 * {@link releaseNativeCache}, which drops the shell's copy on disk: both are
	 * only worth doing when the asset itself is gone.
	 */
	private forgetGops({ mediaId }: { mediaId: string }): void {
		const mediaPath = this.nativePaths.get(mediaId);
		if (mediaPath) forgetCachedGops({ mediaPath });
	}

	/**
	 * Tells the shell to drop the GOP files it demuxed for this asset.
	 *
	 * Eviction deliberately doesn't do this: a decoder that goes idle is very
	 * likely to be wanted again, and rebuilding it from cached GOPs is the whole
	 * point of them being on disk. Only losing the asset outright — removed from
	 * the project, or the project closed — means the files can go.
	 */
	private releaseNativeCache({ mediaId }: { mediaId: string }): void {
		const mediaPath = this.nativePaths.get(mediaId);
		if (!mediaPath) return;
		this.nativePaths.delete(mediaId);
		void tauriClearDecodeCache({ mediaPath }).catch(() => {
			// A scratch directory that outlives its asset costs disk, not
			// correctness, and the next run's sweep will find it.
		});
	}

	private clearSink({ sinkKey }: { sinkKey: string }): void {
		const sinkData = this.sinks.get(sinkKey);
		if (sinkData) {
			// Returning the iterator first releases the underlying VideoDecoder.
			// Closing the samples before that would race the decoder's own
			// cleanup and surface as "Cannot call 'close' on a closed codec".
			if (sinkData.iterator) {
				const iterator = sinkData.iterator;
				sinkData.iterator = null;
				iterator.return().catch(() => {
					// Decoder already closed, or the iterator was never drained.
				});
			}

			closeSample(sinkData.currentFrame);
			closeSample(sinkData.nextFrame);
			sinkData.currentFrame = null;
			sinkData.nextFrame = null;

			sinkData.source.dispose();
			this.sinks.delete(sinkKey);
		}

		this.initPromises.delete(sinkKey);
		this.frameChain.delete(sinkKey);
		this.seekGenerations.delete(sinkKey);
	}

	clearAll(): void {
		for (const sinkKey of [...this.sinks.keys()]) {
			this.clearSink({ sinkKey });
		}
		for (const mediaId of [...this.nativePaths.keys()]) {
			this.forgetGops({ mediaId });
			this.releaseNativeCache({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			nativeSinks: Array.from(this.sinks.values()).filter((s) => s.native)
				.length,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter((s) => s.currentFrame)
				.length,
			maxIdleSinks: MAX_IDLE_SINKS,
			frameCounter: this.frameCounter,
		};
	}
}

export const videoCache = new VideoCache();
