//! Smoke test for `media_decode::extract_gop_and_write`.
//!
//! Run with `cargo test -p bluper-desktop --test decode_smoke -- --nocapture`.
//! The test creates a tiny MP4 fixture with ffmpeg (or uses the path passed
//! in `BLUPER_FIXTURE_PATH`), invokes the GOP extraction, and prints what
//! came back.

use std::path::PathBuf;
use std::process::Command;

use bluper_desktop_lib::media_decode::{
	extract_gop_and_write, rotation_from_display_matrix, GopInfo, VideoReader,
};
use bluper_desktop_lib::media_frames::{FrameReader, FRAME_HEADER_BYTES};

fn ensure_fixture() -> PathBuf {
	if let Ok(custom) = std::env::var("BLUPER_FIXTURE_PATH") {
		let p = PathBuf::from(custom);
		if p.exists() {
			return p;
		}
	}
	let fixtures = PathBuf::from("/tmp/bluper-fixtures");
	let _ = std::fs::create_dir_all(&fixtures);
	let path = fixtures.join("sample.mp4");
	if !path.exists() {
		let status = Command::new("ffmpeg")
			.args([
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=2:size=320x240:rate=30",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=2",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
			])
			.arg(&path)
			.status()
			.expect("ffmpeg must be installed to generate the smoke fixture");
		assert!(status.success(), "ffmpeg failed to build fixture");
	}
	path
}

fn ensure_multigop_fixture() -> PathBuf {
	let fixtures = PathBuf::from("/tmp/bluper-fixtures");
	let path = fixtures.join("multigop.mp4");
	if !path.exists() {
		let status = Command::new("ffmpeg")
			.args([
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=duration=10:size=320x240:rate=30",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=10",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				"-g",
				"30",
				"-keyint_min",
				"30",
				"-c:a",
				"aac",
			])
			.arg(&path)
			.status()
			.expect("ffmpeg must be installed to generate the multigop fixture");
		assert!(status.success(), "ffmpeg failed to build multigop fixture");
	}
	path
}

#[test]
fn extracts_first_gop_from_fixture() {
	let fixture = ensure_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-gop.bin");

	let info = extract_gop_and_write(&fixture, &scratch, 0.0).expect("GOP extraction succeeds");

	assert!(!info.chunks.is_empty(), "expected at least one chunk");
	assert!(
		info.chunks[0].is_keyframe,
		"first chunk in a GOP must be a keyframe"
	);
	assert!(
		info.config.coded_width > 0 && info.config.coded_height > 0,
		"codec config must report width and height (got {}x{})",
		info.config.coded_width,
		info.config.coded_height
	);
	assert!(
		!info.config.description_base64.is_empty(),
		"H.264 fixture must carry an avcC extradata"
	);
	assert!(
		info.config.codec.starts_with("avc1."),
		"expected avc1.* codec string, got {}",
		info.config.codec
	);

	let written = std::fs::metadata(&scratch).expect("scratch file exists");
	let total_payload: u64 = info.chunks.iter().map(|c| c.length).sum();
	assert!(
		u64::try_from(written.len()).unwrap() >= total_payload,
		"scratch file size ({}) must be at least the sum of chunk lengths ({})",
		written.len(),
		total_payload
	);

	eprintln!(
		"GOP: codec={} {}x{}, {} chunks, {} bytes total, start_pts={}s, terminal={}",
		info.config.codec,
		info.config.coded_width,
		info.config.coded_height,
		info.chunks.len(),
		total_payload,
		info.start_pts_seconds,
		info.is_terminal
	);
}

