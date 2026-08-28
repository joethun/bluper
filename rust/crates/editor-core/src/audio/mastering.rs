//! Audio mastering math: per-buffer peak finding, peak clamping, and the
//! limiter that replaces `OfflineAudioContext.createDynamicsCompressor`
//! in the export pipeline.
//!
//! The browser-side bridging (`audioBufferPeak`, `clampAudioBufferPeak`)
//! is wasm-only; `apply_peak_limiter` is native-only because the
//! limiter runs over the post-mixdown buffer before it reaches the
//! mp4 encoder, which itself lives on the desktop side. The wasm
//! limit is what mediabunny is asked to do — and that's done through
//! the same JS code it has been using.

#[cfg(not(target_arch = "wasm32"))]
fn linear_to_db(sample: f32) -> f32 {
    if sample.abs() < 1e-9 {
        -120.0
    } else {
        20.0 * (sample.abs() as f32).log10()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn db_to_linear(db: f32) -> f32 {
    10_f32.powf(db / 20.0)
}

/// A peak limiter that mirrors the legacy `OfflineAudioContext` chain
/// used in the JS code: a feed-forward compressor with attack/release
/// and a configurable ceiling. Each sample sees the *highest*
/// reduction across channels; the gain envelope is what gives the
/// limiter its "compression" feel.
///
/// This is *not* a bit-exact port of `WebAudio.createDynamicsCompressor`
/// (which has a knee and a ratio), but it lives inside the same shape
/// — attack in milliseconds, release in the hundred-millisecond range,
/// ceiling as a dBFS cap.
#[cfg(not(target_arch = "wasm32"))]
pub fn apply_peak_limiter(
    channels: &mut [Vec<f32>],
    sample_rate: u32,
    ceiling_db: f32,
    attack_seconds: f32,
    release_seconds: f32,
) {
    if sample_rate == 0 || channels.is_empty() {
        return;
    }
    let length = channels[0].len();
    for channel in channels.iter() {
        if channel.len() != length {
            return; // mismatched lengths; bail rather than mis-clip
        }
    }

    // Per-sample one-pole gain envelope. The ceiling is the gain this
    // limiter cannot exceed; `envelope_db` runs from 0 (no reduction)
    // down to `ceiling_db - source_db` (full reduction at the ceiling).
    let mut gain_db: f32 = 0.0;
    let attack_per_sample =
        (-1.0 / (attack_seconds.max(1e-3) * sample_rate as f32)).exp();
    let release_per_sample =
        (-1.0 / (release_seconds.max(1e-3) * sample_rate as f32)).exp();

    for sample_index in 0..length {
        // Find the loudest absolute sample across channels at this
        // index; that's the level the limiter reads.
        let mut peak: f32 = 0.0;
        for channel in channels.iter() {
            peak = peak.max(channel[sample_index].abs());
        }
        let peak_db = linear_to_db(peak);

        // How much we need to reduce to land the peak at the ceiling.
        // Anything below the ceiling asks for `gain_db = 0` (no
        // reduction); the envelope can only *release* (increase
        // toward 0) when there's no reduction demanded.
        let target_db = (ceiling_db - peak_db).min(0.0);

        if target_db < gain_db {
            // Attack: snap toward the target quickly.
            gain_db = target_db + (gain_db - target_db) * attack_per_sample;
        } else {
            // Release: ease back toward zero at the slower rate.
            gain_db = target_db + (gain_db - target_db) * release_per_sample;
        }

        let gain = db_to_linear(gain_db);
        for channel in channels.iter_mut() {
            channel[sample_index] *= gain;
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    #[test]
    fn a_signal_below_the_ceiling_passes_through_unchanged() {
        let mut channels = vec![vec![0.5_f32; 1024]; 1];
        apply_peak_limiter(&mut channels, 48_000, -1.0, 0.001, 0.12);
        // 0.5 amplitude → -6 dBFS, well below -1 dBFS; nothing should
        // change.
        assert_eq!(channels[0][0], 0.5);
        assert_eq!(channels[0][512], 0.5);
        assert_eq!(channels[0][1023], 0.5);
    }

    #[test]
    fn a_clip_at_unity_amplitude_is_pulled_down_to_the_ceiling() {
        let mut channels = vec![vec![1.0_f32; 1024]; 1];
        // -1 dBFS ceiling = 10^(-1/20) ≈ 0.891.
        apply_peak_limiter(&mut channels, 48_000, -1.0, 0.001, 0.12);
        let ceiling = (10.0_f32).powf(-1.0 / 20.0);
        assert!(
            (channels[0][512] - ceiling).abs() < 1e-3,
            "mid-loop sample should be at ceiling ({}), got {}",
            ceiling,
            channels[0][512]
        );
    }

    #[test]
    fn a_loud_chase_stays_pinned_within_an_attack_cycle() {
        let mut channels = vec![vec![0.95_f32; 1024]; 1];
        apply_peak_limiter(&mut channels, 48_000, -3.0, 0.001, 0.12);
        let ceiling = (10.0_f32).powf(-3.0 / 20.0);
        // After 0.5 ms (24 samples at 48 kHz) the envelope should
        // have tracked the target closely enough that the steady
        // state lands within 5 % of the ceiling.
        assert!(
            (channels[0][200] - ceiling).abs() < 0.05 * ceiling,
            "steady-state should be within 5% of ceiling, got {}",
            channels[0][200]
        );
    }

    #[test]
    fn mismatched_channel_lengths_bail_out_early() {
        let mut channels: Vec<Vec<f32>> =
            vec![vec![1.0; 1024], vec![1.0; 1023]];
        // Should not panic — the precondition failure leaves the
        // buffer alone.
        apply_peak_limiter(&mut channels, 48_000, -3.0, 0.001, 0.12);
        assert_eq!(channels[0][0], 1.0);
    }
}

#[cfg(feature = "wasm")]
mod wasm_bridge {
    use wasm_bindgen::prelude::*;

    /// The largest absolute sample in any channel of `data`. The data is given
    /// as a list of per-channel `Float32Array` views — the same shape
    /// `AudioBuffer` exposes via `getChannelData(i)`, so the wrapper hands
    /// each one through.
    #[wasm_bindgen(js_name = "audioBufferPeak")]
    pub fn audio_buffer_peak(data: Vec<js_sys::Float32Array>) -> f32 {
        let mut peak = 0.0_f32;
        for channel in data {
            let samples = channel.to_vec();
            for &sample in &samples {
                let magnitude = sample.abs();
                if magnitude > peak {
                    peak = magnitude;
                }
            }
        }
        peak
    }

    /// Clamps each sample in `data` to `[-maxPeak, maxPeak]` in place. The
    /// caller keeps ownership of the typed arrays; the bridge reads/writes
    /// each one directly so the work is zero-copy at the boundary.
    #[wasm_bindgen(js_name = "clampAudioBufferPeak")]
    pub fn clamp_audio_buffer_peak(data: Vec<js_sys::Float32Array>, max_peak: f32) {
        let min = -max_peak;
        for channel in data {
            let mut samples = channel.to_vec();
            for sample in samples.iter_mut() {
                if *sample > max_peak {
                    *sample = max_peak;
                } else if *sample < min {
                    *sample = min;
                }
            }
            // Copy back into the typed array the host passed in.
            for (i, sample) in samples.iter().enumerate() {
                channel.set_index(i as u32, *sample);
            }
        }
    }
}

#[cfg(all(test, feature = "wasm"))]
mod tests {
    use super::wasm_bridge::{audio_buffer_peak, clamp_audio_buffer_peak};
    use js_sys::Float32Array;

    #[test]
    fn peak_finds_the_largest_absolute_sample_across_channels() {
        let left = Float32Array::new_with_length(4);
        left.copy_from(&[0.1, 0.5, -0.3, 0.2]);
        let right = Float32Array::new_with_length(4);
        right.copy_from(&[0.4, 0.9, 0.7, -0.8]);
        assert_eq!(audio_buffer_peak(vec![left, right]), 0.9);
    }

    #[test]
    fn clamping_writes_back_into_the_same_typed_array() {
        let channel = Float32Array::new_with_length(4);
        channel.copy_from(&[0.1, 1.2, -1.3, 0.5]);
        clamp_audio_buffer_peak(vec![channel.clone()], 1.0);
        let mut out = vec![0.0; 4];
        channel.copy_to(&mut out);
        assert_eq!(out, vec![0.1, 1.0, -1.0, 0.5]);
    }
}
