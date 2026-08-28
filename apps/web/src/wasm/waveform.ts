/**
 * Waveform summary math. The webview feeds decoded `Float32Array` chunks
 * in as wasm-bindgen typed-array views — zero copy through the bridge —
 * the Rust side folds them into per-bucket peak amplitudes, and the JS
 * keeps ownership of the yielding loop so the main thread stays
 * responsive on long sources.
 *
 * Owned by `editor-core::media::waveform`. The audio *decode* still runs
 * in the browser (`AudioContext` + `AudioDecoder`); only the bucketing
 * math moved to Rust.
 */

import {
	foldChannelPeaks as _foldChannelPeaks,
	sampleSourceWaveformSummary as _sampleSourceWaveformSummary,
} from "bluper-wasm";

/**
 * Folds a chunk of decoded audio samples into the caller's pre-allocated
 * `peaks` array. Mirrors the previous TS `foldChannelPeaks` signature so
 * the slicing loop in `waveform-summary.ts` doesn't have to change.
 *
 * The wasm-bindgen typed-array bridge accepts `Float32Array` directly
 * from JS, so no `{ptr, len}` dance — the cost is a copy through
 * `to_vec()` inside Rust (acceptable; a single sample window is rarely
 * more than a few hundred KB).
 */
export function foldChannelPeaks({
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
	// wasm-bindgen renders i64 returns as `bigint`. The TS callers use
	// this as an array index, so coerce to a regular number — values
	// here are bucket indices, well under 2^53.
	return Number(_foldChannelPeaks(data, peaks, offsetFrames, bucketSize));
}

/**
 * Returns one peak amplitude per source-sample range in `buckets`.
 *
 * Source amplitudes cross as a wasm-bindgen `Float32Array` (the typed-
 * array bridge accepts regular JS arrays — wasm-bindgen copies them
 * through `to_vec` on the wasm side). The buckets cross as two
 * parallel `Vec<f64>` (starts, ends) — `Vec<u64>` would have been
 * exact, but the wasm-bindgen generated wrapper for a `Vec<u64>`
 * argument in a function that also has a `Float32Array` parameter
 * calls `wasm.__wbindgen_export` which the runtime never initialises.
 * f64 is lossy above 2^53, but a 32-bit source-frame index never
 * reaches that, so f64 is exact for our domain.
 */
export function sampleSourceWaveformSummary({
	summary,
	buckets,
}: {
	summary: { amplitudes: Float32Array; bucketSize: number };
	buckets: { bucketStart: number; bucketEnd: number }[];
}): number[] {
	const starts = new Float64Array(buckets.length);
	const ends = new Float64Array(buckets.length);
	for (let i = 0; i < buckets.length; i++) {
		starts[i] = buckets[i].bucketStart;
		ends[i] = buckets[i].bucketEnd;
	}
	const out = new Float64Array(buckets.length);
	_sampleSourceWaveformSummary(
		summary.amplitudes,
		summary.bucketSize,
		starts,
		ends,
		out,
	);
	return Array.from(out);
}