#[test]
fn extracts_gop_at_midpoint_lands_on_keyframe() {
	let fixture = ensure_multigop_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-midgop.bin");

	// The fixture has keyframes on every whole second, so 5s is itself one: the
	// GOP that *contains* 5s is the one starting there, not the one before it.
	// Snapping back to 4s would make the decoder chew through a second of
	// interframes it does not need on every seek to a keyframe.
	let info = extract_gop_and_write(&fixture, &scratch, 5.0)
		.expect("GOP extraction at midpoint succeeds");

	assert!(
		!info.is_terminal,
		"GOP at 5s into a 10s file must not be terminal (next keyframe exists)"
	);
	assert!(
		(info.start_pts_seconds - 5.0).abs() < 0.01,
		"GOP must start at the keyframe covering 5s, got {}",
		info.start_pts_seconds
	);
	assert_eq!(
		info.next_gop_start_seconds.map(|next| (next * 100.0).round()),
		Some(600.0),
		"the GOP covering 5s runs up to the keyframe at 6s"
	);
	assert!(
		info.end_pts_seconds > info.start_pts_seconds,
		"GOP must span at least one frame"
	);
	assert!(
		info.chunks[0].is_keyframe,
		"first chunk of a GOP at a midpoint must still be a keyframe"
	);

	eprintln!(
		"Midpoint GOP: start={}s end={}s chunks={} terminal={}",
		info.start_pts_seconds,
		info.end_pts_seconds,
		info.chunks.len(),
		info.is_terminal
	);
}

#[test]
fn extracts_gop_past_file_end_returns_last_gop_terminal() {
	let fixture = ensure_multigop_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-endgop.bin");

	// Asking for the GOP at 99s on a 10s file should return the last GOP
	// (the one starting at 9s) and mark it terminal.
	let info = extract_gop_and_write(&fixture, &scratch, 99.0)
		.expect("GOP extraction past EOF succeeds");

	assert!(
		info.is_terminal,
		"GOP past end of file must be flagged terminal"
	);
	assert!(
		info.start_pts_seconds >= 8.5,
		"GOP past EOF must start at the last keyframe (>=8.5s), got {}",
		info.start_pts_seconds
	);
}

/// The webview walks the file by following `next_gop_start_seconds` from one
/// GOP to the next. If that chain skipped, repeated or looped, playback would
/// respectively drop frames, show them twice, or hang — so this walks the whole
/// fixture the way the webview does and checks the frames come out once each,
/// in order.
#[test]
fn gop_chain_covers_every_frame_exactly_once() {
	let fixture = ensure_multigop_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-chain.bin");

	let mut seen: Vec<f64> = Vec::new();
	let mut start = 0.0_f64;
	let mut gops = 0;

	loop {
		let info =
			extract_gop_and_write(&fixture, &scratch, start).expect("GOP extraction succeeds");
		gops += 1;
		assert!(
			gops <= 64,
			"the GOP chain did not terminate — it is looping over the same GOP"
		);
		assert!(
			info.chunks[0].is_keyframe,
			"every GOP must open on a keyframe"
		);

		for chunk in &info.chunks {
			seen.push(chunk.pts_seconds);
		}

		match info.next_gop_start_seconds {
			Some(next) => {
				assert!(
					next > info.start_pts_seconds,
					"the next GOP must start after this one ({next} <= {})",
					info.start_pts_seconds
				);
				assert!(!info.is_terminal, "a GOP with a successor is not terminal");
				start = next;
			}
			None => {
				assert!(info.is_terminal, "a GOP with no successor is terminal");
				break;
			}
		}
	}

	assert!(gops >= 8, "10s of 1s GOPs should yield ~10 GOPs, got {gops}");

	// 10s at 30fps. Reordered packets mean the list is not sorted as collected,
	// so sort before checking for gaps and duplicates.
	seen.sort_by(|a, b| a.partial_cmp(b).unwrap());
	assert_eq!(seen.len(), 300, "expected every frame in the file exactly once");
	for pair in seen.windows(2) {
		assert!(
			pair[1] - pair[0] > 1e-6,
			"frame at {}s appears twice across the GOP chain",
			pair[0]
		);
	}
}

/// A request that lands inside a GOP rather than on its keyframe must still get
/// the GOP that *contains* it — that is what lets the decoder reach the asked-for
/// time at all.
#[test]
fn gop_at_an_interframe_contains_the_target() {
	let fixture = ensure_multigop_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-contains.bin");

	for target in [0.5_f64, 3.4, 5.9, 7.05] {
		let info =
			extract_gop_and_write(&fixture, &scratch, target).expect("GOP extraction succeeds");
		assert!(
			info.start_pts_seconds <= target + 1e-6,
			"GOP for {target}s starts after it, at {}s",
			info.start_pts_seconds
		);
		if let Some(next) = info.next_gop_start_seconds {
			assert!(
				target < next,
				"GOP for {target}s ends at {next}s, before the target"
			);
		}
	}
}

