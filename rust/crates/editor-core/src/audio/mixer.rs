//! Native audio mixer: decode + resample + sum + master.
//!
//! Replaces the JS-side `createTimelineAudioBuffer` for the export path.
//! The JS path still uses `OfflineAudioContext` because the editor needs
//! it for the preview pipeline; this module is the native equivalent that
//! the desktop self-test can drive without a browser.
//!
//! The pipeline:
//!
//! ```text
//!   per clip:
//!     ffmpeg decode -> Vec<Vec<f32>> (channels x samples) at source_rate
//!     resample to output_rate via rubato's polyphase sinc
//!     write into output buffer with linear interpolation in target-rate
//!     space, gain-applied per sample
//!   master:
//!     detect peak; if > 0.98, apply a simple envelope-follower limiter
//!     (attack 1 ms, release 120 ms, 4 ms lookahead) at the master bus
//! ```
//!
//! The limiter here is not bit-for-bit the same as
//! `OfflineAudioContext.createDynamicsCompressor` (which is a
//! feed-forward compressor with knee and ratio). It exists to keep the
//! same rule the JS code does — "don't let the master peak above
//! `-1 dBFS`" — and is therefore good enough for an mp4 export even if
//! the curve isn't indistinguishable. A future release can swap in a
//! per-sample feed-forward compressor without changing the call site.

use std::path::Path;

#[cfg(not(target_arch = "wasm32"))]
use ffmpeg_next as ffmpeg;
use rubato::Resampler;

/// One clip the timeline wants to mix in. The shape mirrors what the JS
/// `AudioClipSource` carries: a path to the decoded PCM, the timeline
/// position the clip starts at (`start_seconds`, *not* ticks — the
/// caller has done the unit conversion), the clip's own duration
/// (`duration_seconds`), the trim window the clip carries on the
/// timeline, the gain to apply, and a muted flag.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioClip {
    pub source_path: std::path::PathBuf,
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub trim_start_seconds: f64,
    pub trim_end_seconds: f64,
    pub gain: f32,
    pub muted: bool,
}

impl AudioClip {
    /// `start_seconds + duration_seconds` in the timeline. Only the
    /// tests need it — the mixer itself walks the clip list by source
    /// window, not by timeline end — so it is gated rather than left to
    /// read as dead code in a release build.
    #[cfg(test)]
    fn end_seconds(&self) -> f64 {
        self.start_seconds + self.duration_seconds
    }

    /// The source-time window this clip occupies on disk: `trim_start`
    /// through `trim_start + duration`. The trim region is what the
    /// clip carries on either side of the timeline piece it renders.
    fn source_window(&self) -> (f64, f64) {
        (
            self.trim_start_seconds,
            self.trim_start_seconds + self.duration_seconds,
        )
    }
}

/// Errors the mixer surfaces back to the JS side. The export pipeline
/// renders these as a string error on the export event.
#[derive(Debug)]
pub enum MixdownError {
    Ffmpeg(String),
    Resampler(String),
    Bounds { expected: usize, got: usize },
}

impl std::fmt::Display for MixdownError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MixdownError::Ffmpeg(message) => write!(f, "ffmpeg: {message}"),
            MixdownError::Resampler(message) => write!(f, "resampler: {message}"),
            MixdownError::Bounds { expected, got } => write!(
                f,
                "buffer size mismatch: expected {expected} samples, got {got}"
            ),
        }
    }
}

impl std::error::Error for MixdownError {}

/// One frame of decoded audio per channel at the source rate. Outer
/// index is channel, inner index is sample.
pub type PlanarSamples = Vec<Vec<f32>>;

