import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	type VideoSample,
} from "mediabunny";

interface VideoSinkData {
	/** The asset this decoder reads, so it can be released with its media. */
	mediaId: string;
	input: Input;
	sink: VideoSampleSink;
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	currentFrame: VideoSample | null;
	nextFrame: VideoSample | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

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
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();

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
		file,
		time,
	}: {
		mediaId: string;
		sinkKey?: string;
		file: File;
		time: number;
	}): Promise<VideoSample | null> {
		await this.ensureSink({ sinkKey, mediaId, file });

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;

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

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
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

					if (done || !frame) break;

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
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			closeSample(sinkData.nextFrame);
			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.samples(time);
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

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
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
		file,
	}: {
		sinkKey: string;
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(sinkKey)) return;

		if (this.initPromises.has(sinkKey)) {
			await this.initPromises.get(sinkKey);
			return;
		}

		const initPromise = this.initializeSink({ sinkKey, mediaId, file });
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
		file,
	}: {
		sinkKey: string;
		mediaId: string;
		file: File;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sink = new VideoSampleSink(videoTrack, {
				optimizeForLatency: true,
			});

			this.sinks.set(sinkKey, {
				mediaId,
				input,
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
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

			sinkData.input.dispose();
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
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