/// Every GOP request from the webview goes through a reader kept open between
/// calls, so the demuxer arrives at each request wherever the last one left it
/// rather than at the head of the file. A fresh context made the scan that finds
/// the GOP correct for free; a reused one does not, and the failure is not an
/// error — it is a GOP from the wrong part of the file, which decodes into
/// perfectly plausible wrong pictures.
///
/// So this asks one reader for the same targets a fresh open is asked for, in
/// the orders playback and scrubbing actually produce, and requires the answers
/// to be identical.
#[test]
fn a_reused_reader_answers_the_same_gops_as_a_fresh_open() {
	let fixture = ensure_multigop_fixture();
	let scratch = std::env::temp_dir().join("bluper-smoke-reuse.bin");
	let mut reader = VideoReader::open(&fixture).expect("the reader opens");

	fn same(reused: &GopInfo, fresh: &GopInfo, what: &str) {
		assert_eq!(
			reused.start_pts_seconds, fresh.start_pts_seconds,
			"{what}: the reused reader returned a different GOP"
		);
		assert_eq!(
			reused.next_gop_start_seconds, fresh.next_gop_start_seconds,
			"{what}: the reused reader pointed at a different next GOP"
		);
		assert_eq!(
			reused.is_terminal, fresh.is_terminal,
			"{what}: the reused reader disagreed about the end of the file"
		);
		assert_eq!(
			reused.chunks.len(),
			fresh.chunks.len(),
			"{what}: the reused reader returned a different number of frames"
		);
		for (index, (got, want)) in reused.chunks.iter().zip(fresh.chunks.iter()).enumerate() {
			assert_eq!(
				got.pts_seconds, want.pts_seconds,
				"{what}: frame {index} came back at a different time"
			);
			assert_eq!(
				(got.offset, got.length, got.is_keyframe),
				(want.offset, want.length, want.is_keyframe),
				"{what}: frame {index} came back with different bytes behind it"
			);
		}
	}

	// Sequential, which is playback; then backwards and scattered, which is a
	// scrub; then zero last, because a reader positioned at the end of the file
	// being asked for the first GOP is the case a missing seek gets wrong.
	let orders: [&[f64]; 3] = [
		&[0.0, 1.2, 2.4, 3.6, 4.8],
		&[7.5, 2.2, 9.1, 0.4, 5.5],
		&[9.5, 0.0, 9.9, 0.0],
	];

	for targets in orders {
		for &target in targets {
			let (reused, packets) = reader.extract_gop(target).expect("the reused read succeeds");
			let fresh = extract_gop_and_write(&fixture, &scratch, target)
				.expect("the fresh read succeeds");
			same(&reused, &fresh, &format!("target {target}s"));

			// The packets themselves, not just the index over them: an offset
			// table that matches while the bytes behind it do not is the one way
			// this could pass and still decode to garbage.
			let fresh_packets = std::fs::read(&scratch).expect("the fresh GOP file reads");
			assert_eq!(
				packets, fresh_packets,
				"target {target}s: the reused reader returned different packet bytes"
			);
		}
	}
}

/// The chain the webview follows, walked entirely on one reused reader. Covers
/// what the per-request opens covered before: no frame skipped, none twice, and
/// the chain terminates.
#[test]
fn the_gop_chain_on_one_reused_reader_covers_every_frame_once() {
	let fixture = ensure_multigop_fixture();
	let mut reader = VideoReader::open(&fixture).expect("the reader opens");

	let mut seen: Vec<f64> = Vec::new();
	let mut start = 0.0_f64;
	let mut gops = 0;

	loop {
		let (info, _packets) = reader.extract_gop(start).expect("the reused read succeeds");
		gops += 1;
		assert!(gops <= 64, "the GOP chain did not terminate on a reused reader");
		assert!(
			info.chunks[0].is_keyframe,
			"every GOP must open on a keyframe"
		);
		seen.extend(info.chunks.iter().map(|chunk| chunk.pts_seconds));

		match info.next_gop_start_seconds {
			Some(next) => start = next,
			None => break,
		}
	}

	seen.sort_by(|a, b| a.partial_cmp(b).expect("timestamps are finite"));
	assert_eq!(
		seen.len(),
		300,
		"expected every frame in the file exactly once across {gops} GOPs"
	);
	for pair in seen.windows(2) {
		assert!(
			pair[1] - pair[0] > 1e-6,
			"frame at {}s appears twice across the chain on a reused reader",
			pair[0]
		);
	}
}

