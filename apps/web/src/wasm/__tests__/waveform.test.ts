/**
 * Parity test for the wasm waveform port. The Rust port must agree with the
 * pure-JS reference fold/sample over generated inputs. If a future port
 * changes the bucketing math, this test will fail loudly here rather than
 * producing subtly-wrong waveform previews.
 */

import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { foldChannelPeaks, sampleSourceWaveformSummary } = await import(
	"@/wasm/waveform"
);

/** Pure-JS reference for `foldChannelPeaks`. Must mirror the Rust port
 * exactly — same loop, same `offset_frames` semantics, same return value.
 * Lives here, not in the source module, because the source no longer
 * defines it (it lives in Rust).
 */
function foldChannelPeaksRef({
	data,
	peaks,
	offsetFrames,
	bucketSize,
}: {
	data: Float32Array;
	peaks: Float32Array;
	offsetFrames: number;
	bucketSize: number;
}): number {
	const frames = data.length;
	let frame = 0;
	let bucketIndex = Math.floor(offsetFrames / bucketSize);
	while (frame < frames) {
		const end = Math.min(
			frames,
			(bucketIndex + 1) * bucketSize - offsetFrames,
		);
		let peak = peaks[bucketIndex];
		for (; frame < end; frame++) {
			const abs = Math.abs(data[frame]);
			if (abs > peak) peak = abs;
		}
		peaks[bucketIndex] = peak;
		bucketIndex++;
	}
	return bucketIndex - 1;
}

test("foldChannelPeaks agrees with the JS reference for generated inputs", () => {
	const seeds = [1, 7, 42, 1234, 9999];
	for (const seed of seeds) {
		let s = seed;
		const rand = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return (s / 0x7fffffff) * 2 - 1;
		};
		const data = new Float32Array(256);
		for (let i = 0; i < data.length; i++) {
			data[i] = rand();
		}
		const offsetFrames = seed % 17;
		const bucketSize = 32;
		const buckets = 16;
		const peaksRust = new Float32Array(buckets);
		const peaksRef = new Float32Array(buckets);
		const lastRust = foldChannelPeaks({
			data,
			peaks: peaksRust,
			offsetFrames,
			bucketSize,
		});
		const lastRef = foldChannelPeaksRef({
			data,
			peaks: peaksRef,
			offsetFrames,
			bucketSize,
		});
		expect(lastRust).toBe(lastRef);
		expect(Array.from(peaksRust)).toEqual(Array.from(peaksRef));
	}
});

test("sampleSourceWaveformSummary returns max amplitude per bucket", () => {
	const amplitudes = Float32Array.from([0.1, 0.5, 0.9, 0.2, 0.3, 0.7, 0.4, 0.8]);
	const bucketSize = 1; // every sample is its own bucket
	const buckets = [
		{ bucketStart: 0, bucketEnd: 3 },
		{ bucketStart: 4, bucketEnd: 6 },
		{ bucketStart: 5, bucketEnd: 5 }, // empty bucket — must clamp to 0
	];
	const result = sampleSourceWaveformSummary({
		summary: { amplitudes, bucketSize },
		buckets,
	});
	expect(result.length).toBe(3);
	expect(result[0]).toBeCloseTo(0.9, 6);
	expect(result[1]).toBeCloseTo(0.7, 6);
	expect(result[2]).toBe(0);
});

test("sampleSourceWaveformSummary handles large u64 indices without drift", () => {
	// Source sample indices past 2^32 must round-trip correctly through
	// the BigInt-free packing the façade uses — `Math.floor(value / 2^32)`
	// and `value & 0xffffffff` are exact for any value below 2^53.
	const amplitudes = Float32Array.from([0.1, 0.5, 0.9]);
	const bucketSize = 1;
	const threeTwo = 0x100000000; // 2^32
	const result = sampleSourceWaveformSummary({
		summary: { amplitudes, bucketSize },
		buckets: [
			{ bucketStart: 0, bucketEnd: 1 },
			{ bucketStart: threeTwo, bucketEnd: threeTwo + 1 },
		],
	});
	expect(result.length).toBe(2);
	// Bucket 0 covers amps[0..1] = 0.1.
	expect(result[0]).toBeCloseTo(0.1, 6);
	// Bucket 1 sits past the array length (start = 2^32, amps.len = 3) —
	// the function returns 0 rather than reading off the end.
	expect(result[1]).toBe(0);
});