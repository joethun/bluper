//! Video demux — read encoded video packets out of a media file and hand them
//! to the webview as per-GOP scratch files the JS side feeds into WebCodecs.
//!
//! The Rust side owns container parsing so the webview never has to ship
//! mediabunny's demuxer. The codec itself still runs in the browser through
//! `VideoDecoder` — `ffmpeg-next` here only walks the bitstream and emits
//! chunks; no pixel data crosses back to Rust.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ffmpeg_next as ffmpeg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::media_readers::{ensure_ffmpeg, ReaderPool};
use crate::native_fs;

/// Presentation timestamps are floating point seconds converted from integer
/// ticks, so equality comparisons need a tolerance. One microsecond is finer
/// than any container's time base and coarser than the conversion error.
const PTS_EPSILON: f64 = 1e-6;

/// Per-frame metadata the webview needs to reconstruct an `EncodedVideoChunk`.
/// The bytes themselves live in the GOP file at `scratch_path`; this struct
/// only names offsets so the webview can `slice` without copying.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInfo {
	pub offset: u64,
	pub length: u64,
	/// Presentation timestamp in seconds. Multiply by `1_000_000` for
	/// `EncodedVideoChunk.timestamp`, which is in microseconds.
	pub pts_seconds: f64,
	pub is_keyframe: bool,
}

/// Codec configuration the webview hands to `new VideoDecoder({ ... })`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoConfig {
	/// Codec string for `VideoDecoder.configure({ codec })`, e.g. `"avc1.42E01E"`,
	/// `"hvc1.1.6.L93.B0"`, `"vp09.00.10.08"`, `"av01.0.04M.08"`.
	pub codec: String,
	pub coded_width: u32,
	pub coded_height: u32,
	/// CodecPrivate data (`avcC`, `hvcC`, `vpcC`, `av1C`) base64-encoded so it
	/// crosses the IPC boundary as a `String`. The webview decodes and hands
	/// it to `description` on the decoder config. Empty for Annex-B streams,
	/// which carry their parameter sets inline and must be configured
	/// *without* a description.
	pub description_base64: String,
	/// Clockwise display rotation in degrees (0, 90, 180 or 270), read from the
	/// container's display matrix. WebCodecs hands back unrotated frames, so
	/// the webview has to apply this itself — without it a portrait phone clip
	/// composites on its side.
	#[serde(default)]
	pub rotation: i32,
}

/// What the command returns. `scratch_path` points at a binary file holding
/// the GOP packets concatenated in order; `chunks` indexes them.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GopInfo {
	pub config: VideoConfig,
	pub chunks: Vec<ChunkInfo>,
	pub scratch_path: String,
	/// PTS the first chunk in this GOP starts at. Useful for the webview to
	/// double-check it asked the demuxer for what it got.
	pub start_pts_seconds: f64,
	/// PTS the last chunk in this GOP ends at.
	pub end_pts_seconds: f64,
	/// PTS of the keyframe that ends this GOP, i.e. where the webview should
	/// ask for the next one. `None` when this GOP runs to the end of the file.
	///
	/// The webview cannot derive this from `end_pts_seconds`: that is the last
	/// frame's *start*, and asking for it again would land back inside this
	/// same GOP and loop forever.
	#[serde(default)]
	pub next_gop_start_seconds: Option<f64>,
	/// True when the GOP returned is the last one in the file. The webview's
	/// seek window can stop one GOP past the user's drop-frame.
	pub is_terminal: bool,
}

impl GopInfo {
	/// Whether this GOP is the one that should be played at `target_seconds`.
	/// A cached GOP file is named after a coarse bucket of the requested time,
	/// so two requests inside one bucket can straddle a keyframe and want
	/// different GOPs; this is the check that catches it.
	fn covers(&self, target_seconds: f64) -> bool {
		if self.start_pts_seconds > target_seconds + PTS_EPSILON {
			return false;
		}
		match self.next_gop_start_seconds {
			Some(next) => target_seconds + PTS_EPSILON < next,
			None => true,
		}
	}
}

/// How many demuxed GOPs to remember. An entry holds one `Vec<ChunkInfo>` —
/// three numbers and a flag per frame — and not the packets, which stay in the
/// bin file, so sixty-four of them is kilobytes rather than the megabytes the
/// bins themselves are.
const GOP_INDEX_CAPACITY: usize = 64;

/// How many speculative demuxes may be in flight at once.
///
/// Two: one for the GOP after the one being played, and slack for a second file
/// when the playhead is crossing a cut. More than that stops being a read-ahead
/// and starts competing with the request the user is waiting on.
const MAX_PREFETCH_IN_FLIGHT: usize = 2;

/// A GOP demuxed this session, and the file its packets went to.
struct CachedGop {
	hash: String,
	info: GopInfo,
	bin_path: PathBuf,
	/// Which write to `bin_path` this entry describes.
	///
	/// A bin file is named after a 100ms bucket of the *requested* time, so two
	/// requests inside one bucket that straddle a keyframe want different GOPs
	/// and the second demux writes over the first's file. Without this counter an
	/// entry could be served with its own chunk offsets against another GOP's
	/// bytes, which decodes to garbage rather than to a miss.
	generation: u64,
}

#[derive(Default)]
struct CacheInner {
	/// Least recently used first, so eviction takes from the front.
	gops: Vec<CachedGop>,
	/// Times each bin path has been written this session.
	generations: HashMap<PathBuf, u64>,
	/// Speculative demuxes in flight, keyed `{hash}:{bucket}`.
	prefetching: HashSet<String>,
}

/// What has been demuxed this session, indexed by the interval each GOP covers.
///
/// The webview asks for a GOP by a *time*, and the bin file is named after a
/// 100ms bucket of that time. That is a fine file name and a poor cache key:
/// dragging the playhead through one GOP touches every bucket it spans, and each
/// of those missed, re-walked the same packets and rewrote the same file. On the
/// user's own media a GOP is 11MB and 1,225 frames, so a scrub across one clip
/// was tens of megabytes of rewrites for packets the step before it had.
///
/// Keyed by what a GOP *covers*, every request landing anywhere inside one is a
/// hit that costs a lock and a scan.
#[derive(Default)]
pub struct DecodeCache {
	inner: Mutex<CacheInner>,
}

impl DecodeCache {
	/// The remembered GOP covering `target_seconds`, if its bin file still holds
	/// the bytes this entry was filed against.
	fn covering(&self, hash: &str, target_seconds: f64) -> Option<GopInfo> {
		let mut inner = self.inner.lock().ok()?;
		let index = inner.gops.iter().position(|entry| {
			entry.hash == hash
				&& entry.info.covers(target_seconds)
				&& inner.generations.get(&entry.bin_path) == Some(&entry.generation)
		})?;
		// Promoted to most recently used: the GOP being played is the one worth
		// keeping when the index fills.
		let entry = inner.gops.remove(index);
		let info = entry.info.clone();
		inner.gops.push(entry);
		Some(info)
	}

