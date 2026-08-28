//! Decoding single video frames in Rust, for seeking and scrubbing.
//!
//! The webview decodes video through `VideoDecoder`, and for playing *forwards*
//! that is the right place for it: the sink feeds one packet and takes one
//! frame, which measured 0.71ms per frame — far inside a frame budget.
//!
//! Seeking is the opposite case, and on the user's media it is brutal. Their
//! sources were re-encoded with almost no keyframes: one GOP is **60 seconds
//! and 1,499 frames**. A `VideoDecoder` handed that GOP has to decode from its
//! keyframe to the requested time before it can show anything, and measured in
//! the real window that is:
//!
//! | step | cost |
//! |---|---|
//! | demux the GOP | 47ms |
//! | write 12.5MB, fetch it back over `asset:` | 57ms |
//! | decode ~1,000 frames to reach the target | 610ms |
//!
//! About 700ms for one frame, paid again on every pointer move of a scrub.
//! The same catch-up in Rust is **125ms**, because ffmpeg decodes with
//! frame-level threading across every core while the webview's decoder does
//! not, and no packets have to cross the IPC boundary at all — only the one
//! frame that was asked for.
//!
//! ## Resuming
//!
//! Dragging the playhead forwards asks for a sequence of increasing times
//! inside one GOP. A reader that seeks back to the keyframe for each of them
//! re-decodes everything it just decoded, so a reader remembers where it is and
//! carries on when the next request is ahead of it — turning a 1,000-frame
//! catch-up into the handful of frames actually between the two positions.
//!
//! ## Why the pixels can cross
//!
//! `VideoFrame` can be constructed in the page from raw I420 planes and
//! uploaded to WebGL — checked on this WebKitGTK build. So a frame decoded here
//! reaches the compositor as an ordinary sample with no renderer change, and on
//! Linux it was going to make a CPU round trip on its way to a texture anyway.

use std::path::{Path, PathBuf};

use ffmpeg_next as ffmpeg;

use crate::media_readers::{ensure_ffmpeg, ReaderPool};

/// Presentation timestamps are seconds converted from integer ticks.
const PTS_EPSILON: f64 = 1e-6;

/// How far ahead of where a reader sits a request may be and still be answered
/// by decoding on rather than seeking.
///
/// A seek costs the whole catch-up from the GOP's keyframe, so carrying on is
/// worth it well past the point where it stops feeling cheap: at the measured
/// 8,000 frames per second, decoding four seconds forward costs about 12ms
/// against 125ms to seek and start again. Beyond that the seek is the better
/// bet, because it can land on a keyframe closer to the target.
const MAX_RESUME_SECONDS: f64 = 4.0;

/// Decoder threads per reader.
///
/// Frame-level threading is what makes a seek here beat the webview, but "one
/// per core" is the wrong setting for a *pool* of readers: on a 32-core machine
/// six open files would ask for 192 threads, and each one holds frame buffers.
///
/// Eight is where the gain stops. Measured on the user's media, frames per
/// second by thread count: 2,366 at one, 3,654 at two, 6,371 at four, **8,761 at
/// eight**, 8,420 at sixteen, 8,810 unbounded. The 1080p60 source is the same
/// shape — 2,673 at eight against 2,779 unbounded. So this keeps all of the
/// speed and bounds the threads at eight per reader.
const DECODER_THREADS: usize = 8;

/// How many frame decoders to keep open.
///
/// Smaller than the demuxer pool because each of these is heavier: a decoder
/// with [`DECODER_THREADS`] threads, plus the two decoded frames the cursor
/// holds — about 3MB for 720p and 9MB for 1080p per reader. Four covers the
/// clips a playhead crosses while scrubbing.
const FRAME_READER_CAPACITY: usize = 4;

/// Bytes at the front of a frame response, before the planes.
///
/// Width, height and the three plane lengths as little-endian `u32`s, then the
/// rotation, then the frame's own presentation time and the *next* frame's, both
/// `f64`. The page reads these by offset to build a `VideoFrame`.
pub const FRAME_HEADER_BYTES: usize = 4 * 6 + 8 + 8;

fn map_err<E: std::fmt::Display>(err: E) -> String {
	err.to_string()
}

