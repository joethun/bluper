//! Audio decode — read a whole audio track in Rust rather than through
//! WebCodecs and `decodeAudioData` in the page.
//!
//! Two things ask for audio, and they want very different amounts of it:
//!
//! - **Waveforms** want one peak per bucket, which is a thousandth of the track.
//!   [`bluper_audio_waveform_segment`] decodes a window and folds it to peaks
//!   here, so the samples themselves never cross the IPC boundary at all. It is
//!   a window rather than the whole file so the webview can draw the wave as it
//!   fills, the way it does today.
//! - **Playback and export mixing** want every sample. [`bluper_decode_audio_pcm`]
//!   writes one `f32` file per channel into the cache directory and hands back
//!   the paths; the webview reads them over `asset:` straight into an
//!   `AudioBuffer`. One file per channel rather than an interleaved one because
//!   `AudioBuffer.copyToChannel` takes a contiguous channel — interleaved would
//!   make the page de-interleave hundreds of millions of floats to undo a
//!   layout we chose.
//!
//! Why this exists at all: `AudioDecoder` support is not the same on every
//! engine and cannot be asked in advance, so the webview's decode path is a
//! chain of attempts with a coverage check to catch the ones that quietly come
//! back short. ffmpeg has no such ambiguity — it either reads the container or
//! says so — which removes the guessing along with the fallbacks.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use editor_core::media::fold_channel_peaks_inner;
use ffmpeg_next as ffmpeg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::media_readers::{ensure_ffmpeg, ReaderPool};
use crate::native_fs;

/// Rate used when a track reports none of its own.
const FALLBACK_SAMPLE_RATE: u32 = 48_000;

/// How close a requested window start has to be to where the reader already
/// sits for the seek to be skipped.
///
/// One millisecond: far below one compressed frame (21ms for AAC at 48kHz), so
/// a window this can mistake for "already there" cannot skip past audible
/// samples, and far above the float error of a start that round-tripped through
/// JSON as the previous window's end.
const RESUME_TOLERANCE_SECONDS: f64 = 1e-3;

/// Extra output slots handed to the resampler beyond the arithmetic minimum.
/// `swr` keeps whatever will not fit and returns it on a later call, which is
/// correct but leaves the tail of a track sitting in its internal buffer; the
/// slack means that only ever happens for a sample or two, which the flush at
/// end-of-stream then collects.
const RESAMPLE_SLACK_SAMPLES: usize = 256;

fn map_err<E: std::fmt::Display>(err: E) -> String {
	err.to_string()
}

/// ffmpeg's `Display` is empty for several of its error codes, which turns a
/// failed decode into an unattributable blank string. Every fallible call here
/// says which one it was.
fn context<E: std::fmt::Display>(what: &str) -> impl Fn(E) -> String + '_ {
	move |err| {
		let detail = err.to_string();
		if detail.is_empty() {
			format!("{what} failed")
		} else {
			format!("{what} failed: {detail}")
		}
	}
}

/// What the first decoded frame turned out to be.
///
/// Read off the frame rather than the container on purpose: HE-AAC decodes at
/// twice the rate it declares, so a caller that sized a buffer from the
/// container's number would hold half the track. The webview's own decode path
/// has the same rule for the same reason.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioShape {
	pub sample_rate: u32,
	pub channels: u16,
	/// Frames at `sample_rate`, from the container's declared duration. A lossy
	/// track routinely decodes a frame or two either side of this.
	pub total_frames: u64,
	pub duration_seconds: f64,
}

/// One window of a track, reduced to peaks. See
/// [`bluper_audio_waveform_segment`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformSegment {
	pub shape: AudioShape,
	/// Bucket index, on the track-wide grid, that `peaks[0]` belongs to. The
	/// webview folds this window into its full-length array at this offset.
	pub first_bucket: u64,
	/// One absolute peak per bucket, `f32` little-endian, base64.
	///
	/// Base64 in JSON rather than a scratch file because a window's worth of
	/// peaks is tiny — a minute of 48kHz audio at the default bucket size is
	/// 22,500 floats — and a file per window would churn the cache directory
	/// for no gain. PCM, which is four orders of magnitude larger, goes the
	/// other way.
	pub peaks_base64: String,
	/// Where the next window starts. `None` at the end of the track.
	pub next_start_seconds: Option<f64>,
}

/// Where a decoded track's samples landed. See [`bluper_decode_audio_pcm`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPcm {
	pub shape: AudioShape,
	/// One file per channel, each a flat run of little-endian `f32`.
	pub channel_paths: Vec<String>,
	/// Frames actually decoded, which is what the files hold —
	/// `shape.total_frames` is only what the container claimed.
	pub frames: u64,
	/// Hand back to [`bluper_release_audio_pcm`] once the samples have been
	/// read. These files are the size of the decoded track, so leaving them for
	/// the startup sweep would mean gigabytes sitting in the cache all session.
	pub token: String,
}