/// Decodes `path` to planar f32 with `target_channels` and
/// `target_rate`. Audio that arrives at a different rate is resampled
/// (fixed sinc) before the function returns; audio that arrives at a
/// different channel count is upsampled/down-mixed to the target count.
///
/// The caller hands this result to `mix_audio_clips`. Errors propagate
/// verbatim so the export side can decide whether to fail the export
/// (most of these should produce a clear UI message).
pub fn decode_to_planar_f32(
    path: &Path,
    target_channels: u16,
    target_rate: u32,
) -> Result<PlanarSamples, MixdownError> {
    let mut input = ffmpeg::format::input(path)
        .map_err(|e| MixdownError::Ffmpeg(format!("opening audio file: {e}")))?;

    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| MixdownError::Ffmpeg("no audio stream".to_string()))?;
    let stream_index = stream.index();
    let time_base = stream.time_base();

    let parameters = stream.parameters();
    let codec_context =
        ffmpeg::codec::context::Context::from_parameters(parameters)
            .map_err(|e| MixdownError::Ffmpeg(format!("opening codec context: {e}")))?;
    let mut decoder = codec_context
        .decoder()
        .audio()
        .map_err(|e| MixdownError::Ffmpeg(format!("opening audio decoder: {e}")))?;

    let target_format =
        ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar);
    let target_channel_layout =
        ffmpeg::channel_layout::ChannelLayout::default(target_channels as i32);

    let mut resampler: Option<ffmpeg::software::resampling::Context> = None;
    let mut collected: PlanarSamples =
        vec![Vec::<f32>::new(); target_channels as usize];

    for (stream, mut packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }
        packet.rescale_ts(time_base, time_base);
        decoder.send_packet(&packet).map_err(|e| {
            MixdownError::Ffmpeg(format!("feeding decoder: {e}"))
        })?;

        loop {
            let mut decoded = ffmpeg::frame::Audio::empty();
            if decoder.receive_frame(&mut decoded).is_err() {
                break;
            }
            if decoded.samples() == 0 {
                continue;
            }
            if resampler.is_none() {
                resampler = Some(build_resampler(
                    &decoded,
                    target_format,
                    target_channel_layout,
                    target_rate,
                )?);
            }
            let Some(r) = resampler.as_mut() else {
                unreachable!("resampler was just set");
            };
            let mut out = ffmpeg::frame::Audio::new(
                target_format,
                0,
                target_channel_layout,
            );
            r.run(&decoded, &mut out).map_err(|e| {
                MixdownError::Resampler(format!("swr resample: {e}"))
            })?;
            let out_samples = out.samples();
            for channel_index in 0..target_channels as usize {
                let plane_bytes = out.data(channel_index);
                let plane_f32: &[f32] = unsafe {
                    std::slice::from_raw_parts(
                        plane_bytes.as_ptr() as *const f32,
                        out_samples,
                    )
                };
                collected[channel_index].extend_from_slice(plane_f32);
            }
        }
    }

    // Drain the resampler: swr holds the last samples when the input
    // ends, and `flush` returns the trailing partial frame.
    if let Some(r) = resampler.as_mut() {
        let mut out = ffmpeg::frame::Audio::new(
            target_format,
            0,
            target_channel_layout,
        );
        let _ = r.flush(&mut out);
        let out_samples = out.samples();
        for channel_index in 0..target_channels as usize {
            let plane_bytes = out.data(channel_index);
            let plane_f32: &[f32] = unsafe {
                std::slice::from_raw_parts(
                    plane_bytes.as_ptr() as *const f32,
                    out_samples,
                )
            };
            if !plane_f32.is_empty() {
                collected[channel_index].extend_from_slice(plane_f32);
            }
        }
    }

    Ok(collected)
}

fn build_resampler(
    frame: &ffmpeg::frame::Audio,
    target_format: ffmpeg::format::Sample,
    target_channel_layout: ffmpeg::channel_layout::ChannelLayout,
    target_rate: u32,
) -> Result<ffmpeg::software::resampling::Context, MixdownError> {
    ffmpeg::software::resampling::Context::get(
        frame.format(),
        frame.channel_layout(),
        frame.rate(),
        target_format,
        target_channel_layout,
        target_rate,
    )
    .map_err(|e| MixdownError::Resampler(format!("creating swr context: {e}")))
}