	/// Remembers a freshly demuxed GOP, and records that its bin file has been
	/// written once more.
	fn file(&self, hash: &str, bin_path: PathBuf, info: &GopInfo) {
		let Ok(mut inner) = self.inner.lock() else {
			return;
		};
		let generation = inner
			.generations
			.entry(bin_path.clone())
			.and_modify(|count| *count += 1)
			.or_insert(1)
			.to_owned();
		// Anything else filed against this bin file describes bytes that have
		// just been overwritten. The generation check would catch them; dropping
		// them keeps the index from filling with entries that can never hit.
		inner.gops.retain(|entry| entry.bin_path != bin_path);
		inner.gops.push(CachedGop {
			hash: hash.to_string(),
			info: info.clone(),
			bin_path,
			generation,
		});
		while inner.gops.len() > GOP_INDEX_CAPACITY {
			inner.gops.remove(0);
		}
		prune_generations(&mut inner);
	}

	/// Claims the right to prefetch `key`, or answers false because it is
	/// already in flight or the read-ahead is at its limit.
	fn begin_prefetch(&self, key: &str) -> bool {
		let Ok(mut inner) = self.inner.lock() else {
			return false;
		};
		if inner.prefetching.len() >= MAX_PREFETCH_IN_FLIGHT
			|| inner.prefetching.contains(key)
		{
			return false;
		}
		inner.prefetching.insert(key.to_string());
		true
	}

	/// Whether this GOP was reached by following the chain from one already
	/// demuxed, which is what tells playback apart from scrubbing.
	///
	/// The webview walks a clip by asking for `next_gop_start_seconds`, so a
	/// request whose GOP is the successor of one already in the index arrived
	/// there by playing forwards. A scrub instead asks for wherever the pointer
	/// went, and its successor is the GOP the user is *least* likely to want
	/// next — reading ahead of it would write megabytes nobody reads and hold
	/// the reader lock the next jump is waiting on.
	///
	/// A scrub that happens to land next to somewhere it has already been reads
	/// ahead once for nothing. That is the cheap direction to be wrong in.
	fn is_chain_follow(&self, hash: &str, info: &GopInfo) -> bool {
		let Ok(inner) = self.inner.lock() else {
			return false;
		};
		inner.gops.iter().any(|entry| {
			entry.hash == hash
				&& entry
					.info
					.next_gop_start_seconds
					.is_some_and(|next| (next - info.start_pts_seconds).abs() <= PTS_EPSILON)
		})
	}

	fn end_prefetch(&self, key: &str) {
		if let Ok(mut inner) = self.inner.lock() {
			inner.prefetching.remove(key);
		}
	}

	fn forget(&self, hash: &str) {
		let Ok(mut inner) = self.inner.lock() else {
			return;
		};
		inner.gops.retain(|entry| entry.hash != hash);
		let prefix = format!("{hash}:");
		inner.prefetching.retain(|key| !key.starts_with(&prefix));
		prune_generations(&mut inner);
	}
}

/// Drops write counts for bin files no entry refers to any more.
///
/// Without this the map keeps one entry per 100ms bucket the session has ever
/// touched, which for an hour of scrubbing across a few clips is tens of
/// thousands of paths held for nothing. Bounding it by the index instead is safe
/// precisely because nothing refers to those paths: a count that restarts at one
/// cannot be matched by an entry, because there is no entry left to match it.
fn prune_generations(inner: &mut CacheInner) {
	let live: HashSet<&PathBuf> = inner.gops.iter().map(|entry| &entry.bin_path).collect();
	let stale: Vec<PathBuf> = inner
		.generations
		.keys()
		.filter(|path| !live.contains(path))
		.cloned()
		.collect();
	for path in stale {
		inner.generations.remove(&path);
	}
}

fn map_err<E: std::fmt::Display>(err: E) -> String {
	err.to_string()
}

/// Hashes the absolute media path to a 16-hex string. `DefaultHasher` is fine
/// here — collisions just cause a wasted GOP rewrite on seek, not data loss.
fn path_hash(path: &Path) -> String {
	let mut hasher = DefaultHasher::new();
	path.hash(&mut hasher);
	format!("{:016x}", hasher.finish())
}

/// Rounds a target PTS down to the nearest 100ms so a window of consecutive
/// seeks collapses to the same GOP file. Two targets in one bucket that turn
/// out to want different GOPs are caught by [`GopInfo::covers`] and re-demuxed
/// over the same file.
fn gop_key_for_target(target_seconds: f64) -> i64 {
	(target_seconds * 10.0).floor() as i64
}

fn decode_cache_dir<R: Runtime>(app: &AppHandle<R>, hash: &str) -> Result<PathBuf, String> {
	let dir = native_fs::app_cache_dir(app)
		.map_err(map_err)?
		.join("decode")
		.join(hash);
	fs::create_dir_all(&dir).map_err(map_err)?;
	Ok(dir)
}

