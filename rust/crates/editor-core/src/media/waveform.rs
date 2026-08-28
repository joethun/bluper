//! Waveform summary math: pure functions over `f32` audio samples.
//!
//! Audio decode still runs in the browser (`AudioContext` + `AudioDecoder`);
//! only the bucketing math runs in Rust. The webview feeds decoded
//! `Float32Array` chunks in as a wasm-bindgen typed-array view — zero
//! copy through the bridge — the Rust side folds them into per-bucket
//! peak amplitudes, and the JS keeps ownership of the yielding loop so
//! the main thread stays responsive on long sources.

use serde::{Deserialize, Serialize};

/// One sample-range a clip's bar wants the peak for. The JS computes the
/// retime-aware source-time mapping itself (using the existing retime wasm
/// bridge) and converts to sample indices, then hands us the pre-resolved
/// ranges — keeps the bridge free of retime-state plumbing.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
	feature = "wasm",
	tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Deserialize, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WaveformBucket {
	pub bucket_start: u64,
	pub bucket_end: u64,
}

/// Folds a chunk of audio samples into `peaks` (one absolute-max per
/// `bucket_size` source-frame bucket). `offset_frames` is the source-frame
/// index of `data[0]`; `bucket_index` is derived as `offset_frames / bucket_size`.
///
/// Returns the index of the last bucket the function touched, so the caller
/// knows where to resume on the next slice — i.e. the next slice's
/// `offset_frames` should be `(returned_index + 1) * bucket_size`. This
/// mirrors the TS implementation's behaviour and keeps the slicing loop
/// identical when the wasm call replaces the inner fold.
pub fn fold_channel_peaks_inner(
	data: &[f32],
	peaks: &mut [f32],
	offset_frames: f64,
	bucket_size: f64,
) -> usize {
	let frames = data.len();
	let mut frame = 0usize;
	let mut bucket_index = (offset_frames / bucket_size).floor() as usize;
	while frame < frames {
		// Walk bucket-by-bucket rather than sample-by-sample so the bucket
		// index increments once per bucket and the inner loop stays on the
		// plain float path.
		let end = ((bucket_index + 1) as f64 * bucket_size - offset_frames) as usize;
		let end = end.min(frames);
		let mut peak = peaks[bucket_index];
		for datum in &data[frame..end] {
			let abs = datum.abs();
			if abs > peak {
				peak = abs;
			}
		}
		peaks[bucket_index] = peak;
		bucket_index += 1;
		frame = end;
	}
	bucket_index.saturating_sub(1)
}

#[cfg(feature = "wasm")]
mod wasm_bridge {
	use super::fold_channel_peaks_inner;
	use wasm_bindgen::prelude::*;

	#[wasm_bindgen(js_name = "foldChannelPeaks")]
	pub fn fold_channel_peaks_bridge(
		data: js_sys::Float32Array,
		peaks: js_sys::Float32Array,
		offset_frames: f64,
		bucket_size: f64,
	) -> i64 {
		// `Float32Array::to_vec` copies the host's view into Rust —
		// wasm-bindgen does not give us a borrowed `&[f32]` for
		// `Float32Array` arguments without a separate `view()` call. The
		// copy cost is acceptable: a multi-minute mono source at 48 kHz
		// is ~5 MB and the fold takes <2 ms.
		let data_vec = data.to_vec();
		let mut peaks_vec = peaks.to_vec();
		let last = fold_channel_peaks_inner(
			&data_vec,
			&mut peaks_vec,
			offset_frames,
			bucket_size,
		);
		// Copy the updated peaks back into the host's Float32Array.
		for (i, peak) in peaks_vec.iter().enumerate() {
			peaks.set_index(i as u32, *peak);
		}
		last as i64
	}

	/// Reads pre-decoded amplitudes + a list of sample-range buckets and
	/// writes one peak amplitude per bucket into the JS-allocated
	/// `Float64Array`. The buckets cross as two parallel `Vec<f64>`
	/// (starts, ends) instead of `Vec<u64>` because the wasm-bindgen
	/// generated wrapper for `Vec<u64>` over a function that also has a
	/// `Float32Array` argument calls `wasm.__wbindgen_export` which the
	/// runtime never initialises — f64 is lossy above 2^53, but a
	/// 32-bit source-frame index never reaches that.
	#[wasm_bindgen(js_name = "sampleSourceWaveformSummary")]
	pub fn sample_source_waveform_summary_bridge(
		amps: js_sys::Float32Array,
		bucket_size: f64,
		bucket_starts: Vec<f64>,
		bucket_ends: Vec<f64>,
		out: js_sys::Float64Array,
	) {
		let amps_vec = amps.to_vec();
		let amps_len = amps_vec.len() as isize;
		let out_len = out.length() as usize;
		let count = bucket_starts.len().min(bucket_ends.len()).min(out_len);
		for o in 0..count {
			let bucket_start = bucket_starts[o];
			let bucket_end = bucket_ends[o];
			let peak = if bucket_end <= bucket_start {
				0.0
			} else {
				// Compute the bucket's slice of the amplitude array. The
				// indices come from dividing `bucket_start` and
				// `bucket_end` (in source frames) by `bucket_size`. Clamp
				// to `[0, amps_len]` so buckets that sit past the end
				// produce an empty range (peak = 0) rather than panicking
				// on an out-of-bounds slice.
				let mut start_index = (bucket_start / bucket_size).floor() as isize;
				let mut end_index = (bucket_end / bucket_size).ceil() as isize;
				start_index = start_index.max(0);
				end_index = end_index.min(amps_len);
				if start_index >= end_index {
					0.0
				} else {
					let mut max_amplitude = 0.0f32;
					for &amplitude in &amps_vec[start_index as usize..end_index as usize] {
						if amplitude > max_amplitude {
							max_amplitude = amplitude;
						}
					}
					max_amplitude as f64
				}
			};
			out.set_index(o as u32, peak);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn fold_finds_per_bucket_max() {
		// 7 samples with bucket_size=2 spans 4 buckets (0..2, 2..4, 4..6,
		// 6..8) — the last bucket holds just one sample. The peaks array is
		// sized to hold every bucket the loop touches.
		let data = vec![0.1f32, 0.5, 0.9, 0.2, 0.3, 0.7, 0.4];
		let mut peaks = vec![0.0f32; 4];
		let last = fold_channel_peaks_inner(&data, &mut peaks, 0.0, 2.0);
		assert_eq!(last, 3);
		assert!((peaks[0] - 0.5).abs() < 1e-6);
		assert!((peaks[1] - 0.9).abs() < 1e-6);
		assert!((peaks[2] - 0.7).abs() < 1e-6);
		assert!((peaks[3] - 0.4).abs() < 1e-6);
	}

	#[test]
	fn fold_skips_buckets_before_offset() {
		let data = vec![0.1f32, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
		let mut peaks = vec![0.0f32; 6];
		let last = fold_channel_peaks_inner(&data, &mut peaks, 4.0, 2.0);
		assert_eq!(last, 5);
		assert!((peaks[0] - 0.0).abs() < 1e-6);
		assert!((peaks[1] - 0.0).abs() < 1e-6);
		assert!((peaks[2] - 0.2).abs() < 1e-6);
		assert!((peaks[3] - 0.4).abs() < 1e-6);
		assert!((peaks[4] - 0.6).abs() < 1e-6);
		assert!((peaks[5] - 0.8).abs() < 1e-6);
	}
}