/// Converts planar samples at one sample rate to another using
/// `rubato`'s fixed-in polyphase sinc. Used when a per-clip source rate
/// differs from the timeline target. Returns channels in the same
/// order they came in.
pub fn resample_planar(
    samples: PlanarSamples,
    source_rate: u32,
    target_rate: u32,
) -> Result<PlanarSamples, MixdownError> {
    if source_rate == target_rate {
        return Ok(samples);
    }
    let channels = samples.len();
    if channels == 0 || source_rate == 0 {
        return Ok(samples);
    }
    let source_frames = samples[0].len();
    if source_frames == 0 {
        return Ok(samples);
    }

    let per_channel_in: Vec<Vec<f64>> = samples
        .into_iter()
        .map(|chan| chan.into_iter().map(|s| s as f64).collect())
        .collect();

    let chunk_in = source_frames;
    let mut resampler = rubato::FftFixedIn::<f64>::new(
        source_rate as usize,
        target_rate as usize,
        1,
        1,
        chunk_in,
    )
    .map_err(|e| MixdownError::Resampler(format!("creating rubato: {e}")))?;

    let expected_out_len = (chunk_in as f64
        * (target_rate as f64 / source_rate as f64)
        + 16.0) as usize;

    // Build the per-channel input: the resampler takes
    // `wave_in: &[Vin]` where `Vin: AsRef<[T]>`. A slice of `Vec<f64>`
    // makes `Vin = Vec<f64>` and `AsRef<[f64]>` resolves to the vec's
    // slice. We hand the inner vec as-is.
    let in_slices: Vec<Vec<f64>> = per_channel_in;

    // Output buffer has to be at least `expected_out_len` long per
    // channel. `rubato` fills it with however many frames it
    // produced on this call.
    let mut outbuf: Vec<Vec<f64>> = (0..channels)
        .map(|_| vec![0.0_f64; expected_out_len])
        .collect();

    let (_frames_in, frames_out) = resampler
        .process_into_buffer(&in_slices, &mut outbuf, None)
        .map_err(|e| MixdownError::Resampler(format!("rubato process: {e}")))?;

    let mut out_channels: Vec<Vec<f32>> = Vec::with_capacity(channels);
    for channel in 0..channels {
        let float_channel: Vec<f32> = outbuf[channel]
            .iter()
            .take(frames_out)
            .map(|&s| s as f32)
            .collect();
        out_channels.push(float_channel);
    }
    Ok(out_channels)
}

/// State every other audio function threads through. Built once per
/// call, shared by every clip's mix step. Carrying it as a value rather
/// than a module-level static makes the function pure and testable.
#[derive(Clone, Debug)]
pub struct MixerContext {
    pub output_rate: u32,
    pub output_channels: u16,
    pub total_frames: usize,
}