/// Decoder, resampler and the stream they belong to, set up together because
/// the resampler cannot be built until the first frame says what it is
/// converting from.
pub struct AudioReader {
	path: PathBuf,
	input: ffmpeg::format::context::Input,
	decoder: ffmpeg::codec::decoder::Audio,
	resampler: Option<ffmpeg::software::resampling::Context>,
	stream_index: usize,
	time_base: ffmpeg::Rational,
	duration_seconds: f64,
	/// Rate to convert to. `None` until the first frame settles it.
	out_rate: Option<u32>,
	out_channels: Option<u16>,
	requested_rate: Option<u32>,
	max_channels: Option<u16>,
	/// Track time the demuxer is positioned at, when that is known.
	///
	/// `Some(0.0)` on a fresh reader — a context that has not been read starts at
	/// the head — and `None` once the track has been read to its end, because
	/// reading further needs a seek whatever is asked for.
	resume_seconds: Option<f64>,
}

/// Waveform readers kept between windows.
///
/// The waveform is drawn window by window so it fills as it reads, and each
/// window used to open the container again. Measured on the user's own media
/// that open is 14.7ms against 10.4ms of actual decoding — 59% of the cost of a
/// window spent re-reading a header — and a long track is hundreds of windows.
///
/// Only the waveform route is pooled. It always asks for the track's own rate
/// and channel count, so one reader per file serves every window; the PCM route
/// asks for a specific shape and reads the whole track once, which has nothing
/// to reuse.
pub struct Waveforms;
pub type WaveformReaders = ReaderPool<AudioReader, Waveforms>;

pub fn open_audio(
	path: &Path,
	requested_rate: Option<u32>,
	max_channels: Option<u16>,
) -> Result<AudioReader, String> {
	ensure_ffmpeg()?;
	let input = ffmpeg::format::input(path).map_err(context("opening the media file"))?;
	let (stream_index, time_base, duration_seconds, parameters) = {
		let stream = input
			.streams()
			.best(ffmpeg::media::Type::Audio)
			.ok_or_else(|| "no audio stream in input".to_string())?;
		let time_base = stream.time_base();
		// The stream's own duration where it has one; the container's otherwise
		// (MPEG-TS and some Matroska files only carry it at the top level).
		let duration_seconds = if stream.duration() > 0 && time_base.denominator() != 0 {
			stream.duration() as f64 * time_base.numerator() as f64
				/ time_base.denominator() as f64
		} else if input.duration() > 0 {
			input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
		} else {
			0.0
		};
		(
			stream.index(),
			time_base,
			duration_seconds,
			stream.parameters(),
		)
	};

	let codec_context = ffmpeg::codec::context::Context::from_parameters(parameters)
		.map_err(context("reading the audio codec parameters"))?;
	let decoder = codec_context
		.decoder()
		.audio()
		.map_err(context("opening the audio decoder"))?;

	Ok(AudioReader {
		path: path.to_path_buf(),
		input,
		decoder,
		resampler: None,
		stream_index,
		time_base,
		duration_seconds,
		out_rate: None,
		out_channels: None,
		requested_rate,
		max_channels,
		resume_seconds: Some(0.0),
	})
}

impl AudioReader {
	/// Builds the resampler from what the first decoded frame actually is, and
	/// returns the shape everything downstream is sized by.
	fn settle(&mut self, frame: &ffmpeg::frame::Audio) -> Result<AudioShape, String> {
		if self.resampler.is_none() {
			let source_rate = if frame.rate() > 0 {
				frame.rate()
			} else {
				FALLBACK_SAMPLE_RATE
			};
			let source_channels = frame.channels().max(1);
			let source_layout = if frame.channel_layout().is_empty() {
				ffmpeg::ChannelLayout::default(i32::from(source_channels))
			} else {
				frame.channel_layout()
			};

			let out_channels = self
				.max_channels
				.map_or(source_channels, |cap| source_channels.min(cap.max(1)));
			let out_rate = self.requested_rate.unwrap_or(source_rate);

			self.resampler = Some(
				ffmpeg::software::resampling::Context::get(
					frame.format(),
					source_layout,
					source_rate,
					ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
					ffmpeg::ChannelLayout::default(i32::from(out_channels)),
					out_rate,
				)
				.map_err(context("building the audio resampler"))?,
			);
			self.out_rate = Some(out_rate);
			self.out_channels = Some(out_channels);
		}

		Ok(self.shape())
	}

	fn shape(&self) -> AudioShape {
		let sample_rate = self.out_rate.unwrap_or(FALLBACK_SAMPLE_RATE);
		AudioShape {
			sample_rate,
			channels: self.out_channels.unwrap_or(1),
			total_frames: (self.duration_seconds * f64::from(sample_rate)).round() as u64,
			duration_seconds: self.duration_seconds,
		}
	}

	fn to_seconds(&self, pts: i64) -> f64 {
		if self.time_base.denominator() == 0 {
			return 0.0;
		}
		pts as f64 * self.time_base.numerator() as f64 / self.time_base.denominator() as f64
	}

