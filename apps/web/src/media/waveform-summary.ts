"use client";

import { readNativeWaveform } from "@/media/native-audio";
import type { MediaSourceRef } from "@/media/source";
import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";
import {
	foldChannelPeaks,
	sampleSourceWaveformSummary as sampleSourceWaveformSummaryRust,
} from "@/wasm/waveform";

export const DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE = 128;

// Buckets processed between yields. Sized so one slice stays in single-digit
// milliseconds even on slow machines, keeping the main thread responsive while
// summarising long sources.
const PEAK_BUCKETS_PER_SLICE = 4096;

/**
 * Shortest gap between progress callbacks while a summary fills. Each one
 * repaints every clip drawn from the source, so this is a repaint budget
 * rather than a fidelity one — well under a second keeps the fill looking
 * continuous without spending the pass on canvas work.
 */
const PROGRESS_INTERVAL_MS = 150;

/**
 * How long folding may hold the main thread before handing it back. One frame
 * at 60Hz is 16ms, so half of that leaves room for the paint the yield exists
 * to allow.
 */

/**
 * Hands control back to the browser so a long summary pass cannot block input
 * or painting. `scheduler.yield` resumes at higher priority than a task posted
 * via setTimeout, so prefer it where available; MessageChannel is the fallback
 * because setTimeout is clamped to ~4ms per call, which would dominate the
 * total time once there are dozens of slices.
 */
function yieldToMainThread(): Promise<void> {
	const scheduler = (
		globalThis as {
			scheduler?: { yield?: () => Promise<void> };
		}
	).scheduler;

	if (typeof scheduler?.yield === "function") {
		return scheduler.yield();
	}

	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}

export interface SampleBucket {
	bucketStart: number;
	bucketEnd: number;
}

export interface SourceWaveformSummary {
	sourceKey: string;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	amplitudes: Float32Array;
	/**
	 * Bumped each time `amplitudes` gains material. A summary is handed out
	 * while it is still filling — an hour-long source takes seconds to read, and
	 * a waveform that draws as it arrives beats a blank clip that snaps into
	 * place at the end — so consumers that cache their paint need something to
	 * compare beyond the fields that are settled from the first chunk.
	 */
	revision: number;
}

export function buildWaveformSourceKey({
	kind,
	id,
}: {
	kind: "media" | "library";
	id: string;
}): string {
	return `${kind}:${id}`;
}

/**
 * Summarises a source without ever holding it.
 *
 * The output is one peak per {@link DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE}
 * samples — a 68-minute stereo recording reduces to about 1.4M floats, roughly
 * 5MB — so folding each chunk in as it arrives and letting it go costs a
 * thousandth of what decoding the track to an `AudioBuffer` first does. That
 * matters because the waveform is drawn from the timeline: a long clip being
 * on screen is enough to ask for one, and the buffered route allocated the
 * decoded track three times over to answer.
 *
 * Two decoders are tried, for the reason {@link decodeAudioBufferFromRef}
 * gives — neither covers everything the editor accepts — but both are walked a
 * window at a time here rather than materialised. Returns null only when
 * neither could read the source, which leaves the caller its own last resort.
 */
export async function buildSourceWaveformSummaryFromRef({
	sourceKey,
	ref,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
	onProgress,
}: {
	sourceKey: string;
	ref: MediaSourceRef;
	bucketSize?: number;
	/**
	 * Called as the summary fills, at most every
	 * {@link PROGRESS_INTERVAL_MS}. The `amplitudes` handed over is the live
	 * array rather than a copy — reading it is safe because folding only ever
	 * raises a bucket, and a bucket not reached yet is zero, which draws as
	 * silence until it isn't.
	 */
	onProgress?: (summary: SourceWaveformSummary) => void;
}): Promise<SourceWaveformSummary | null> {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	let nativeProgressAt = 0;
	let nativeRevision = 0;

	// The shell's decoder first where there is one. It folds the peaks in Rust,
	// so the samples never reach the page at all and none of the yielding below
	// is needed; it still reads a window at a time, so the wave fills as it goes
	// the same way. Declines rather than throwing when it cannot reach the
	// source, which is every source in the web build.
	const native = await readNativeWaveform({
		ref,
		bucketSize: safeBucketSize,
		onWindow: (progress) => {
			if (!onProgress) return;
			const now = performance.now();
			if (now - nativeProgressAt < PROGRESS_INTERVAL_MS) return;
			nativeProgressAt = now;
			nativeRevision += 1;
			onProgress({
				sourceKey,
				sampleRate: progress.sampleRate,
				totalSamples: progress.totalSamples,
				bucketSize: safeBucketSize,
				amplitudes: progress.amplitudes,
				revision: nativeRevision,
			});
		},
	});
	if (native) {
		const totalSamples = Math.max(1, native.totalSamples);
		const bucketCount = Math.max(
			native.highestBucket + 1,
			Math.ceil(totalSamples / safeBucketSize),
		);
		const trimmed =
			native.amplitudes.length === bucketCount
				? native.amplitudes
				: sizedTo({ amplitudes: native.amplitudes, bucketCount });
		return {
			sourceKey,
			sampleRate: native.sampleRate,
			totalSamples,
			bucketSize: safeBucketSize,
			amplitudes: trimmed,
			revision: nativeRevision + 1,
		};
	}
	// There is no route below the native one. Summarising in the page meant
	// pulling every packet through WebCodecs and folding the peaks in
	// JavaScript, which is the memory and time cost the shell exists to
	// remove — 10.6s against 1.3s on a 68-minute track, measured in WebKitGTK.
	// A source the shell cannot reach has no waveform yet rather than a slow
	// one: it is an asset the store has not finished writing, and the next
	// call gets it.
	return null;
}