/// Builds the codec string `VideoDecoder.configure` needs.
///
/// Every one of these codecs encodes its profile, level and bit depth in the
/// *codec string*, not just in the description — `"avc1"` on its own is
/// rejected. The authoritative source for those fields is the container's
/// codec-private blob (`avcC` / `hvcC` / `vpcC` / `av1C`), which is why they
/// are parsed here rather than read off `AVCodecParameters`: ffmpeg folds
/// constraint flags into `profile` in its own encoding, so reconstructing the
/// string from it gets H.264 constrained-baseline wrong.
fn codec_string(
	codec_id: ffmpeg::codec::Id,
	parameters: &ffmpeg::ffi::AVCodecParameters,
	extradata: &[u8],
) -> String {
	use ffmpeg::codec::Id;
	match codec_id {
		Id::H264 => {
			if extradata.len() >= 4 && extradata[0] == 1 {
				// avcC: [1] profile_idc, [2] constraint flags, [3] level_idc.
				format!(
					"avc1.{:02X}{:02X}{:02X}",
					extradata[1], extradata[2], extradata[3]
				)
			} else {
				// Annex-B (MPEG-TS and raw streams) carries no avcC. Fall back
				// to the stream parameters; the constraint byte is unknown, so
				// it goes out as zero.
				format!(
					"avc1.{:02X}00{:02X}",
					parameters.profile.max(0) as u8,
					parameters.level.max(0) as u8
				)
			}
		}
		Id::HEVC => hevc_codec_string(parameters, extradata),
		Id::VP9 => {
			if extradata.len() >= 7 {
				// vpcC: [4] profile, [5] level, [6] bitDepth in the high nibble.
				format!(
					"vp09.{:02}.{:02}.{:02}",
					extradata[4],
					extradata[5],
					extradata[6] >> 4
				)
			} else {
				// WebM routinely omits vpcC. Profile 0 / level 1.0 / 8-bit is
				// the 4:2:0 baseline every VP9 decoder accepts, and the browser
				// reads the real values out of the bitstream anyway.
				"vp09.00.10.08".to_string()
			}
		}
		Id::AV1 => {
			if extradata.len() >= 3 {
				// av1C: [1] seq_profile<<5 | seq_level_idx_0,
				//       [2] seq_tier<<7 | high_bitdepth<<6 | twelve_bit<<5 | ...
				let profile = extradata[1] >> 5;
				let level = extradata[1] & 0x1f;
				let tier = if extradata[2] >> 7 == 1 { "H" } else { "M" };
				let depth = if (extradata[2] >> 5) & 1 == 1 {
					12
				} else if (extradata[2] >> 6) & 1 == 1 {
					10
				} else {
					8
				};
				format!("av01.{}.{:02}{}.{:02}", profile, level, tier, depth)
			} else {
				"av01.0.04M.08".to_string()
			}
		}
		Id::VP8 => "vp8".to_string(),
		Id::MPEG2VIDEO => "mp2v".to_string(),
		Id::MPEG4 => "mp4v".to_string(),
		other => format!("{:?}", other).to_lowercase(),
	}
}

/// `hvc1.{space}{profile}.{compat}.{tier}{level}[.{constraints}]`, per
/// ISO/IEC 14496-15 Annex E. The compatibility flags go out bit-reversed —
/// that is what the spec asks for, not an accident of endianness.
fn hevc_codec_string(
	parameters: &ffmpeg::ffi::AVCodecParameters,
	extradata: &[u8],
) -> String {
	if extradata.len() < 13 || extradata[0] != 1 {
		let raw = parameters.profile.max(0) as u8;
		let tier = if raw & 0x80 != 0 { 'H' } else { 'L' };
		return format!(
			"hvc1.{}.0.{}{}",
			raw & 0x7f,
			tier,
			parameters.level.max(0) as u8
		);
	}

	let profile_space = match extradata[1] >> 6 {
		1 => "A",
		2 => "B",
		3 => "C",
		_ => "",
	};
	let tier = if (extradata[1] >> 5) & 1 == 1 { "H" } else { "L" };
	let profile_idc = extradata[1] & 0x1f;
	let compatibility =
		u32::from_be_bytes([extradata[2], extradata[3], extradata[4], extradata[5]])
			.reverse_bits();
	let level = extradata[12];

	let mut out = format!(
		"hvc1.{}{}.{:X}.{}{}",
		profile_space, profile_idc, compatibility, tier, level
	);

	// The six constraint bytes are emitted as dot-separated hex, with trailing
	// zero bytes dropped — a fully unconstrained stream contributes nothing.
	let mut end = 12;
	while end > 6 && extradata[end - 1] == 0 {
		end -= 1;
	}
	for byte in &extradata[6..end] {
		out.push_str(&format!(".{:X}", byte));
	}
	out
}

/// Reads the codec extradata out of `AVCodecParameters` via raw pointer
/// access. `ffmpeg-next` doesn't expose a high-level getter; the bindgen
/// struct is in scope through `ffmpeg_next::ffi`.
fn read_extradata(parameters: &ffmpeg::ffi::AVCodecParameters) -> Vec<u8> {
	if parameters.extradata.is_null() || parameters.extradata_size <= 0 {
		return Vec::new();
	}
	let len = parameters.extradata_size as usize;
	let slice = unsafe { std::slice::from_raw_parts(parameters.extradata, len) };
	slice.to_vec()
}

/// Reads width and height from `AVCodecParameters`. Both fields are i32 in
/// the bindgen struct; we clamp to 0 if a malformed container reports a
/// negative.
fn read_dimensions(parameters: &ffmpeg::ffi::AVCodecParameters) -> (u32, u32) {
	(parameters.width.max(0) as u32, parameters.height.max(0) as u32)
}

/// Display rotation in degrees, from the stream's display matrix, in the same
/// convention mediabunny reports: the clockwise angle to turn the decoded frame
/// by before showing it.
///
/// This is `av_display_rotation_get` reimplemented — `ffmpeg-next` binds the
/// side-data list but not the helper. ffmpeg documents its result as
/// counter-clockwise, but the value it computes is `atan2(m[1], m[0])`, which is
/// exactly what mediabunny's demuxer reads out of `tkhd` and calls clockwise. The
/// two agree on the number, so no sign flip belongs here — adding one would turn
/// every portrait clip 180 degrees away from where mediabunny puts it.
pub fn rotation_from_display_matrix(data: &[u8]) -> i32 {
	if data.len() < 36 {
		return 0;
	}
	let cell = |index: usize| -> f64 {
		let start = index * 4;
		i32::from_le_bytes([
			data[start],
			data[start + 1],
			data[start + 2],
			data[start + 3],
		]) as f64
	};

	// Divide each column through by its own scale so a matrix that also flips
	// or scales still yields the right angle.
	let scale_x = cell(0).hypot(cell(3));
	let scale_y = cell(1).hypot(cell(4));
	if scale_x == 0.0 || scale_y == 0.0 {
		return 0;
	}

	let clockwise = (cell(1) / scale_y).atan2(cell(0) / scale_x).to_degrees();
	match (clockwise.round() as i64).rem_euclid(360) {
		90 => 90,
		180 => 180,
		270 => 270,
		_ => 0,
	}
}

/// Display rotation for a stream, for callers outside this module that build
/// their own decoder over the same file.
pub fn stream_rotation(stream: &ffmpeg::format::stream::Stream) -> i32 {
	read_rotation(stream)
}

fn read_rotation(stream: &ffmpeg::format::stream::Stream) -> i32 {
	use ffmpeg::codec::packet::side_data::Type;
	for side in stream.side_data() {
		if side.kind() == Type::DisplayMatrix {
			return rotation_from_display_matrix(side.data());
		}
	}
	0
}

/// An open container plus everything its header settles, so answering a GOP
/// request is a seek and a walk.
///
/// The config is built once rather than per request: deriving it parses the
/// codec-private blob and base64-encodes it, and none of that changes between
/// GOPs of the same file.
pub struct VideoReader {
	path: PathBuf,
	input: ffmpeg::format::context::Input,
	stream_index: usize,
	time_base: ffmpeg::Rational,
	config: VideoConfig,
}