	/// Reopens the container, keeping the output format already settled.
	///
	/// The resampler describes what is being converted *to*, which a reopen does
	/// not change; rebuilding it would also mean re-deciding the shape from a
	/// first frame, and callers have already been told what that shape is.
	fn reopen(&mut self) -> Result<(), String> {
		let fresh = open_audio(&self.path, self.requested_rate, self.max_channels)?;
		self.input = fresh.input;
		self.decoder = fresh.decoder;
		self.stream_index = fresh.stream_index;
		self.time_base = fresh.time_base;
		self.resume_seconds = Some(0.0);
		Ok(())
	}

	/// Puts the demuxer at `start_seconds`, leaving it alone when it is already
	/// there.
	///
	/// Skipping the seek is what makes reading a track in order cheaper than
	/// reading it in scattered windows: a seek throws away the decoder's state,
	/// and the packets around the target then have to be decoded again to prime
	/// it. A window that begins exactly where the last one ended can carry on.
	///
	/// This is safe rather than merely close: peaks are placed by each frame's
	/// own timestamp, not by the start that was requested, so carrying on folds
	/// into the same buckets a seek would have.
	fn position_at(&mut self, start_seconds: f64) -> Result<(), String> {
		let already_there = self
			.resume_seconds
			.is_some_and(|resume| (resume - start_seconds).abs() <= RESUME_TOLERANCE_SECONDS);
		// Cleared whichever way this goes, and set again only once a read has
		// finished cleanly. A read that fails part-way has already consumed
		// packets, so where it *started* no longer says where the demuxer is, and
		// a later window that trusted it would skip a seek it needs.
		self.resume_seconds = None;
		if already_there {
			return Ok(());
		}

		// The range's upper bound is `max_ts`, which ffmpeg reads inclusively, so
		// this lands on the packet at or before the target.
		let target = (start_seconds.max(0.0) * 1_000_000.0) as i64;
		if self.input.seek(target, ..target).is_err() {
			// A container that refuses the seek left a *fresh* context at the head,
			// so reading on from there was still correct — only slower. A reader
			// kept between windows is wherever the last one left it, and reading on
			// from there would fold peaks out of the wrong part of the track.
			// Reopening restores the head that made the old behaviour correct.
			self.reopen()?;
		}
		self.decoder.flush();
		Ok(())
	}

	fn resample(
		&mut self,
		decoded: &ffmpeg::frame::Audio,
	) -> Result<ffmpeg::frame::Audio, String> {
		let out_rate = self.out_rate.unwrap_or(FALLBACK_SAMPLE_RATE);
		let out_channels = self.out_channels.unwrap_or(1);
		let source_rate = if decoded.rate() > 0 {
			decoded.rate()
		} else {
			out_rate
		};
		// Sized rather than left empty: `run` on an empty frame allocates only
		// as many slots as the input had, which is short whenever the output
		// rate is the higher one, and the remainder would sit in `swr`'s
		// internal buffer instead of coming out here.
		let capacity = (decoded.samples() as u64 * u64::from(out_rate) / u64::from(source_rate))
			as usize
			+ RESAMPLE_SLACK_SAMPLES;
		let mut out = ffmpeg::frame::Audio::new(
			ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
			capacity,
			ffmpeg::ChannelLayout::default(i32::from(out_channels)),
		);
		let resampler = self
			.resampler
			.as_mut()
			.ok_or_else(|| "resampler used before the first frame".to_string())?;
		resampler
			.run(decoded, &mut out)
			.map_err(context("resampling audio"))?;
		Ok(out)
	}

	fn flush_resampler(&mut self) -> Result<Option<ffmpeg::frame::Audio>, String> {
		let out_channels = self.out_channels.unwrap_or(1);
		let Some(resampler) = self.resampler.as_mut() else {
			return Ok(None);
		};
		let mut out = ffmpeg::frame::Audio::new(
			ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Planar),
			RESAMPLE_SLACK_SAMPLES * 8,
			ffmpeg::ChannelLayout::default(i32::from(out_channels)),
		);
		match resampler
			.flush(&mut out)
			.map_err(context("flushing the audio resampler"))?
		{
			Some(_) if out.samples() > 0 => Ok(Some(out)),
			_ => Ok(None),
		}
	}
}

/// Gives a decoded frame an explicit channel layout when the decoder left it
/// unspecified.
///
/// WAV and a few other containers describe a track only by its channel *count*,
/// so ffmpeg hands back a frame whose layout order is `UNSPEC`. The resampler
/// compares its configured input layout against every frame it is given and
/// rejects a mismatch with `AVERROR_INPUT_CHANGED` — an error whose `Display` is
/// the empty string — so a plain stereo WAV would fail to resample at all. This
/// stamps on the same default layout the resampler was configured with.
fn normalize_layout(frame: &mut ffmpeg::frame::Audio) {
	if frame.channel_layout().is_empty() {
		let channels = frame.channel_layout().channels().max(1);
		frame.set_channel_layout(ffmpeg::ChannelLayout::default(channels));
	}
}

/// Why the decode loop stopped.
struct DriveOutcome {
	shape: Option<AudioShape>,
	/// Presentation time the last frame handed over ends at.
	end_seconds: f64,
	/// The track ran out, rather than the window closing.
	reached_end: bool,
}