/// An open container and decoder for pulling single frames out of one file.
pub struct FrameReader {
	path: PathBuf,
	input: ffmpeg::format::context::Input,
	decoder: ffmpeg::decoder::Video,
	stream_index: usize,
	time_base: ffmpeg::Rational,
	rotation: i32,
	/// The frame currently being shown: the latest one starting at or before the
	/// time last asked for.
	///
	/// Kept, rather than packed and dropped, because consecutive requests
	/// routinely want it again. Playing forwards at 25fps steps 40ms at a time
	/// and a scrub can step less than one frame, so without this the frame just
	/// returned would have to be decoded a second time — and since the decoder
	/// has already moved past it, that meant seeking back to the keyframe and
	/// decoding the whole GOP again. Measured at 178ms per frame before this was
	/// a cursor and 0.6ms after.
	held: Option<(f64, ffmpeg::frame::Video)>,
	/// The frame after `held`, already decoded. What tells us `held` is still the
	/// right answer for a given time without decoding any further.
	pending: Option<(f64, ffmpeg::frame::Video)>,
	/// Set once the stream has been drained, so the cursor stops trying to
	/// advance past the last picture.
	drained: bool,
}

/// One decoded frame, packed for the page.
pub struct DecodedFrame {
	pub width: u32,
	pub height: u32,
	pub rotation: i32,
	pub pts_seconds: f64,
	/// When the next frame starts, so the caller knows how long this one is on
	/// screen. Negative when this is the last picture in the file.
	///
	/// The consumer decides whether a frame is still current by
	/// `timestamp + duration`, and it has no other way to learn that: the
	/// container says when frames start, never how long they last. Reporting it
	/// costs nothing here because the cursor has already decoded the next frame.
	pub next_pts_seconds: f64,
	/// Y, then U, then V, each tightly packed with no row padding.
	pub planes: [Vec<u8>; 3],
}

impl DecodedFrame {
	/// The wire format: the header, then the three planes back to back.
	pub fn to_bytes(&self) -> Vec<u8> {
		let total: usize = self.planes.iter().map(|plane| plane.len()).sum();
		let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + total);
		out.extend_from_slice(&self.width.to_le_bytes());
		out.extend_from_slice(&self.height.to_le_bytes());
		for plane in &self.planes {
			out.extend_from_slice(&(plane.len() as u32).to_le_bytes());
		}
		out.extend_from_slice(&self.rotation.to_le_bytes());
		out.extend_from_slice(&self.pts_seconds.to_le_bytes());
		out.extend_from_slice(&self.next_pts_seconds.to_le_bytes());
		for plane in &self.planes {
			out.extend_from_slice(plane);
		}
		out
	}
}

/// Open frame decoders, one per file, kept between requests.
pub struct Frames;
pub type FrameReaders = ReaderPool<FrameReader, Frames>;

/// A pool sized for frame decoders, which are heavier than demuxers.
pub fn frame_readers() -> FrameReaders {
	FrameReaders::new(FRAME_READER_CAPACITY)
}

impl FrameReader {
	pub fn open(path: &Path) -> Result<Self, String> {
		ensure_ffmpeg()?;
		let input = ffmpeg::format::input(path).map_err(map_err)?;

		let (stream_index, time_base, rotation, parameters) = {
			let stream = input
				.streams()
				.best(ffmpeg::media::Type::Video)
				.ok_or_else(|| "no video stream in input".to_string())?;
			(
				stream.index(),
				stream.time_base(),
				crate::media_decode::stream_rotation(&stream),
				stream.parameters(),
			)
		};

		if time_base.denominator() == 0 {
			return Err(format!(
				"video stream has no usable time base in {}",
				path.display()
			));
		}

		let mut context =
			ffmpeg::codec::context::Context::from_parameters(parameters).map_err(map_err)?;
		// The whole reason this beats the webview on a seek: the catch-up from a
		// keyframe is parallel across frames. Measured 8,761 frames per second
		// against the webview's 1,405 on the same file. See [`DECODER_THREADS`]
		// for why the count is fixed rather than one per core.
		context.set_threading(ffmpeg::threading::Config {
			kind: ffmpeg::threading::Type::Frame,
			count: DECODER_THREADS,
		});
		let decoder = context.decoder().video().map_err(map_err)?;

		Ok(Self {
			path: path.to_path_buf(),
			input,
			decoder,
			stream_index,
			time_base,
			rotation,
			held: None,
			pending: None,
			drained: false,
		})
	}

	fn to_seconds(&self, pts: i64) -> f64 {
		pts as f64 * self.time_base.numerator() as f64 / self.time_base.denominator() as f64
	}