impl VideoReader {
	pub fn open(path: &Path) -> Result<Self, String> {
		ensure_ffmpeg()?;
		let input = ffmpeg::format::input(path).map_err(map_err)?;
		let (stream_index, time_base, config) = {
			let video_stream = input
				.streams()
				.best(ffmpeg::media::Type::Video)
				.ok_or_else(|| "no video stream in input".to_string())?;
			let codec_id = video_stream.parameters().id();
			let codec_params = video_stream.parameters();
			let params_ref = unsafe { codec_params.as_ptr().as_ref() }
				.ok_or_else(|| "codec parameters unavailable".to_string())?;

			let extradata = read_extradata(params_ref);
			let (coded_width, coded_height) = read_dimensions(params_ref);
			let description_base64 = if extradata.is_empty() {
				String::new()
			} else {
				use base64::{engine::general_purpose::STANDARD, Engine as _};
				STANDARD.encode(&extradata)
			};

			(
				video_stream.index(),
				video_stream.time_base(),
				VideoConfig {
					codec: codec_string(codec_id, params_ref, &extradata),
					coded_width,
					coded_height,
					description_base64,
					rotation: read_rotation(&video_stream),
				},
			)
		};

		if time_base.denominator() == 0 {
			return Err(format!(
				"video stream has no usable time base in {}",
				path.display()
			));
		}

		Ok(Self {
			path: path.to_path_buf(),
			input,
			stream_index,
			time_base,
			config,
		})
	}

	/// Positions the demuxer at the keyframe at or before `target_seconds`.
	///
	/// `avformat_seek_file` gets there without walking the file: `ffmpeg-next`'s
	/// `seek` hardcodes `flags = 0`, but it passes the caller's range through as
	/// `min_ts`/`max_ts`, and a range ending at the target already means "the
	/// closest keyframe at or before this".
	///
	/// A container that refuses the seek is the reason this reopens rather than
	/// shrugging. Reading from a *fresh* context starts at the head, so the scan
	/// that follows still found the right GOP — which is why the old
	/// open-per-request code could ignore the result. A reader kept between calls
	/// is instead wherever the last request left it, and scanning on from there
	/// would answer with a GOP from the wrong part of the file. Reopening
	/// restores the head that the scan's correctness rests on.
	fn seek_to(&mut self, target_seconds: f64) -> Result<(), String> {
		// `avformat_seek_file` takes microseconds when the stream index is -1,
		// which is what `ffmpeg-next` passes. The range's upper bound becomes
		// `max_ts`, which ffmpeg reads inclusively — `..target` is therefore "the
		// closest keyframe at or before the target", not one strictly before it.
		let seek_target = (target_seconds.max(0.0) * 1_000_000.0) as i64;
		if self.input.seek(seek_target, ..seek_target).is_ok() {
			return Ok(());
		}
		self.input = ffmpeg::format::input(&self.path).map_err(map_err)?;
		Ok(())
	}

	/// Demuxes the GOP containing `target_seconds`, returning its index and the
	/// encoded packets in decode order — no transcoding, no pixels.
	///
	/// "GOP" here means "the keyframe at or before the target, plus all
	/// interframes up to but not including the next keyframe" — the smallest run
	/// of packets a `VideoDecoder` can be handed cold and still produce a correct
	/// picture at the target.
	pub fn extract_gop(&mut self, target_seconds: f64) -> Result<(GopInfo, Vec<u8>), String> {
		self.seek_to(target_seconds)?;

		let mut chunks: Vec<ChunkInfo> = Vec::new();
		let mut buffer: Vec<u8> = Vec::new();
		let mut start_pts: Option<f64> = None;
		let mut end_pts = 0.0_f64;
		let mut next_gop_start: Option<f64> = None;

		let stream_index = self.stream_index;
		let time_base = self.time_base;
		let to_seconds = |pts: i64| -> f64 {
			pts as f64 * time_base.numerator() as f64 / time_base.denominator() as f64
		};

		for (stream, packet) in self.input.packets() {
			if stream.index() != stream_index {
				continue;
			}
			// Packet `time_base` is unreliable after a seek (often 0/1 for MP4), so
			// always convert through the *stream's* time base, which ffmpeg filled
			// in when it parsed the container header.
			let Some(pts) = packet.pts() else {
				continue;
			};
			let pts_seconds = to_seconds(pts);

			if packet.is_key() {
				if start_pts.is_some() {
					if pts_seconds > target_seconds + PTS_EPSILON {
						// The GOP in hand runs up to this keyframe, and the target
						// is inside it. Done.
						next_gop_start = Some(pts_seconds);
						break;
					}
					// The GOP in hand ends before the target — the seek undershot,
					// or the container has no index. Drop it and start again here.
					chunks.clear();
					buffer.clear();
					end_pts = 0.0;
				}
				start_pts = Some(pts_seconds);
			} else if start_pts.is_none() {
				// Packets before the first keyframe cannot be decoded on their own.
				continue;
			}

			let data = packet.data().unwrap_or(&[]);
			chunks.push(ChunkInfo {
				offset: buffer.len() as u64,
				length: data.len() as u64,
				pts_seconds,
				is_keyframe: packet.is_key(),
			});
			buffer.extend_from_slice(data);
			// B-frames arrive out of presentation order, so the last packet read is
			// not necessarily the latest one.
			end_pts = end_pts.max(pts_seconds);
		}

		let Some(start_pts_seconds) = start_pts else {
			return Err(format!(
				"no decodable video packet at or after {target_seconds:.3}s in {}",
				self.path.display()
			));
		};

		Ok((
			GopInfo {
				config: self.config.clone(),
				chunks,
				scratch_path: String::new(), // filled in by the caller
				start_pts_seconds,
				end_pts_seconds: end_pts,
				is_terminal: next_gop_start.is_none(),
				next_gop_start_seconds: next_gop_start,
			},
			buffer,
		))
	}
}

/// Open containers, one per media file, kept between requests.
///
/// See [`crate::media_readers`] for why: on the user's own media, opening the
/// container cost 16ms to 44ms and the GOP walk it was opened for cost 0.3ms to
/// 8ms, so the request the webview blocks on at every GOP boundary was almost
/// entirely re-reading an unchanged header.
pub type VideoReaders = ReaderPool<VideoReader>;

/// Demuxes the GOP containing `target_seconds` and writes its packets to
/// `bin_path`.
///
/// Opens the file for this one call. The commands go through [`VideoReaders`]
/// instead, which is what keeps the header parse off the playback path; this
/// stays for callers that read a file once and are done with it.
pub fn extract_gop_and_write(
	input_path: &Path,
	bin_path: &Path,
	target_seconds: f64,
) -> Result<GopInfo, String> {
	let mut reader = VideoReader::open(input_path)?;
	let (info, packets) = reader.extract_gop(target_seconds)?;
	fs::write(bin_path, &packets).map_err(map_err)?;
	Ok(info)
}