/// Decodes from `start_seconds`, handing each resampled planar-`f32` frame to
/// `on_frame` along with its start index in output frames.
///
/// Stops once a frame starts at or after `stop_seconds`, so a window always
/// ends on a frame boundary and the next one can pick up exactly there. Frames
/// are never split: a window that overlaps its neighbour by part of a frame
/// costs a few duplicated samples, and both callers are indifferent to that —
/// peaks fold with `max`, and the PCM route asks for the whole track at once.
fn drive<F>(
	reader: &mut AudioReader,
	start_seconds: f64,
	stop_seconds: Option<f64>,
	mut on_frame: F,
) -> Result<DriveOutcome, String>
where
	F: FnMut(&ffmpeg::frame::Audio, i64) -> Result<(), String>,
{
	reader.position_at(start_seconds)?;

	let mut shape: Option<AudioShape> = None;
	let mut emitted: i64 = 0;
	let mut base_frames: Option<i64> = None;
	let mut end_seconds = start_seconds;
	let mut reached_end = false;
	let mut stop = false;

	let mut deliver = |out: &ffmpeg::frame::Audio,
	                   base: i64,
	                   emitted: &mut i64|
	 -> Result<(), String> {
		if out.samples() == 0 {
			return Ok(());
		}
		on_frame(out, base + *emitted)?;
		*emitted += out.samples() as i64;
		Ok(())
	};

	'packets: loop {
		let packet = {
			let mut packets = reader.input.packets();
			match packets.next() {
				Some((stream, packet)) => {
					if stream.index() != reader.stream_index {
						continue 'packets;
					}
					packet
				}
				None => break 'packets,
			}
		};

		reader
			.decoder
			.send_packet(&packet)
			.map_err(context("feeding the audio decoder"))?;

		loop {
			let mut decoded = ffmpeg::frame::Audio::empty();
			if reader.decoder.receive_frame(&mut decoded).is_err() {
				break;
			}
			normalize_layout(&mut decoded);
			if shape.is_none() {
				shape = Some(reader.settle(&decoded)?);
			}
			let out_rate = reader.out_rate.unwrap_or(FALLBACK_SAMPLE_RATE);
			let pts_seconds = decoded.pts().map(|pts| reader.to_seconds(pts));

			if base_frames.is_none() {
				// Anchored to the first frame's own timestamp so a window that
				// began with a seek is placed where it belongs on the track,
				// not at zero.
				let anchor = pts_seconds.unwrap_or(start_seconds).max(0.0);
				base_frames = Some((anchor * f64::from(out_rate)).round() as i64);
			}
			let base = base_frames.unwrap_or(0);

			if let (Some(limit), Some(pts)) = (stop_seconds, pts_seconds) {
				if pts >= limit {
					stop = true;
				}
			}

			let out = reader.resample(&decoded)?;
			deliver(&out, base, &mut emitted)?;
			end_seconds = (base + emitted) as f64 / f64::from(out_rate);

			if stop {
				break 'packets;
			}
		}
	}

	if !stop {
		// Drain the decoder, then the resampler: a codec with a lookahead holds
		// the last frames until it is told the packets have run out.
		let _ = reader.decoder.send_eof();
		loop {
			let mut decoded = ffmpeg::frame::Audio::empty();
			if reader.decoder.receive_frame(&mut decoded).is_err() {
				break;
			}
			normalize_layout(&mut decoded);
			if shape.is_none() {
				shape = Some(reader.settle(&decoded)?);
			}
			let base = *base_frames.get_or_insert(0);
			let out = reader.resample(&decoded)?;
			deliver(&out, base, &mut emitted)?;
		}
		while let Some(out) = reader.flush_resampler()? {
			let base = base_frames.unwrap_or(0);
			deliver(&out, base, &mut emitted)?;
		}
		let out_rate = reader.out_rate.unwrap_or(FALLBACK_SAMPLE_RATE);
		end_seconds = (base_frames.unwrap_or(0) + emitted) as f64 / f64::from(out_rate);
		reached_end = true;
	}

	// Where the next window may pick up without seeking. Nothing to resume from
	// once the track has been read out: the demuxer is exhausted and the decoder
	// has been told so, so any further read has to seek whatever it asks for.
	reader.resume_seconds = if reached_end {
		None
	} else {
		Some(end_seconds)
	};

	Ok(DriveOutcome {
		shape,
		end_seconds,
		reached_end,
	})
}

/// Folds one window of a track into per-bucket peaks.
///
/// Opens the file for this one window. The command goes through
/// [`WaveformReaders`] instead, so a track read window by window pays the
/// container open once rather than per window.
pub fn waveform_segment(
	media_path: &Path,
	start_seconds: f64,
	duration_seconds: f64,
	bucket_size: u64,
) -> Result<WaveformSegment, String> {
	let mut reader = open_audio(media_path, None, None)?;
	waveform_segment_from(&mut reader, start_seconds, duration_seconds, bucket_size)
}

