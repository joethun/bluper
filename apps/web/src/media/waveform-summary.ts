"use client";

import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";

const DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE = 128;

// Buckets processed between yields. Sized so one slice stays in single-digit
// milliseconds even on slow machines, keeping the main thread responsive while
// summarising long sources.
const PEAK_BUCKETS_PER_SLICE = 4096;

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

	let bucketIndex = 0;
	while (bucketIndex < bucketCount) {
		const sliceEnd = Math.min(bucketCount, bucketIndex + PEAK_BUCKETS_PER_SLICE);

		for (; bucketIndex < sliceEnd; bucketIndex++) {
			const bucketStart = bucketIndex * safeBucketSize;
			const bucketEnd = Math.min(totalSamples, bucketStart + safeBucketSize);
			let peak = 0;

			for (let c = 0; c < channels; c++) {
				const data = channelData[c];
				// bucketEnd is clamped to the buffer length, so every read is in
				// range; an unguarded load keeps this on the fast float path.
				for (let j = bucketStart; j < bucketEnd; j++) {
					const abs = Math.abs(data[j]);
					if (abs > peak) {
						peak = abs;
					}
				}
			}

			amplitudes[bucketIndex] = peak;
		}

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
	return buckets.map(({ bucketStart, bucketEnd }) => {
		if (bucketEnd <= bucketStart) {
			return 0;
		}

		const startIndex = Math.max(
			0,
			Math.floor(bucketStart / summary.bucketSize),
		);
		const endIndex = Math.min(
			summary.amplitudes.length,
			Math.max(startIndex + 1, Math.ceil(bucketEnd / summary.bucketSize)),
		);

		let maxAmplitude = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const amplitude = summary.amplitudes[i] ?? 0;
			if (amplitude > maxAmplitude) {
				maxAmplitude = amplitude;
			}
		}

		return maxAmplitude;
	});
}