/// Demuxes the GOP covering `start_seconds` onto disk and files it in the
/// index, or answers from the index when it is already there.
///
/// Shared by the command and by the read-ahead, which is the point: a
/// speculative demux has to land in exactly the cache the next real request
/// looks in, or it is work thrown away.
fn gop_covering<R: Runtime>(
	app: &AppHandle<R>,
	cache: &DecodeCache,
	readers: &VideoReaders,
	path: &Path,
	hash: &str,
	start_seconds: f64,
) -> Result<GopInfo, String> {
	if let Some(info) = cache.covering(hash, start_seconds) {
		return Ok(info);
	}

	let gop_index = gop_key_for_target(start_seconds);
	let dir = decode_cache_dir(app, hash)?;
	let bin_path = dir.join(format!("{:016x}.bin", gop_index));
	let meta_path = dir.join(format!("{:016x}.json", gop_index));

	// A GOP left on disk by an earlier session. The sidecar is read rather than
	// the bitstream re-walked, and the result is filed in the index so the next
	// request inside this same GOP does not come back here either.
	if bin_path.exists() && meta_path.exists() {
		if let Ok(bytes) = fs::read(&meta_path) {
			if let Ok(mut info) = serde_json::from_slice::<GopInfo>(&bytes) {
				if info.covers(start_seconds) {
					info.scratch_path = bin_path.to_string_lossy().into_owned();
					cache.file(hash, bin_path, &info);
					return Ok(info);
				}
			}
		}
	}

	let reader = readers.checkout(path, "", || VideoReader::open(path))?;
	let (mut info, packets) = {
		let mut reader = reader
			.lock()
			.map_err(|_| format!("video reader poisoned for {}", path.display()))?;
		reader.extract_gop(start_seconds)?
	};

	info.scratch_path = bin_path.to_string_lossy().into_owned();
	fs::write(&bin_path, &packets).map_err(map_err)?;
	fs::write(&meta_path, serde_json::to_vec(&info).map_err(map_err)?).map_err(map_err)?;
	cache.file(hash, bin_path, &info);
	Ok(info)
}

/// Demuxes the GOP after `info` on a background thread, so the request the
/// webview makes at the GOP boundary finds it already there.
///
/// The webview asks for the next GOP only once it has run out of frames in this
/// one, and that ask blocks playback for as long as the demux and the write
/// take — single-digit milliseconds on a warm reader, but a 1,225-frame GOP is
/// 11MB to write, which is a dropped frame at the boundary. Doing it while the
/// current GOP is still playing takes it off the critical path.
///
/// Nothing waits on this and a failure is not reported: the real request will
/// run the same code and report it then.
fn prefetch_next_gop<R: Runtime>(app: &AppHandle<R>, path: &Path, hash: &str, info: &GopInfo) {
	let Some(next) = info.next_gop_start_seconds else {
		return;
	};

	let cache = app.state::<DecodeCache>();
	// Only for a clip being played through. A scrub's next GOP is the one the
	// user is least likely to ask for, and demuxing it would spend the reader
	// lock and an 11MB write on the request after the one they are waiting for.
	if !cache.is_chain_follow(hash, info) {
		return;
	}
	// Already demuxed, so there is nothing to read ahead to.
	if cache.covering(hash, next).is_some() {
		return;
	}
	let key = format!("{}:{}", hash, gop_key_for_target(next));
	if !cache.begin_prefetch(&key) {
		return;
	}

	let app = app.clone();
	let path = path.to_path_buf();
	let hash = hash.to_string();
	std::thread::spawn(move || {
		let cache = app.state::<DecodeCache>();
		let readers = app.state::<VideoReaders>();
		// Queues on the same reader lock a demand request takes, so a seek
		// arriving mid-read-ahead waits out one GOP walk rather than racing it.
		let _ = gop_covering(&app, &cache, &readers, &path, &hash, next);
		cache.end_prefetch(&key);
	});
}

/// Demuxes the GOP at `start_seconds` and returns metadata for the webview to
/// hand each chunk to `VideoDecoder.decode`.
///
/// `(async)` on a synchronous function is what moves it off Tauri's main
/// thread. Without it a demux of a large GOP stalls the event loop, and the
/// window stops answering while a seek is in flight.
#[tauri::command(async)]
pub fn bluper_decode_video_gop<R: Runtime>(
	app: AppHandle<R>,
	cache: tauri::State<'_, DecodeCache>,
	readers: tauri::State<'_, VideoReaders>,
	media_path: String,
	start_seconds: f64,
) -> Result<GopInfo, String> {
	let path = PathBuf::from(&media_path);
	if !path.exists() {
		return Err(format!("media not found: {media_path}"));
	}

	let hash = path_hash(&path);
	let info = gop_covering(&app, &cache, &readers, &path, &hash, start_seconds)?;
	prefetch_next_gop(&app, &path, &hash, &info);
	Ok(info)
}

/// Drops every cached GOP for `media_path`. The webview calls this on
/// project close so the scratch dir doesn't grow forever across sessions.
#[tauri::command(async)]
pub fn bluper_clear_decode_cache<R: Runtime>(
	app: AppHandle<R>,
	cache: tauri::State<'_, DecodeCache>,
	readers: tauri::State<'_, VideoReaders>,
	media_path: String,
) -> Result<(), String> {
	let path = PathBuf::from(&media_path);
	let hash = path_hash(&path);
	let dir = decode_cache_dir(&app, &hash)?;
	if dir.exists() {
		fs::remove_dir_all(&dir).map_err(map_err)?;
	}
	cache.forget(&hash);
	// The open container goes with the cache: this is called when the source
	// leaves the project, and holding a descriptor on a file nothing refers to
	// any more is what would keep it alive for the rest of the session.
	readers.forget(&path);
	Ok(())
}

/// What a file turned out to hold, read from the container itself.
///
/// Replaces the `mediabunny` probe the page used to run on every import. The
/// kind is reported rather than assumed: an `.mp4` with no video track is an
/// audio file however it is named, and importing it as video would put a clip
/// on the timeline that renders nothing.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
	/// `"video"` or `"audio"`, decided by whether there is a video track.
	pub kind: String,
	pub duration_seconds: f64,
	pub width: Option<u32>,
	pub height: Option<u32>,
	pub fps: Option<f64>,
	pub has_audio: bool,
	/// The codec vocabulary the export panel uses (`avc`, `hevc`, `vp9`, …),
	/// so a re-export can follow the source without a translation table. Null
	/// for a codec outside that vocabulary, which is not an error — the file
	/// still decodes, it just cannot be matched on the way out.
	pub video_codec: Option<String>,
	pub audio_codec: Option<String>,
	/// Container bitrate in bits per second, when it declares one.
	pub bitrate: Option<u64>,
	/// Whether this build has a decoder for the video track. A file that
	/// imports but cannot be previewed is worth saying so about up front.
	pub can_decode_video: bool,
}