/// Folds one window into per-bucket peaks off an already-open reader, which may
/// already be positioned where this window begins.
///
/// Public so the reuse itself can be tested: a pooled reader carries a seek
/// position between windows, and that is the part of this file where getting it
/// wrong means peaks folded out of the wrong part of the track.
pub fn waveform_segment_from(
	reader: &mut AudioReader,
	start_seconds: f64,
	duration_seconds: f64,
	bucket_size: u64,
) -> Result<WaveformSegment, String> {
	let bucket_size = bucket_size.max(1);
	let bucket_size_f = bucket_size as f64;

	let mut peaks: Vec<f32> = Vec::new();
	let mut first_bucket: Option<u64> = None;

	let stop = if duration_seconds > 0.0 {
		Some(start_seconds + duration_seconds)
	} else {
		None
	};

	let outcome = drive(reader, start_seconds, stop, |frame, offset_frames| {
		let offset = offset_frames.max(0) as u64;
		let base_bucket = *first_bucket.get_or_insert(offset / bucket_size);
		let base_frame = base_bucket * bucket_size;
		// A frame decoded before the window's own first bucket would index
		// backwards out of the buffer. It can only happen if the resampler
		// hands back something ahead of the anchor, which it does not, but the
		// clamp costs nothing and a panic here would take the webview down.
		if offset < base_frame {
			return Ok(());
		}
		let local_offset = (offset - base_frame) as f64;

		let samples = frame.samples();
		if samples == 0 {
			return Ok(());
		}
		let last_bucket = ((local_offset + samples as f64 - 1.0) / bucket_size_f).floor() as usize;
		if last_bucket >= peaks.len() {
			peaks.resize(last_bucket + 1, 0.0);
		}

		for plane in 0..frame.planes() {
			let data = frame.plane::<f32>(plane);
			fold_channel_peaks_inner(&data[..samples.min(data.len())], &mut peaks, local_offset, bucket_size_f);
		}
		Ok(())
	})?;

	let shape = outcome.shape.unwrap_or_else(|| reader.shape());
	let mut bytes = Vec::with_capacity(peaks.len() * 4);
	for peak in &peaks {
		bytes.extend_from_slice(&peak.to_le_bytes());
	}

	Ok(WaveformSegment {
		shape,
		first_bucket: first_bucket.unwrap_or(0),
		peaks_base64: STANDARD.encode(&bytes),
		next_start_seconds: if outcome.reached_end || peaks.is_empty() {
			None
		} else {
			Some(outcome.end_seconds)
		},
	})
}

/// Decodes a window of a track and folds it to one peak per `bucketSize`
/// frames. The samples never leave Rust.
///
/// `(async)` keeps it off Tauri's main thread — a synchronous command runs
/// there, and a window of a long track is tens of milliseconds.
#[tauri::command(async)]
pub fn bluper_audio_waveform_segment(
	readers: tauri::State<'_, WaveformReaders>,
	media_path: String,
	start_seconds: f64,
	duration_seconds: f64,
	bucket_size: u64,
) -> Result<WaveformSegment, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}
	let reader = readers.checkout(&path, "", || open_audio(&path, None, None))?;
	let mut reader = reader
		.lock()
		.map_err(|_| format!("audio reader poisoned for {}", path.display()))?;
	waveform_segment_from(&mut reader, start_seconds, duration_seconds, bucket_size)
}

/// Readers used to answer window requests during playback.
///
/// Separate from [`WaveformReaders`] because these resample to the shape the
/// caller asks for — playback wants the `AudioContext`'s rate — and a reader
/// built for one shape cannot answer for another. The pool's variant key keeps
/// them apart.
pub struct PcmWindows;
pub type PcmWindowReaders = ReaderPool<AudioReader, PcmWindows>;

/// How the shape is named in the reader pool, so two rates over one file are
/// two readers rather than one that keeps being rebuilt.
fn shape_variant(sample_rate: Option<u32>, max_channels: Option<u16>) -> String {
	format!("{}:{}", sample_rate.unwrap_or(0), max_channels.unwrap_or(0))
}

/// Bytes at the front of a window response, before the samples.
///
/// Sixteen bytes: channels, sample rate, frames per channel, and the track time
/// the first frame belongs at — the last as an `f64` so a window placed by its
/// own timestamp is placed exactly, which is what keeps a decoded window from
/// drifting against the timeline.
const WINDOW_HEADER_BYTES: usize = 4 + 4 + 4 + 8;