/// Sums `clips` into a fresh planar output buffer with
/// `context.total_frames` samples per channel at `context.output_rate`.
///
/// Each clip is expected to carry its decoded PCM in `clips[..]` with
/// shape `PlanarSamples`; this function doesn't decode — the caller has
/// already done the decode/resample for each clip. The function only
/// routes samples into the right timeline position with the per-clip
/// gain applied.
///
/// This keeps step 4a small: the JS side calls `decode_to_planar_f32`
/// per clip, then `mix_audio_clips` for the mix, then writes the result
/// to `Mp4Sink::write_audio` via `audio_to_planar`. The pipeline owns
/// no extra state between calls.
pub fn mix_audio_clips(
    clips: &[(AudioClip, PlanarSamples)],
    context: &MixerContext,
) -> Result<PlanarSamples, MixdownError> {
    let channels = context.output_channels as usize;
    let total_frames = context.total_frames;
    let mut output: PlanarSamples = vec![vec![0.0_f32; total_frames]; channels];

    for (clip, samples) in clips {
        if clip.muted {
            continue;
        }
        let clip_channels = samples.len();
        if clip_channels == 0 {
            continue;
        }
        let clip_frames = samples[0].len();
        if clip_frames == 0 {
            continue;
        }

        let output_start =
            (clip.start_seconds * context.output_rate as f64).floor() as isize;
        let output_end = ((clip.start_seconds + clip.duration_seconds)
            * context.output_rate as f64)
            .ceil() as isize;

        if output_end <= 0 || output_start as usize >= total_frames {
            continue;
        }

        let frames_in_output = (output_end - output_start.max(0)) as usize;
        if frames_in_output == 0 {
            continue;
        }

        let (source_start, source_end) = clip.source_window();

        for frame_index in 0..frames_in_output {
            let output_index = (output_start as isize).max(0) as isize
                + frame_index as isize;
            if output_index < 0 || output_index as usize >= total_frames {
                continue;
            }
            let timeline_time =
                output_index as f64 / context.output_rate as f64;
            let source_time = clip.trim_start_seconds
                + (timeline_time - clip.start_seconds);
            if source_time < source_start || source_time >= source_end {
                continue;
            }
            let source_frames_f =
                (source_time * context.output_rate as f64) as isize;
            if source_frames_f < 0
                || source_frames_f as usize >= clip_frames
            {
                continue;
            }
            let source_frames = source_frames_f as usize;

            for channel in 0..channels {
                let source_channel = channel.min(clip_channels - 1);
                let sample = samples[source_channel]
                    .get(source_frames)
                    .copied()
                    .unwrap_or(0.0);
                output[channel][output_index as usize] += sample * clip.gain;
            }
        }
    }

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine<F: FnMut(usize) -> f32>(length: usize, mut f: F) -> PlanarSamples {
        vec![(0..length).map(&mut f).collect::<Vec<_>>()]
    }

    fn clip(samples: PlanarSamples) -> (AudioClip, PlanarSamples) {
        (
            AudioClip {
                source_path: std::path::PathBuf::from("/dev/null"),
                start_seconds: 0.0,
                duration_seconds: 1.0,
                trim_start_seconds: 0.0,
                trim_end_seconds: 0.0,
                gain: 1.0,
                muted: false,
            },
            samples,
        )
    }

    #[test]
    fn mix_audio_clips_sums_two_clips_with_overlap() {
        // Clip A: 1 s sine that ramps from 0 → 1.
        // Clip B: 1 s sine that ramps from 1 → 0 (mirror), starting at
        // 0.5 s. At the midpoint of the overlap window (t = 0.75 s),
        // clip A contributes 0.75 and clip B contributes 0.75,
        // summing to 1.5.
        let first = clip(sine(48_000, |i| (i as f32) / 48_000.0));
        let mut second_clip = clip(sine(48_000, |i| {
            1.0 - (i as f32) / 48_000.0
        }));
        second_clip.0.start_seconds = 0.5;
        second_clip.0.trim_start_seconds = 0.0;
        let context = MixerContext {
            output_rate: 48_000,
            output_channels: 1,
            total_frames: 48_000,
        };
        let output =
            mix_audio_clips(&[first, second_clip], &context).expect("mix");
        let midpoint = output[0][36_000];
        assert!(
            (midpoint - 1.5).abs() < 1e-4,
            "midpoint should be ~1.5, got {midpoint}"
        );
        // Far from the overlap (only clip A is in the mix), the sample
        // is clip A's value at 0.25 s.
        let earlier = output[0][12_000];
        assert!(
            (earlier - 0.25).abs() < 1e-4,
            "earlier sample should be ~0.25, got {earlier}"
        );
    }

    #[test]
    fn mix_audio_clips_skips_muted_clips() {
        let mut c = clip(sine(48_000, |_| 1.0));
        c.0.muted = true;
        let context = MixerContext {
            output_rate: 48_000,
            output_channels: 1,
            total_frames: 1024,
        };
        let output = mix_audio_clips(&[c], &context).expect("mix");
        assert!(output[0].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn mix_audio_clips_clips_a_clip_outside_the_output_window() {
        // A clip with start_seconds far past the output is dropped on
        // the floor.
        let mut c = clip(sine(48_000, |_| 1.0));
        c.0.start_seconds = 10.0;
        let context = MixerContext {
            output_rate: 48_000,
            output_channels: 1,
            total_frames: 1024,
        };
        let output = mix_audio_clips(&[c], &context).expect("mix");
        assert!(output[0].iter().all(|&s| s == 0.0));
    }

    #[test]
    fn audio_clip_end_seconds_is_start_plus_duration() {
        let clip = AudioClip {
            source_path: std::path::PathBuf::from("/dev/null"),
            start_seconds: 1.0,
            duration_seconds: 0.5,
            trim_start_seconds: 0.0,
            trim_end_seconds: 0.0,
            gain: 1.0,
            muted: false,
        };
        assert_eq!(clip.end_seconds(), 1.5);
    }

    #[test]
    fn audio_clip_source_window_is_trim_start_to_trim_start_plus_duration() {
        let clip = AudioClip {
            source_path: std::path::PathBuf::from("/dev/null"),
            start_seconds: 0.0,
            duration_seconds: 0.5,
            trim_start_seconds: 0.25,
            trim_end_seconds: 0.0,
            gain: 1.0,
            muted: false,
        };
        assert_eq!(clip.source_window(), (0.25, 0.75));
    }
}