/// Maps an ffmpeg codec id onto the short names the export panel and the
/// project settings already speak. Anything outside that vocabulary answers
/// `None` rather than inventing a name.
fn export_codec_name(id: ffmpeg::codec::Id) -> Option<&'static str> {
	use ffmpeg::codec::Id;
	Some(match id {
		Id::H264 => "avc",
		Id::HEVC => "hevc",
		Id::AV1 => "av1",
		Id::VP9 => "vp9",
		Id::VP8 => "vp8",
		Id::PRORES => "prores",
		Id::AAC => "aac",
		Id::OPUS => "opus",
		Id::VORBIS => "vorbis",
		Id::FLAC => "flac",
		Id::MP3 => "mp3",
		Id::PCM_S16LE => "pcm-s16",
		Id::PCM_S24LE => "pcm-s24",
		Id::PCM_F32LE => "pcm-f32",
		_ => return None,
	})
}

/// Reads what a media file holds without decoding any of it.
///
/// Opening a file to read its header is cheap — ffmpeg stops as soon as it has
/// parsed enough — which is why this is the same call the import probe and the
/// export's source-bitrate lookup both make.
#[tauri::command(async)]
pub fn bluper_probe_media(path: String) -> Result<MediaProbe, String> {
	// Same guard as `bluper_decode_video_gop`: the path came from the media
	// store, and a file that is not there is the honest error to report.
	let probe_path = PathBuf::from(&path);
	if !probe_path.exists() {
		return Err(format!("media not found: {path}"));
	}
	let path = probe_path;

	ensure_ffmpeg()?;
	let input = ffmpeg::format::input(&path)
		.map_err(|error| format!("opening {}: {error}", path.display()))?;

	let video = input.streams().best(ffmpeg::media::Type::Video);
	let audio = input.streams().best(ffmpeg::media::Type::Audio);

	// `AV_TIME_BASE` units at the container level, seconds once divided. A
	// stream that declares no duration answers zero rather than a negative
	// sentinel, which is what a caller would otherwise render as a clip of
	// impossible length.
	let duration_seconds = {
		let raw = input.duration();
		if raw > 0 {
			raw as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE)
		} else {
			0.0
		}
	};

	let mut width = None;
	let mut height = None;
	let mut fps = None;
	let mut video_codec = None;
	let mut can_decode_video = false;

	if let Some(stream) = video.as_ref() {
		let parameters = stream.parameters();
		let id = parameters.id();
		video_codec = export_codec_name(id).map(str::to_string);
		can_decode_video = ffmpeg::codec::decoder::find(id).is_some();

		if let Ok(decoder) = ffmpeg::codec::context::Context::from_parameters(parameters)
			.and_then(|context| context.decoder().video())
		{
			width = Some(decoder.width());
			height = Some(decoder.height());
		}

		// `avg_frame_rate` is what the container declares over the whole file,
		// which is the honest answer for a variable-frame-rate source too —
		// `r_frame_rate` reports the finest tick the timebase can express and
		// is routinely nonsense like 1000 fps.
		let rate = stream.avg_frame_rate();
		if rate.denominator() != 0 && rate.numerator() != 0 {
			fps = Some(f64::from(rate.numerator()) / f64::from(rate.denominator()));
		}
	}

	let audio_codec = audio
		.as_ref()
		.and_then(|stream| export_codec_name(stream.parameters().id()))
		.map(str::to_string);

	let bitrate = {
		let raw = input.bit_rate();
		if raw > 0 { Some(raw as u64) } else { None }
	};

	Ok(MediaProbe {
		kind: if video.is_some() { "video" } else { "audio" }.to_string(),
		duration_seconds,
		width,
		height,
		fps,
		has_audio: audio.is_some(),
		video_codec,
		audio_codec,
		bitrate,
		can_decode_video,
	})
}

/// Decodes one frame and returns it as a PNG, base64-encoded for a `data:`
/// URL.
///
/// The thumbnail used to be drawn in the page: decode a frame with WebCodecs,
/// put it on a canvas, read the canvas back. Doing it here means an import
/// never has to open a decoder for a codec the webview might not have, and the
/// bytes that cross are a few kilobytes of PNG rather than a full frame.
///
/// `at_seconds` is a hint. A second in is past the fade most clips open with,
/// but a clip can be shorter than that — a phone burst, a sticker loop — so a
/// seek past the end falls back to the first frame rather than failing.
#[tauri::command(async)]
pub fn bluper_media_thumbnail(
	path: String,
	at_seconds: f64,
	max_edge: u32,
) -> Result<String, String> {
	let probe_path = PathBuf::from(&path);
	if !probe_path.exists() {
		return Err(format!("media not found: {path}"));
	}

	ensure_ffmpeg()?;

	let frame = decode_frame_near(&probe_path, at_seconds)
		.or_else(|_| decode_frame_near(&probe_path, 0.0))?;

	let (width, height) = fit_within(frame.width(), frame.height(), max_edge.max(1));

	let mut scaler = ffmpeg::software::scaling::Context::get(
		frame.format(),
		frame.width(),
		frame.height(),
		ffmpeg::format::Pixel::RGB24,
		width,
		height,
		ffmpeg::software::scaling::Flags::BILINEAR,
	)
	.map_err(|error| format!("creating the thumbnail scaler: {error}"))?;

	let mut rgb = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGB24, width, height);
	scaler
		.run(&frame, &mut rgb)
		.map_err(|error| format!("scaling the thumbnail: {error}"))?;

	let png = encode_png(&rgb, width, height)?;
	Ok(format!(
		"data:image/png;base64,{}",
		base64_encode(&png)
	))
}

/// The largest size fitting inside `max_edge` on both axes, keeping the aspect
/// ratio and never scaling up.
fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
	if width == 0 || height == 0 {
		return (max_edge, max_edge);
	}
	if width <= max_edge && height <= max_edge {
		return (width, height);
	}
	if width >= height {
		let scaled = (height as u64 * max_edge as u64 / width as u64).max(1) as u32;
		(max_edge, scaled)
	} else {
		let scaled = (width as u64 * max_edge as u64 / height as u64).max(1) as u32;
		(scaled, max_edge)
	}
}