	/// Positions the demuxer at the keyframe at or before `target_seconds` and
	/// clears the decoder.
	fn seek_to(&mut self, target_seconds: f64) -> Result<(), String> {
		let seek_target = (target_seconds.max(0.0) * 1_000_000.0) as i64;
		if self.input.seek(seek_target, ..seek_target).is_err() {
			// A fresh context starts at the head, so a container that refuses to
			// seek still reached the right frame by scanning. A reader kept
			// between requests is wherever the last one left it, so reopening is
			// what restores that.
			self.input = ffmpeg::format::input(&self.path).map_err(map_err)?;
		}
		self.decoder.flush();
		self.held = None;
		self.pending = None;
		self.drained = false;
		Ok(())
	}

	/// The frame covering `target_seconds` — the last one starting at or before
	/// it, which is the picture a player shows at that time.
	pub fn frame_at(&mut self, target_seconds: f64) -> Result<DecodedFrame, String> {
		let target = target_seconds.max(0.0);

		// Already in hand. Playing forwards asks for times inside the frame it
		// was just given, and a scrub can step less than one frame, so this is
		// the common case and it decodes nothing at all.
		if self.covers(target) {
			return self.packed_held();
		}

		// Otherwise carry on from here when the target is ahead and near enough
		// that decoding to it beats seeking; a target behind the cursor, or far
		// ahead of it, starts again from the nearest keyframe.
		let can_advance = self
			.held
			.as_ref()
			.map(|(at, _)| *at)
			.or(self.pending.as_ref().map(|(at, _)| *at))
			.is_some_and(|at| target >= at - PTS_EPSILON && target - at <= MAX_RESUME_SECONDS);
		if !can_advance {
			self.seek_to(target)?;
		}

		self.advance_to(target)?;
		if self.held.is_none() {
			return Err(format!(
				"no decodable frame at {target:.3}s in {}",
				self.path.display()
			));
		}
		self.packed_held()
	}

	/// Whether the frame in hand is the one shown at `target`: it starts at or
	/// before it, and the frame after it starts later.
	fn covers(&self, target: f64) -> bool {
		let Some((held, _)) = &self.held else {
			return false;
		};
		if *held > target + PTS_EPSILON {
			return false;
		}
		match &self.pending {
			Some((next, _)) => target + PTS_EPSILON < *next,
			// Nothing after it because the stream ran out: the last picture is
			// what is shown from there on, which is what a player does at the
			// end of a clip.
			None => self.drained,
		}
	}

	fn packed_held(&self) -> Result<DecodedFrame, String> {
		let Some((pts, frame)) = &self.held else {
			return Err("no frame in hand".to_string());
		};
		// `pending` is the next picture, already decoded, so its start is exactly
		// where this one stops being shown. `-1` says there is no next.
		let next = self.pending.as_ref().map_or(-1.0, |(next, _)| *next);
		self.pack(frame, *pts, next)
	}

	/// Moves the cursor forward until the frame in hand is the one shown at
	/// `target`.
	fn advance_to(&mut self, target: f64) -> Result<(), String> {
		loop {
			// Promote the already-decoded next frame when it belongs at or
			// before the target; that is one step of ordinary playback.
			if let Some((next, _)) = &self.pending {
				if *next <= target + PTS_EPSILON {
					self.held = self.pending.take();
					continue;
				}
				// The next frame is past the target, so whatever is held is the
				// answer — unless nothing is, which means this run began after
				// the target and the pending frame is the closest there is.
				if self.held.is_none() {
					self.held = self.pending.take();
				}
				return Ok(());
			}
			if self.drained {
				return Ok(());
			}
			self.decode_one()?;
		}
	}