/// Decodes one window of a track and returns it as planar `f32`.
///
/// ## Why this exists next to [`bluper_decode_audio_pcm`]
///
/// The whole-track command decodes every sample to disk before it returns, and
/// playback used to wait for that. Measured on the user's own media: 4,120ms
/// and 1.71GB written before the first sample of a 74-minute track could be
/// heard, and 2,678ms / 1.12GB for a 49-minute one. The audio playback needs to
/// *begin* is one second of it, which costs 15ms — a container open and one
/// window — so waiting for the track was between 140x and 285x longer than
/// waiting for the audio.
///
/// So playback reads windows and export keeps the whole-track route, which is
/// the one that genuinely wants every sample at once.
///
/// ## Why raw bytes rather than JSON or a file
///
/// A window is a second of audio — 384KB at 48kHz stereo — which is far too
/// much to base64 into JSON per window and far too little to be worth a file on
/// disk and an `asset:` round trip. `Response` hands the webview an
/// `ArrayBuffer` it can copy straight into an `AudioBuffer` channel.
#[tauri::command(async)]
pub fn bluper_decode_audio_window(
	readers: tauri::State<'_, PcmWindowReaders>,
	media_path: String,
	start_seconds: f64,
	duration_seconds: f64,
	sample_rate: Option<u32>,
	max_channels: Option<u16>,
) -> Result<tauri::ipc::Response, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}

	let variant = shape_variant(sample_rate, max_channels);
	let reader = readers.checkout(&path, &variant, || {
		open_audio(&path, sample_rate, max_channels)
	})?;
	let mut reader = reader
		.lock()
		.map_err(|_| format!("audio reader poisoned for {}", path.display()))?;

	Ok(tauri::ipc::Response::new(decode_audio_window(
		&mut reader,
		start_seconds,
		duration_seconds,
	)?))
}

/// The body of [`bluper_decode_audio_window`], off a reader the caller owns.
///
/// Public so the wire format can be tested: the header is hand-packed and the
/// webview reads it by offset, so a field in the wrong place is silence or noise
/// rather than an error.
pub fn decode_audio_window(
	reader: &mut AudioReader,
	start_seconds: f64,
	duration_seconds: f64,
) -> Result<Vec<u8>, String> {
	let stop = if duration_seconds > 0.0 {
		Some(start_seconds + duration_seconds)
	} else {
		None
	};

	// One `Vec` per channel, then concatenated: `AudioBuffer.copyToChannel` takes
	// a contiguous channel, so planar is the layout that lets the webview copy
	// rather than de-interleave.
	let mut planes: Vec<Vec<f32>> = Vec::new();
	let mut first_frame: Option<i64> = None;

	let outcome = drive(reader, start_seconds, stop, |frame, offset_frames| {
		let samples = frame.samples();
		if samples == 0 {
			return Ok(());
		}
		if planes.is_empty() {
			planes = (0..frame.planes()).map(|_| Vec::new()).collect();
		}
		first_frame.get_or_insert(offset_frames);
		for (index, plane) in planes.iter_mut().enumerate() {
			if index >= frame.planes() {
				break;
			}
			let data = frame.plane::<f32>(index);
			plane.extend_from_slice(&data[..samples.min(data.len())]);
		}
		Ok(())
	})?;

	let shape = outcome.shape.unwrap_or_else(|| reader.shape());
	let rate = f64::from(shape.sample_rate.max(1));

	// Trim to exactly the range asked for.
	//
	// `drive` never splits a decoder frame — it delivers the one that crosses
	// the window's end and stops there — so what came back overlaps the next
	// window by up to a frame, and begins before this one wherever the seek
	// landed on a packet boundary. That is deliberate and harmless for
	// waveforms, which fold peaks with `max`. For playback it is not: the
	// duplicated samples at each boundary are an audible click, and there are as
	// many of them as there are windows.
	//
	// The offsets `drive` reports are absolute positions on the track and each
	// delivered frame follows the last without a gap, so the concatenated planes
	// are one contiguous run starting at `first_frame` — which makes the trim a
	// pair of indices rather than a re-decode.
	let first_offset = first_frame.unwrap_or(0).max(0);
	let wanted_first = (start_seconds.max(0.0) * rate).round() as i64;
	let decoded = planes.first().map_or(0, |plane| plane.len());
	let skip = (wanted_first - first_offset).clamp(0, decoded as i64) as usize;
	let keep = if duration_seconds > 0.0 {
		((duration_seconds * rate).round() as usize).min(decoded - skip)
	} else {
		decoded - skip
	};
	for plane in planes.iter_mut() {
		// Every plane holds the same run of frames, but a decoder that returned
		// a short plane must not index out of it.
		let start = skip.min(plane.len());
		let end = (skip + keep).min(plane.len());
		*plane = plane[start..end].to_vec();
	}

	let frames = planes.first().map_or(0, |plane| plane.len());
	// A mono track and a stereo one both have to report a channel count, and a
	// window that decoded nothing still has to say what the track is.
	let channels = if planes.is_empty() {
		shape.channels as usize
	} else {
		planes.len()
	};

	let mut out = Vec::with_capacity(WINDOW_HEADER_BYTES + channels * frames * 4);
	out.extend_from_slice(&(channels as u32).to_le_bytes());
	out.extend_from_slice(&shape.sample_rate.to_le_bytes());
	out.extend_from_slice(&(frames as u32).to_le_bytes());
	// Where these samples belong on the track, after the trim. Derived from the
	// frame offsets rather than from `start_seconds` so that a window the seek
	// could not place exactly reports where it truly starts — the webview
	// schedules by this, and a window that lied about it would drift.
	let first_seconds = (first_offset + skip as i64) as f64 / rate;
	out.extend_from_slice(&first_seconds.to_le_bytes());
	for plane in &planes {
		// `f32` has no padding and the webview reads these back as a
		// little-endian `Float32Array`, so the in-memory representation is the
		// wire format on every platform this ships to.
		let bytes = unsafe {
			std::slice::from_raw_parts(
				plane.as_ptr() as *const u8,
				std::mem::size_of_val(&plane[..]),
			)
		};
		out.extend_from_slice(bytes);
	}

	Ok(out)
}