/// Decodes the first frame at or after `at_seconds`.
fn decode_frame_near(
	path: &Path,
	at_seconds: f64,
) -> Result<ffmpeg::frame::Video, String> {
	let mut input = ffmpeg::format::input(path)
		.map_err(|error| format!("opening {}: {error}", path.display()))?;
	let stream = input
		.streams()
		.best(ffmpeg::media::Type::Video)
		.ok_or_else(|| "the file has no video track".to_string())?;
	let stream_index = stream.index();
	let time_base = stream.time_base();

	let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
		.and_then(|context| context.decoder().video())
		.map_err(|error| format!("opening the video decoder: {error}"))?;

	if at_seconds > 0.0 {
		let target = (at_seconds / f64::from(time_base)) as i64;
		// A failed seek is not fatal: reading from the start still reaches the
		// frame, it just costs more.
		let _ = input.seek(target, ..target);
	}

	for (packet_stream, packet) in input.packets() {
		if packet_stream.index() != stream_index {
			continue;
		}
		if decoder.send_packet(&packet).is_err() {
			continue;
		}
		let mut frame = ffmpeg::frame::Video::empty();
		if decoder.receive_frame(&mut frame).is_ok() {
			return Ok(frame);
		}
	}

	decoder
		.send_eof()
		.map_err(|error| format!("flushing the decoder: {error}"))?;
	let mut frame = ffmpeg::frame::Video::empty();
	if decoder.receive_frame(&mut frame).is_ok() {
		return Ok(frame);
	}
	Err("no frame could be decoded".to_string())
}

/// Encodes an RGB24 frame as a PNG through ffmpeg's own encoder, so the shell
/// takes no image-codec dependency of its own.
fn encode_png(
	frame: &ffmpeg::frame::Video,
	width: u32,
	height: u32,
) -> Result<Vec<u8>, String> {
	let codec = ffmpeg::codec::encoder::find(ffmpeg::codec::Id::PNG)
		.ok_or_else(|| "this ffmpeg has no PNG encoder".to_string())?;
	let context = ffmpeg::codec::context::Context::new_with_codec(codec);
	let mut encoder = context
		.encoder()
		.video()
		.map_err(|error| format!("opening the PNG encoder: {error}"))?;
	encoder.set_width(width);
	encoder.set_height(height);
	encoder.set_format(ffmpeg::format::Pixel::RGB24);
	encoder.set_time_base(ffmpeg::util::rational::Rational::new(1, 1));
	let mut encoder = encoder
		.open()
		.map_err(|error| format!("opening the PNG encoder: {error}"))?;

	encoder
		.send_frame(frame)
		.map_err(|error| format!("PNG send_frame: {error}"))?;
	encoder
		.send_eof()
		.map_err(|error| format!("PNG send_eof: {error}"))?;

	let mut packet = ffmpeg::packet::Packet::empty();
	if encoder.receive_packet(&mut packet).is_ok() {
		return Ok(packet.data().unwrap_or_default().to_vec());
	}
	Err("the PNG encoder produced nothing".to_string())
}

/// Standard base64. Written out rather than pulled in as a dependency: it is
/// twelve lines, and the alternative is a crate in the shell's tree for one
/// call site.
fn base64_encode(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] =
		b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let b = [
			chunk[0],
			*chunk.get(1).unwrap_or(&0),
			*chunk.get(2).unwrap_or(&0),
		];
		let triple = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
		out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
		out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
		out.push(if chunk.len() > 1 {
			ALPHABET[(triple >> 6) as usize & 63] as char
		} else {
			'='
		});
		out.push(if chunk.len() > 2 {
			ALPHABET[triple as usize & 63] as char
		} else {
			'='
		});
	}
	out
}

#[cfg(test)]
mod cache_tests {
	use super::*;

	fn gop(start: f64, next: Option<f64>) -> GopInfo {
		GopInfo {
			config: VideoConfig {
				codec: "avc1.42E01E".into(),
				coded_width: 320,
				coded_height: 240,
				description_base64: String::new(),
				rotation: 0,
			},
			chunks: vec![ChunkInfo {
				offset: 0,
				length: 16,
				pts_seconds: start,
				is_keyframe: true,
			}],
			scratch_path: String::new(),
			start_pts_seconds: start,
			end_pts_seconds: next.unwrap_or(start + 1.0) - 0.03,
			next_gop_start_seconds: next,
			is_terminal: next.is_none(),
		}
	}

	/// The reason this index is keyed by interval rather than by the requested
	/// time: dragging the playhead through one GOP asks for dozens of times
	/// inside it, and every one of them has to be the same hit.
	#[test]
	fn any_time_inside_a_gop_is_a_hit() {
		let cache = DecodeCache::default();
		cache.file("hash", PathBuf::from("/tmp/a.bin"), &gop(2.0, Some(4.0)));

		for target in [2.0, 2.5, 3.0, 3.999] {
			assert!(
				cache.covering("hash", target).is_some(),
				"{target}s is inside the GOP and should be a hit"
			);
		}
		for target in [1.9, 4.0, 4.5] {
			assert!(
				cache.covering("hash", target).is_none(),
				"{target}s is outside the GOP and must not be answered from it"
			);
		}
		assert!(
			cache.covering("other", 2.5).is_none(),
			"another file's GOP must not answer for this one"
		);
	}

	/// A terminal GOP has no successor, so it covers everything from its start
	/// onwards — the webview asks past the last frame whenever a clip's declared
	/// duration runs a little past its media.
	#[test]
	fn a_terminal_gop_covers_everything_after_it() {
		let cache = DecodeCache::default();
		cache.file("hash", PathBuf::from("/tmp/a.bin"), &gop(9.0, None));

		assert!(cache.covering("hash", 9.5).is_some());
		assert!(cache.covering("hash", 900.0).is_some());
		assert!(cache.covering("hash", 8.9).is_none());
	}

	/// The hazard the generation counter exists for. Two requests inside one
	/// 100ms bucket that straddle a keyframe want different GOPs and share a
	/// file name, so the second demux writes over the first's packets. The first
	/// entry's offsets would then index another GOP's bytes — which decodes into
	/// a picture rather than an error, and is why this is a counter and not a
	/// comment.
	#[test]
	fn an_entry_whose_file_was_overwritten_stops_being_a_hit() {
		let cache = DecodeCache::default();
		let bin = PathBuf::from("/tmp/bucket.bin");

		cache.file("hash", bin.clone(), &gop(1.00, Some(1.08)));
		assert!(
			cache.covering("hash", 1.04).is_some(),
			"the GOP just filed should be a hit"
		);

		// A different GOP lands in the same bucket and rewrites the file.
		cache.file("hash", bin, &gop(1.08, Some(2.0)));
		assert!(
			cache.covering("hash", 1.5).is_some(),
			"the GOP that now owns the file is a hit"
		);
		assert!(
			cache.covering("hash", 1.04).is_none(),
			"the overwritten GOP must be a miss, not stale bytes"
		);
	}