/// A scrub asks for a run of increasing times, and the reader carries on from
/// where it is rather than seeking back to the keyframe for each one. That is
/// the whole saving, and it is also the way this can go quietly wrong: a reader
/// that resumed from the wrong place returns a real picture from the wrong
/// moment, which looks like the scrub simply being imprecise.
///
/// So every frame a resuming reader returns is compared, byte for byte, against
/// the same frame from a reader that has only ever been asked for it.
#[test]
fn a_resuming_frame_reader_returns_the_same_pictures_as_a_fresh_one() {
	let fixture = ensure_multigop_fixture();
	let mut reader = FrameReader::open(&fixture).expect("the frame reader opens");

	// Forwards in small steps, which is a drag; then backwards, which has to
	// seek; then a jump; then forwards again from there.
	let targets = [
		0.0, 0.2, 0.5, 0.9, 1.4, 2.0, 2.1, 2.2, // a forward drag
		1.0, 0.3, // backwards, which cannot resume
		7.5, 7.6, 7.7, // a jump, then a drag from it
		0.0, 9.5, // the extremes, in the order a missing seek gets wrong
	];

	for target in targets {
		let resumed = reader.frame_at(target).expect("the resuming read succeeds");
		let fresh = FrameReader::open(&fixture)
			.expect("a fresh reader opens")
			.frame_at(target)
			.expect("the fresh read succeeds");

		assert_eq!(
			(resumed.width, resumed.height),
			(fresh.width, fresh.height),
			"the frame at {target}s came back a different size when resumed"
		);
		assert!(
			(resumed.pts_seconds - fresh.pts_seconds).abs() < 1e-9,
			"the frame at {target}s came from {}s when resumed and {}s when fresh",
			resumed.pts_seconds,
			fresh.pts_seconds
		);
		// The pixels, not just the timestamp: two different frames of a moving
		// test pattern share neither, but only this catches a reader that
		// reported the right time for the wrong picture.
		assert_eq!(
			resumed.planes, fresh.planes,
			"the frame at {target}s decoded to different pixels when resumed"
		);
	}
}

/// The frame shown at a time is the last one starting at or before it, which is
/// what a player displays. Asking for a time between two frames must give the
/// earlier one, not the next.
#[test]
fn a_frame_request_lands_on_the_picture_covering_that_time() {
	let fixture = ensure_multigop_fixture();
	let mut reader = FrameReader::open(&fixture).expect("the frame reader opens");

	// 30fps, so frames start every ~33.3ms. A request just before a boundary
	// must still be the earlier frame.
	for (target, expected) in [
		(0.0, 0.0),
		(0.02, 0.0),
		(1.0, 1.0),
		(1.02, 1.0),
		(5.5, 5.5),
	] {
		let frame = reader.frame_at(target).expect("the read succeeds");
		assert!(
			frame.pts_seconds <= target + 1e-6,
			"the frame for {target}s starts after it, at {}s",
			frame.pts_seconds
		);
		assert!(
			(frame.pts_seconds - expected).abs() < 0.034,
			"the frame for {target}s came from {}s, not the frame at {expected}s",
			frame.pts_seconds
		);
	}
}

/// A request past the end has to answer with the last picture rather than
/// failing: a clip's span comes from the container's declared duration, which
/// routinely runs past the final frame, so the playhead asks for this on the way
/// out of every clip.
#[test]
fn a_frame_past_the_end_returns_the_last_picture() {
	let fixture = ensure_multigop_fixture();
	let mut reader = FrameReader::open(&fixture).expect("the frame reader opens");

	let last = reader.frame_at(9.99).expect("a read near the end succeeds");
	let past = reader.frame_at(99.0).expect("a read past the end succeeds");
	assert!(
		past.pts_seconds >= last.pts_seconds - 1e-9,
		"a request past the end went backwards, to {}s",
		past.pts_seconds
	);
	assert!(
		past.pts_seconds < 10.0,
		"a request past the end invented a frame at {}s",
		past.pts_seconds
	);
}