/// What a track is, without decoding it.
///
/// The rate and channel count come off the first decoded frame rather than the
/// container — HE-AAC decodes at twice the rate it declares — so this decodes
/// one frame and stops. On a pooled reader that is a container open the first
/// time and nothing after it.
#[tauri::command(async)]
pub fn bluper_audio_shape(
	readers: tauri::State<'_, PcmWindowReaders>,
	media_path: String,
	sample_rate: Option<u32>,
	max_channels: Option<u16>,
) -> Result<AudioShape, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}

	let variant = shape_variant(sample_rate, max_channels);
	let reader = readers.checkout(&path, &variant, || {
		open_audio(&path, sample_rate, max_channels)
	})?;
	let mut reader = reader
		.lock()
		.map_err(|_| format!("audio reader poisoned for {}", path.display()))?;

	// One frame is enough to settle the rate and channel count, and the window
	// this leaves the reader at is the one playback asks for next.
	let outcome = drive(&mut reader, 0.0, Some(0.05), |_frame, _offset| Ok(()))?;
	Ok(outcome.shape.unwrap_or_else(|| reader.shape()))
}

/// Names the staged decode of one track at one shape.
///
/// Content-addressed rather than run-numbered, which is what lets two readers
/// of the same source share a decode instead of each running their own. The
/// file's size and modification time are in the key so a source replaced on
/// disk under the same path is a different decode rather than a stale hit.
fn pcm_token(path: &Path, sample_rate: Option<u32>, max_channels: Option<u16>) -> String {
	let mut hasher = DefaultHasher::new();
	path.hash(&mut hasher);
	if let Ok(meta) = fs::metadata(path) {
		meta.len().hash(&mut hasher);
		if let Ok(modified) = meta.modified() {
			if let Ok(age) = modified.duration_since(std::time::UNIX_EPOCH) {
				age.as_nanos().hash(&mut hasher);
			}
		}
	}
	sample_rate.unwrap_or(0).hash(&mut hasher);
	max_channels.unwrap_or(0).hash(&mut hasher);
	format!("{:016x}", hasher.finish())
}

/// What one staged decode is, and how many readers still hold it.
struct PcmEntry {
	/// Filled by whichever call decodes it; the rest wait on this lock and find
	/// it already there.
	decoded: Option<DecodedPcm>,
	readers: usize,
}

/// The staged PCM decodes this session is holding.
///
/// Decoding a track means writing its every sample to disk — seconds of work
/// and up to gigabytes for a long recording — and the webview opens a stream
/// per source, releases it when the source leaves the project, and can be
/// asked for the same source again by an export while playback still holds it.
/// Sharing one decode between those readers is the difference between paying
/// that cost once and paying it per reader.
///
/// The files go as soon as the last reader lets go: nothing is retained
/// speculatively, because what is being retained is the size of the decoded
/// track and there is no bound that makes holding several of them reasonable.
#[derive(Default)]
pub struct PcmCache {
	entries: Mutex<HashMap<String, Arc<Mutex<PcmEntry>>>>,
}

impl PcmCache {
	/// The slot for `token`, created empty if this is the first ask.
	fn slot(&self, token: &str) -> Result<Arc<Mutex<PcmEntry>>, String> {
		let mut entries = self.entries.lock().map_err(|_| "pcm cache poisoned")?;
		Ok(entries
			.entry(token.to_string())
			.or_insert_with(|| {
				Arc::new(Mutex::new(PcmEntry {
					decoded: None,
					readers: 0,
				}))
			})
			.clone())
	}
}

fn pcm_dir<R: Runtime>(app: &AppHandle<R>, token: &str) -> Result<PathBuf, String> {
	// One segment, no separators: the token is handed back by the webview to be
	// deleted, and this is what keeps that from naming anything else.
	if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
		return Err(format!("malformed pcm token: {token}"));
	}
	Ok(native_fs::app_cache_dir(app)
		.map_err(map_err)?
		.join("audio")
		.join(token))
}

/// What a PCM decode produced, before it is given a token to be released by.
#[derive(Clone)]
pub struct DecodedPcm {
	pub shape: AudioShape,
	pub channel_paths: Vec<String>,
	pub frames: u64,
}

