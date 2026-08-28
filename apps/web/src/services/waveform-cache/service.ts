"use client";

import {
	DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
	buildSourceWaveformSummary,
	buildSourceWaveformSummaryFromRef,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import { decodeAudioBufferFromRef } from "@/media/decode-audio";
import type { MediaSourceRef } from "@/media/source";
import {
	forgetStoredWaveform,
	loadStoredWaveform,
	storeWaveform,
} from "@/services/waveform-store/service";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

/**
 * Decode a source to summarise it. Shared with playback and export so a file
 * that one of them can read is never silently missing its waveform — see
 * {@link decodeAudioBufferFromRef} for why reading it can take two attempts.
 */
async function decodeAudioBuffer({
	sourceFile,
	audioUrl,
}: {
	sourceFile?: File;
	audioUrl?: string;
}): Promise<AudioBuffer> {
	const buffer = await decodeAudioBufferFromRef({
		ref: sourceFile
			? { kind: "blob", blob: sourceFile }
			: { kind: "url", url: audioUrl ?? "" },
	});

	if (!buffer) {
		throw new Error("Could not decode audio source");
	}

	return buffer;
}

type ProgressListener = (summary: SourceWaveformSummary) => void;

class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();

	/**
	 * Who wants to hear about a source as it fills, and the most recent partial
	 * for each one.
	 *
	 * Kept here rather than passed into the build because the build is shared:
	 * every clip cut from the same source waits on one summary, and each of them
	 * has its own canvas to fill in. A clip mounted halfway through gets the
	 * partial immediately so it draws what is already known instead of staying
	 * blank until the end.
	 */
	private listeners = new Map<string, Set<ProgressListener>>();
	private partials = new Map<string, SourceWaveformSummary>();

	/**
	 * Asks to be told as `sourceKey` fills. Returns the unsubscribe.
	 *
	 * The listener fires with whatever has been read so far, then on each
	 * further slice. It is not called with the finished summary — the promise
	 * from {@link getSourceSummary} carries that.
	 */
	subscribeToProgress({
		sourceKey,
		listener,
	}: {
		sourceKey: string;
		listener: ProgressListener;
	}): () => void {
		let listeners = this.listeners.get(sourceKey);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(sourceKey, listeners);
		}
		listeners.add(listener);

		const partial = this.partials.get(sourceKey);
		if (partial) listener(partial);

		return () => {
			const current = this.listeners.get(sourceKey);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(sourceKey);
		};
	}

	private emitProgress({
		sourceKey,
		summary,
	}: {
		sourceKey: string;
		summary: SourceWaveformSummary;
	}): void {
		this.partials.set(sourceKey, summary);
		const listeners = this.listeners.get(sourceKey);
		if (!listeners) return;
		for (const listener of listeners) {
			listener(summary);
		}
	}

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildSummary({
			sourceKey,
			audioBuffer,
			sourceFile,
			audioUrl,
		})
			.finally(() => {
				this.partials.delete(sourceKey);
			})
			.catch((error) => {
				this.summaries.delete(sourceKey);
				throw error;
			});

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
		this.partials.delete(sourceKey);
		// The source itself is going away, so its stored peaks go too. Only this
		// path forgets them: `clearAll` runs when a project closes, which is
		// exactly when keeping them is the point.
		void forgetStoredWaveform({ sourceKey });
	}

	clearAll(): void {
		this.summaries.clear();
		this.partials.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		if (!sourceFile && !audioUrl) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		// Read back before reading the source. A summary is a pure function of
		// bytes that never change — media is stored under an id minted at import
		// — so the only question is whether one was kept, and reopening a project
		// should not spend seconds re-deriving what it derived last time.
		const stored = await loadStoredWaveform({
			sourceKey,
			bucketSize: DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
		});
		if (stored) return stored;

		const ref: MediaSourceRef = sourceFile
			? { kind: "blob", blob: sourceFile }
			: { kind: "url", url: audioUrl ?? "" };

		// Streamed first, because a summary is a reduction and never needed the
		// track in memory: decoding one to an `AudioBuffer` costs
		// `duration * rate * channels * 4` bytes three times over, which for an
		// hour-long recording is several gigabytes and stalls the editor for as
		// long as it takes to allocate and copy them. Only what the stream cannot
		// read falls through to that.
		const streamed = await buildSourceWaveformSummaryFromRef({
			sourceKey,
			ref,
			onProgress: (summary) => this.emitProgress({ sourceKey, summary }),
		});
		if (streamed) {
			// Not awaited: the summary is ready and the timeline wants it now.
			void storeWaveform({ summary: streamed });
			return streamed;
		}

		const buffer = await decodeAudioBuffer({ sourceFile, audioUrl });
		const summary = await buildSourceWaveformSummary({ sourceKey, buffer });
		void storeWaveform({ summary });
		return summary;
	}
}

export const waveformCache = new WaveformCache();