/// The wire format the page reads by offset: geometry, three plane lengths,
/// rotation, timestamp, then the planes. Sizes have to agree with the geometry
/// or the page builds a `VideoFrame` over the wrong bytes.
#[test]
fn the_frame_wire_format_describes_its_own_planes() {
	let fixture = ensure_multigop_fixture();
	let frame = FrameReader::open(&fixture)
		.expect("the frame reader opens")
		.frame_at(1.0)
		.expect("the read succeeds");
	let bytes = frame.to_bytes();

	let u32_at = |offset: usize| {
		u32::from_le_bytes([
			bytes[offset],
			bytes[offset + 1],
			bytes[offset + 2],
			bytes[offset + 3],
		])
	};
	let width = u32_at(0) as usize;
	let height = u32_at(4) as usize;
	let plane_sizes = [u32_at(8) as usize, u32_at(12) as usize, u32_at(16) as usize];
	let rotation = i32::from_le_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
	let pts = f64::from_le_bytes(bytes[24..32].try_into().expect("8 bytes"));
	let next = f64::from_le_bytes(bytes[32..40].try_into().expect("8 bytes"));

	assert_eq!(width, frame.width as usize);
	assert_eq!(height, frame.height as usize);
	assert_eq!(rotation, frame.rotation);
	assert!((pts - frame.pts_seconds).abs() < 1e-9);
	// The next frame's start is how long this one is on screen; the container
	// never says, so a consumer that had to guess would hold frames too long or
	// drop them early.
	assert!(
		next > pts,
		"the next frame starts at {next}s, which is not after {pts}s"
	);
	assert!(
		next - pts < 0.2,
		"a 30fps fixture reported a {}s frame",
		next - pts
	);

	// I420: a full-size luma plane and two half-size chroma planes, tightly
	// packed — no row padding, which is what a plain `VideoFrame` buffer needs.
	let chroma = width.div_ceil(2) * height.div_ceil(2);
	assert_eq!(plane_sizes[0], width * height, "luma plane is not w*h");
	assert_eq!(plane_sizes[1], chroma, "U plane is not a quarter of luma");
	assert_eq!(plane_sizes[2], chroma, "V plane is not a quarter of luma");
	assert_eq!(
		bytes.len(),
		FRAME_HEADER_BYTES + plane_sizes.iter().sum::<usize>(),
		"the response is not its header plus exactly its three planes"
	);
}

/// `av_display_rotation_get` reimplemented — worth pinning, because getting the
/// sign wrong turns a portrait clip 180° from where it belongs and nothing else
/// in the pipeline would notice.
#[test]
fn display_matrix_yields_clockwise_rotation() {
	// 16.16 fixed point, row-major, as stored in an MP4 `tkhd`.
	fn matrix(cells: [i32; 9]) -> Vec<u8> {
		cells.iter().flat_map(|c| c.to_le_bytes()).collect()
	}
	const ONE: i32 = 1 << 16;

	let identity = matrix([ONE, 0, 0, 0, ONE, 0, 0, 0, 1 << 30]);
	assert_eq!(rotation_from_display_matrix(&identity), 0);

	// What a portrait phone clip carries: mediabunny reads this same matrix out
	// of `tkhd` and calls it 90, so this side has to agree.
	let clockwise_90 = matrix([0, ONE, 0, -ONE, 0, 0, 0, 0, 1 << 30]);
	assert_eq!(rotation_from_display_matrix(&clockwise_90), 90);

	let clockwise_270 = matrix([0, -ONE, 0, ONE, 0, 0, 0, 0, 1 << 30]);
	assert_eq!(rotation_from_display_matrix(&clockwise_270), 270);

	let upside_down = matrix([-ONE, 0, 0, 0, -ONE, 0, 0, 0, 1 << 30]);
	assert_eq!(rotation_from_display_matrix(&upside_down), 180);

	// Too short to be a display matrix, and a degenerate one: neither may panic.
	assert_eq!(rotation_from_display_matrix(&[0u8; 8]), 0);
	assert_eq!(rotation_from_display_matrix(&matrix([0; 9])), 0);
}