	/// Two GOPs in different buckets coexist — the common case, and the one that
	/// makes playback across a GOP boundary free.
	#[test]
	fn gops_in_separate_files_both_stay_hits() {
		let cache = DecodeCache::default();
		cache.file("hash", PathBuf::from("/tmp/a.bin"), &gop(0.0, Some(1.0)));
		cache.file("hash", PathBuf::from("/tmp/b.bin"), &gop(1.0, Some(2.0)));

		assert!(cache.covering("hash", 0.5).is_some());
		assert!(cache.covering("hash", 1.5).is_some());
	}

	/// Read-ahead fires for a clip being played through and not for one being
	/// scrubbed, and the two are told apart by whether the GOP in hand is the
	/// successor of one already demuxed.
	#[test]
	fn only_a_chain_follow_looks_like_playback() {
		let cache = DecodeCache::default();
		let first = gop(0.0, Some(1.0));
		let second = gop(1.0, Some(2.0));
		let elsewhere = gop(30.0, Some(31.0));

		assert!(
			!cache.is_chain_follow("hash", &first),
			"the first GOP of a clip follows nothing"
		);

		cache.file("hash", PathBuf::from("/tmp/a.bin"), &first);
		assert!(
			cache.is_chain_follow("hash", &second),
			"the GOP after one already demuxed is playback"
		);
		assert!(
			!cache.is_chain_follow("hash", &elsewhere),
			"a GOP nothing points at is a jump"
		);
		assert!(
			!cache.is_chain_follow("other", &second),
			"another file's chain says nothing about this one"
		);
	}

	/// Only one read-ahead per GOP, and never more than the cap — a burst of
	/// requests must not put a thread behind each of them.
	#[test]
	fn prefetch_claims_are_exclusive_and_capped() {
		let cache = DecodeCache::default();

		assert!(cache.begin_prefetch("hash:1"));
		assert!(
			!cache.begin_prefetch("hash:1"),
			"the same GOP must not be read ahead twice at once"
		);
		assert!(cache.begin_prefetch("hash:2"));
		assert!(
			!cache.begin_prefetch("hash:3"),
			"the cap is {MAX_PREFETCH_IN_FLIGHT}"
		);

		cache.end_prefetch("hash:1");
		assert!(
			cache.begin_prefetch("hash:3"),
			"a finished read-ahead frees its slot"
		);
	}

	/// Write counts are kept only for files the index still refers to, so a long
	/// scrub cannot grow this map past the index itself. The check that matters
	/// is the one after: a path whose count was dropped and then reused must not
	/// resurrect an entry filed against the old count.
	#[test]
	fn write_counts_do_not_accumulate_across_a_scrub() {
		let cache = DecodeCache::default();
		for index in 0..GOP_INDEX_CAPACITY * 3 {
			let start = index as f64;
			cache.file(
				"hash",
				PathBuf::from(format!("/tmp/scrub_{index}.bin")),
				&gop(start, Some(start + 1.0)),
			);
		}

		let inner = cache.inner.lock().expect("the cache locks");
		assert!(
			inner.generations.len() <= GOP_INDEX_CAPACITY,
			"{} write counts held for {} entries",
			inner.generations.len(),
			inner.gops.len()
		);
		drop(inner);

		// The evicted end of that run is gone from the index, so its file name is
		// free to be used again — and the entry that used to own it must not come
		// back as a hit when it is.
		cache.file("hash", PathBuf::from("/tmp/scrub_0.bin"), &gop(500.0, Some(501.0)));
		assert!(
			cache.covering("hash", 0.5).is_none(),
			"an evicted entry came back when its file name was reused"
		);
		assert!(
			cache.covering("hash", 500.5).is_some(),
			"the entry that now owns the file is a hit"
		);
	}

	/// A source leaving the project takes its entries with it, so nothing is
	/// answered out of a cache directory that has just been deleted.
	#[test]
	fn forget_drops_one_file_and_leaves_the_others() {
		let cache = DecodeCache::default();
		cache.file("gone", PathBuf::from("/tmp/a.bin"), &gop(0.0, Some(1.0)));
		cache.file("kept", PathBuf::from("/tmp/b.bin"), &gop(0.0, Some(1.0)));
		assert!(cache.begin_prefetch("gone:5"));

		cache.forget("gone");
		assert!(cache.covering("gone", 0.5).is_none());
		assert!(cache.covering("kept", 0.5).is_some());
		assert!(
			cache.begin_prefetch("gone:5"),
			"a forgotten file's read-ahead claim is released with it"
		);
	}

	/// The index is bounded, and what it drops is the least recently asked for
	/// rather than the oldest filed — the GOP being played has to survive a
	/// scrub that filled the index behind it.
	#[test]
	fn eviction_keeps_what_was_asked_for_most_recently() {
		let cache = DecodeCache::default();
		let held = gop(0.0, Some(1.0));
		cache.file("hash", PathBuf::from("/tmp/held.bin"), &held);

		for index in 0..GOP_INDEX_CAPACITY {
			let start = 100.0 + index as f64;
			cache.file(
				"hash",
				PathBuf::from(format!("/tmp/fill_{index}.bin")),
				&gop(start, Some(start + 1.0)),
			);
			// Asking for it again is what keeps it: without this the entry is the
			// oldest and goes first.
			assert!(cache.covering("hash", 0.5).is_some());
		}

		assert!(
			cache.covering("hash", 0.5).is_some(),
			"the GOP being asked for was evicted while it was in use"
		);
	}
}

#[cfg(test)]
mod base64_tests {
	use super::base64_encode;

	#[test]
	fn matches_the_rfc_4648_vectors() {
		// The padding cases are the ones a hand-rolled encoder gets wrong, so
		// every input length modulo three is here.
		assert_eq!(base64_encode(b""), "");
		assert_eq!(base64_encode(b"f"), "Zg==");
		assert_eq!(base64_encode(b"fo"), "Zm8=");
		assert_eq!(base64_encode(b"foo"), "Zm9v");
		assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
		assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
		assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
	}

	#[test]
	fn encodes_bytes_above_the_ascii_range() {
		// A PNG is mostly high bytes; a sign-extension slip shows up here and
		// nowhere in the text vectors above.
		assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
		assert_eq!(base64_encode(&[0x00, 0x80, 0xff]), "AID/");
	}
}