/// Decodes an entire audio track into `dir`, one `f32` file per channel.
/// Removes the directory and reports the error if anything goes wrong, so a
/// failed decode never leaves a half-written track for the webview to read.
pub fn decode_audio_pcm_into(
	media_path: &Path,
	dir: &Path,
	sample_rate: Option<u32>,
	max_channels: Option<u16>,
) -> Result<DecodedPcm, String> {
	fs::create_dir_all(dir).map_err(context("creating the pcm directory"))?;

	let mut reader = open_audio(media_path, sample_rate, max_channels)?;
	let mut writers: Vec<BufWriter<fs::File>> = Vec::new();
	let mut channel_paths: Vec<String> = Vec::new();
	let mut written_frames: u64 = 0;
	let mut error: Option<String> = None;

	let outcome = drive(&mut reader, 0.0, None, |frame, _offset| {
		let samples = frame.samples();
		if samples == 0 {
			return Ok(());
		}
		if writers.is_empty() {
			for plane in 0..frame.planes() {
				let channel_path = dir.join(format!("ch{plane}.f32"));
				let file = fs::File::create(&channel_path).map_err(map_err)?;
				writers.push(BufWriter::new(file));
				channel_paths.push(channel_path.to_string_lossy().into_owned());
			}
		}
		for (plane, writer) in writers.iter_mut().enumerate() {
			let data = frame.plane::<f32>(plane);
			let data = &data[..samples.min(data.len())];
			// `f32` has no padding and the webview reads these back as a
			// little-endian `Float32Array`, so the in-memory representation is
			// the file format on every platform this ships to.
			let bytes = unsafe {
				std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(data))
			};
			writer.write_all(bytes).map_err(map_err)?;
		}
		written_frames += samples as u64;
		Ok(())
	});

	// Flush every writer before reporting either way: a buffered tail left
	// unwritten would read back as a track that ends early, which is exactly
	// the failure the native route exists to remove.
	for writer in writers.iter_mut() {
		if let Err(flush_error) = writer.flush() {
			error.get_or_insert_with(|| flush_error.to_string());
		}
	}
	drop(writers);

	let outcome = match (outcome, error) {
		(Ok(outcome), None) => outcome,
		(Ok(_), Some(message)) | (Err(message), _) => {
			let _ = fs::remove_dir_all(dir);
			return Err(message);
		}
	};

	if channel_paths.is_empty() {
		let _ = fs::remove_dir_all(dir);
		return Err(format!("no decodable audio in {}", media_path.display()));
	}

	Ok(DecodedPcm {
		shape: outcome.shape.unwrap_or_else(|| reader.shape()),
		channel_paths,
		frames: written_frames,
	})
}

/// Decodes an entire audio track to `f32`, one file per channel, and hands back
/// a reader on it.
///
/// A track already staged for this shape is shared rather than decoded again,
/// and the caller cannot tell the difference: it gets the same paths and a
/// token to release when it is done. Two calls that arrive together settle on
/// the slot's lock, so the second waits out the first's decode instead of
/// writing over it.
#[tauri::command(async)]
pub fn bluper_decode_audio_pcm<R: Runtime>(
	app: AppHandle<R>,
	cache: tauri::State<'_, PcmCache>,
	media_path: String,
	sample_rate: Option<u32>,
	max_channels: Option<u16>,
) -> Result<AudioPcm, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}

	let token = pcm_token(&path, sample_rate, max_channels);
	let slot = cache.slot(&token)?;
	// The `entries` lock is released above; holding it across a decode would
	// stall every other source behind this one.
	let mut entry = slot.lock().map_err(|_| "pcm entry poisoned")?;

	if entry.decoded.is_none() {
		let dir = pcm_dir(&app, &token)?;
		// A directory left by a previous session's crash holds files this
		// decode is about to write; the decode itself replaces them, but a
		// channel count that shrank would leave the extra ones readable.
		if dir.exists() {
			let _ = fs::remove_dir_all(&dir);
		}
		entry.decoded = Some(decode_audio_pcm_into(
			&path,
			&dir,
			sample_rate,
			max_channels,
		)?);
	}

	let decoded = entry
		.decoded
		.clone()
		.ok_or_else(|| "pcm decode vanished".to_string())?;
	entry.readers += 1;

	Ok(AudioPcm {
		shape: decoded.shape,
		channel_paths: decoded.channel_paths,
		frames: decoded.frames,
		token,
	})
}

/// Lets go of one reader's hold on a staged decode, and deletes the files once
/// the last one has.
#[tauri::command(async)]
pub fn bluper_release_audio_pcm<R: Runtime>(
	app: AppHandle<R>,
	cache: tauri::State<'_, PcmCache>,
	token: String,
) -> Result<(), String> {
	let dir = pcm_dir(&app, &token)?;
	let slot = cache.slot(&token)?;
	let mut entry = slot.lock().map_err(|_| "pcm entry poisoned")?;

	entry.readers = entry.readers.saturating_sub(1);
	if entry.readers > 0 {
		return Ok(());
	}

	// Deleted under the slot lock, so a reader that asked for this token while
	// the last one was letting go finds an empty slot and decodes it again
	// rather than reading files that are being removed underneath it. The slot
	// itself is kept: it is a token and a null, and keeping it is what
	// guarantees everyone asking for this decode meets on the same lock.
	entry.decoded = None;
	if dir.exists() {
		fs::remove_dir_all(&dir).map_err(map_err)?;
	}
	Ok(())
}