/** Grows or trims an amplitude array to exactly `bucketCount` buckets. */
function sizedTo({
	amplitudes,
	bucketCount,
}: {
	amplitudes: Float32Array;
	bucketCount: number;
}): Float32Array {
	if (amplitudes.length > bucketCount) return amplitudes.slice(0, bucketCount);
	const grown = new Float32Array(bucketCount);
	grown.set(amplitudes);
	return grown;
}

export async function buildSourceWaveformSummary({
	sourceKey,
	buffer,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
	bucketSize?: number;
}): Promise<SourceWaveformSummary> {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const totalSamples = buffer.length;
	const bucketCount = Math.max(1, Math.ceil(totalSamples / safeBucketSize));
	const channels = buffer.numberOfChannels;

	const channelData: Float32Array[] = new Array(channels);
	for (let c = 0; c < channels; c++) {
		channelData[c] = buffer.getChannelData(c);
	}

	// Peaks are written straight into the output buffer: deriving each bucket's
	// sample range from its index avoids materialising one descriptor object per
	// bucket (hundreds of thousands for a long source) and skips the boxed
	// number[] that previously had to be copied into a Float32Array afterwards.
	const amplitudes = new Float32Array(bucketCount);

	// Sliced so the main thread gets a turn between slices, and each slice folded
	// by `foldChannelPeaks` rather than inline — see its note on why a hot loop
	// cannot live in an async function body here.
	let bucketIndex = 0;
	while (bucketIndex < bucketCount) {
		const sliceEnd = Math.min(bucketCount, bucketIndex + PEAK_BUCKETS_PER_SLICE);
		const sliceStartFrame = bucketIndex * safeBucketSize;
		const sliceEndFrame = Math.min(totalSamples, sliceEnd * safeBucketSize);

		for (let c = 0; c < channels; c++) {
			foldChannelPeaks({
				data: channelData[c].subarray(sliceStartFrame, sliceEndFrame),
				peaks: amplitudes,
				offsetFrames: sliceStartFrame,
				bucketSize: safeBucketSize,
			});
		}

		bucketIndex = sliceEnd;
		if (bucketIndex < bucketCount) {
			await yieldToMainThread();
		}
	}

	return {
		sourceKey,
		sampleRate: buffer.sampleRate,
		totalSamples,
		bucketSize: safeBucketSize,
		amplitudes,
		// Built in one pass from a buffer that was already whole, so there was
		// never a partial version of it to tell apart.
		revision: 1,
	};
}

export function buildWaveformSampleBuckets({
	clipLeftPx,
	clipRightPx,
	barCount,
	pixelsPerSecond,
	clipDurationSec,
	sourceStartSec,
	retime,
	sampleRate,
	maxSampleExclusive,
	barStepPx,
}: {
	clipLeftPx: number;
	clipRightPx: number;
	barCount: number;
	pixelsPerSecond: number;
	clipDurationSec: number;
	sourceStartSec: number;
	retime?: RetimeConfig;
	sampleRate: number;
	maxSampleExclusive: number;
	barStepPx: number;
}): SampleBucket[] {
	return Array.from({ length: barCount }, (_, index) => {
		const bucketLeftPx = clipLeftPx + index * barStepPx;
		const bucketRightPx = Math.min(clipRightPx, bucketLeftPx + barStepPx);
		const clipStartSec = Math.max(
			0,
			Math.min(clipDurationSec, bucketLeftPx / pixelsPerSecond),
		);
		const clipEndSec = Math.max(
			clipStartSec,
			Math.min(clipDurationSec, bucketRightPx / pixelsPerSecond),
		);
		const sourceBucketStartSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipStartSec,
				clipDuration: clipDurationSec,
				retime,
			});
		const sourceBucketEndSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipEndSec,
				clipDuration: clipDurationSec,
				retime,
			});

		return {
			bucketStart: Math.max(0, Math.floor(sourceBucketStartSec * sampleRate)),
			bucketEnd: Math.min(
				maxSampleExclusive,
				Math.max(0, Math.ceil(sourceBucketEndSec * sampleRate)),
			),
		};
	});
}

export function sampleSourceWaveformSummary({
	summary,
	buckets,
}: {
	summary: SourceWaveformSummary;
	buckets: SampleBucket[];
}): number[] {
	return sampleSourceWaveformSummaryRust({ summary, buckets });
}