	/// Decodes until one more frame is in `pending`, or the stream is drained.
	fn decode_one(&mut self) -> Result<(), String> {
		let mut eof = false;

		loop {
			let packet = {
				let mut packets = self.input.packets();
				loop {
					match packets.next() {
						Some((stream, packet)) if stream.index() == self.stream_index => {
							break Some(packet)
						}
						Some(_) => continue,
						None => break None,
					}
				}
			};

			match packet {
				Some(packet) => {
					if self.decoder.send_packet(&packet).is_err() {
						continue;
					}
				}
				None => {
					// The file ran out. Draining is what produces the final
					// frames of a codec that holds a lookahead, and the last of
					// those is the picture shown at the end of a clip.
					let _ = self.decoder.send_eof();
					eof = true;
				}
			}

			let mut frame = ffmpeg::frame::Video::empty();
			if self.decoder.receive_frame(&mut frame).is_ok() {
				let pts = frame.timestamp().map(|pts| self.to_seconds(pts));
				if let Some(pts) = pts {
					self.pending = Some((pts, frame));
					return Ok(());
				}
				// A frame with no timestamp cannot be placed; keep reading.
				continue;
			}

			if eof {
				// Nothing more will come out. The frame in hand is the last
				// picture in the file.
				self.drained = true;
				return Ok(());
			}
		}
	}

	/// Copies a decoded frame into tightly packed I420 planes.
	///
	/// Two things have to happen here. A decoder's planes carry row padding —
	/// `stride` is not `width` — and `VideoFrame` with a plain buffer expects
	/// none, so every row is copied rather than the plane. And a source that is
	/// not already 8-bit 4:2:0 goes through swscale first, because that is the
	/// one layout the page is built to wrap.
	fn pack(
		&self,
		frame: &ffmpeg::frame::Video,
		pts_seconds: f64,
		next_pts_seconds: f64,
	) -> Result<DecodedFrame, String> {
		let width = frame.width();
		let height = frame.height();

		let converted;
		let source = if frame.format() == ffmpeg::format::Pixel::YUV420P {
			frame
		} else {
			// Built here rather than kept on the reader: `SwsContext` is not
			// `Send`, and holding one would stop the reader from living in the
			// pool at all. The cost lands only on sources that are not already
			// 8-bit 4:2:0 — which H.264 from a camera or an encoder never is —
			// so the path that matters never builds one.
			let mut scaler = ffmpeg::software::scaling::Context::get(
				frame.format(),
				width,
				height,
				ffmpeg::format::Pixel::YUV420P,
				width,
				height,
				// Nothing is being resized, only relaid out, so the cheapest
				// kernel is also the exact one.
				ffmpeg::software::scaling::Flags::POINT,
			)
			.map_err(map_err)?;
			let mut out =
				ffmpeg::frame::Video::new(ffmpeg::format::Pixel::YUV420P, width, height);
			scaler.run(frame, &mut out).map_err(map_err)?;
			converted = out;
			&converted
		};

		// Chroma planes are half size, rounded up, so an odd-sized frame does
		// not lose its last row or column.
		let chroma_width = width.div_ceil(2) as usize;
		let chroma_height = height.div_ceil(2) as usize;
		let sizes = [
			(width as usize, height as usize),
			(chroma_width, chroma_height),
			(chroma_width, chroma_height),
		];

		let mut planes: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
		for (index, (row_bytes, rows)) in sizes.iter().enumerate() {
			let stride = source.stride(index);
			let data = source.data(index);
			let mut packed = Vec::with_capacity(row_bytes * rows);
			for row in 0..*rows {
				let start = row * stride;
				let end = start + row_bytes;
				if end > data.len() {
					// A decoder that reported fewer rows than the geometry
					// implies: pad with mid-grey rather than truncate, so the
					// page's plane lengths still match what the header promised.
					packed.resize(row_bytes * rows, if index == 0 { 0 } else { 128 });
					break;
				}
				packed.extend_from_slice(&data[start..end]);
			}
			planes[index] = packed;
		}

		Ok(DecodedFrame {
			width,
			height,
			rotation: self.rotation,
			pts_seconds,
			next_pts_seconds,
			planes,
		})
	}
}

/// Decodes the single frame shown at `at_seconds` and returns it as I420.
///
/// This is what a seek and a scrub use. Playing forwards stays on the webview's
/// decoder, which is already fast enough per frame and keeps the pixels out of
/// the IPC boundary; see the module docs for the measurements behind that split.
#[tauri::command(async)]
pub fn bluper_decode_video_frame(
	readers: tauri::State<'_, FrameReaders>,
	media_path: String,
	at_seconds: f64,
) -> Result<tauri::ipc::Response, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}

	let reader = readers.checkout(&path, "", || FrameReader::open(&path))?;
	let mut reader = reader
		.lock()
		.map_err(|_| format!("frame reader poisoned for {}", path.display()))?;
	let frame = reader.frame_at(at_seconds)?;
	Ok(tauri::ipc::Response::new(frame.to_bytes()))
}
