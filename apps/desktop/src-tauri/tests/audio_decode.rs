//! Tests for `media_audio` — the Rust side of audio decoding.
//!
//! Run with `cargo test -p bluper-desktop --test audio_decode`. Fixtures are
//! built with ffmpeg into `/tmp/bluper-fixtures`, shared with `decode_smoke`.

use std::path::PathBuf;
use std::process::Command;

use bluper_desktop_lib::media_audio::{
	decode_audio_pcm_into, decode_audio_window, open_audio, waveform_segment,
	waveform_segment_from,
};

/// A tone whose amplitude steps every second, so a waveform summary has
/// something to be wrong about: a flat sine would look identical however badly
/// the buckets were placed.
fn ensure_stepped_fixture() -> PathBuf {
	let fixtures = PathBuf::from("/tmp/bluper-fixtures");
	let _ = std::fs::create_dir_all(&fixtures);
	let path = fixtures.join("stepped.wav");
	if !path.exists() {
		// A linear fade in across the whole 10s, so amplitude rises steadily and
		// the peaks have to arrive in the right order to reproduce it. A flat
		// sine would look identical however badly the buckets were placed.
		let status = Command::new("ffmpeg")
			.args([
				"-y",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=10:sample_rate=48000",
				"-af",
				"afade=t=in:st=0:d=10:curve=tri,aformat=channel_layouts=stereo",
				"-c:a",
				"pcm_s16le",
			])
			.arg(&path)
			.status()
			.expect("ffmpeg must be installed to generate the audio fixture");
		assert!(status.success(), "ffmpeg failed to build the audio fixture");
	}
	path
}

fn decode_peaks(base64_peaks: &str) -> Vec<f32> {
	use base64::{engine::general_purpose::STANDARD, Engine as _};
	let bytes = STANDARD.decode(base64_peaks).expect("peaks are valid base64");
	bytes
		.chunks_exact(4)
		.map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
		.collect()
}

const BUCKET_SIZE: u64 = 128;

/// The whole track in one call, as the reference every windowed read is checked
/// against.
fn whole_track_peaks(path: &PathBuf) -> Vec<f32> {
	let segment = waveform_segment(path, 0.0, 0.0, BUCKET_SIZE).expect("summary succeeds");
	assert_eq!(segment.first_bucket, 0, "a full read starts at bucket zero");
	assert!(
		segment.next_start_seconds.is_none(),
		"a full read has nothing after it"
	);
	decode_peaks(&segment.peaks_base64)
}

#[test]
fn summarises_a_whole_track() {
	let fixture = ensure_stepped_fixture();
	let segment = waveform_segment(&fixture, 0.0, 0.0, BUCKET_SIZE).expect("summary succeeds");

	assert_eq!(segment.shape.sample_rate, 48_000);
	assert_eq!(segment.shape.channels, 2);
	assert!(
		(segment.shape.duration_seconds - 10.0).abs() < 0.05,
		"expected a 10s track, got {}",
		segment.shape.duration_seconds
	);

	let peaks = decode_peaks(&segment.peaks_base64);
	let expected = (10.0 * 48_000.0 / BUCKET_SIZE as f64).round() as usize;
	assert!(
		peaks.len().abs_diff(expected) <= 2,
		"expected ~{expected} buckets, got {}",
		peaks.len()
	);
	assert!(
		peaks.iter().all(|p| (0.0..=1.001).contains(p)),
		"every peak must be a normalised amplitude"
	);
	// The fixture ramps from silence to full scale, so the end must be louder
	// than the start — which is what catches peaks landing in the wrong bucket.
	let head = peaks[..peaks.len() / 10].iter().fold(0.0f32, |a, b| a.max(*b));
	let tail = peaks[peaks.len() * 9 / 10..]
		.iter()
		.fold(0.0f32, |a, b| a.max(*b));
	assert!(
		tail > head * 4.0,
		"the ramp is not in the peaks (head {head}, tail {tail})"
	);
}

/// The webview reads a long track a window at a time so the wave can draw as it
/// fills. Those windows have to tile the track exactly: a gap leaves a silent
/// stripe in the middle of the wave, and a misplaced `first_bucket` slides
/// everything after it sideways. Both look plausible, which is why this
/// compares against the single-call read rather than eyeballing the shape.
#[test]
fn windowed_reads_reassemble_into_the_whole_track() {
	let fixture = ensure_stepped_fixture();
	let reference = whole_track_peaks(&fixture);

	let mut assembled = vec![0.0f32; reference.len()];
	let mut start = 0.0_f64;
	let mut windows = 0;

	loop {
		let segment = waveform_segment(&fixture, start, 1.5, BUCKET_SIZE)
			.expect("windowed summary succeeds");
		windows += 1;
		assert!(windows <= 64, "the window chain did not terminate");

		let peaks = decode_peaks(&segment.peaks_base64);
		for (index, peak) in peaks.iter().enumerate() {
			let bucket = segment.first_bucket as usize + index;
			if bucket < assembled.len() {
				assembled[bucket] = assembled[bucket].max(*peak);
			}
		}

		match segment.next_start_seconds {
			Some(next) => {
				assert!(next > start, "window chain stalled at {start}s");
				start = next;
			}
			None => break,
		}
	}

	assert!(windows >= 6, "10s in 1.5s windows should take ~7, got {windows}");

	let mut worst = 0.0f32;
	let mut silent = 0;
	for (bucket, (got, want)) in assembled.iter().zip(reference.iter()).enumerate() {
		if *want > 0.01 && *got == 0.0 {
			silent += 1;
			if silent < 4 {
				eprintln!("bucket {bucket} came back silent, reference {want}");
			}
		}
		worst = worst.max((got - want).abs());
	}

	assert_eq!(silent, 0, "{silent} buckets were never filled by any window");
	assert!(
		worst < 1e-6,
		"windowed peaks differ from the single-call read by {worst}"
	);
}

/// The command reads every window of a track off one pooled reader, which
/// carries a seek position between them and skips the seek when a window begins
/// where the last one ended. That is the cheap path and the one that can be
/// silently wrong: a reader left a little ahead of where it is asked for would
/// fold peaks out of the wrong part of the track, and the result still looks
/// like a waveform. So this reads the track the way the command does and holds
/// it against the same windows read from fresh opens.
#[test]
fn windows_on_one_reused_reader_match_fresh_opens() {
	let fixture = ensure_stepped_fixture();
	let reference = whole_track_peaks(&fixture);

	let mut reader = open_audio(&fixture, None, None).expect("the reader opens");
	let mut assembled = vec![0.0f32; reference.len()];
	let mut start = 0.0_f64;
	let mut windows = 0;

	loop {
		let fresh = waveform_segment(&fixture, start, 1.5, BUCKET_SIZE)
			.expect("a fresh window succeeds");
		let resumed = waveform_segment_from(&mut reader, start, 1.5, BUCKET_SIZE)
			.expect("a resumed window succeeds");
		windows += 1;
		assert!(windows <= 64, "the window chain did not terminate");

		assert_eq!(
			resumed.first_bucket, fresh.first_bucket,
			"window at {start}s landed on a different bucket when resumed"
		);
		assert_eq!(
			decode_peaks(&resumed.peaks_base64),
			decode_peaks(&fresh.peaks_base64),
			"window at {start}s decoded differently when resumed"
		);
		assert_eq!(
			resumed.next_start_seconds, fresh.next_start_seconds,
			"window at {start}s pointed somewhere else when resumed"
		);

		for (index, peak) in decode_peaks(&resumed.peaks_base64).iter().enumerate() {
			let bucket = resumed.first_bucket as usize + index;
			if bucket < assembled.len() {
				assembled[bucket] = assembled[bucket].max(*peak);
			}
		}

		match resumed.next_start_seconds {
			Some(next) => {
				assert!(next > start, "window chain stalled at {start}s");
				start = next;
			}
			None => break,
		}
	}

	assert!(windows >= 6, "10s in 1.5s windows should take ~7, got {windows}");
	let worst = assembled
		.iter()
		.zip(reference.iter())
		.fold(0.0f32, |worst, (got, want)| worst.max((got - want).abs()));
	assert!(
		worst < 1e-6,
		"the track read on one reused reader differs from the single-call read by {worst}"
	);
}

/// Windows asked for out of order on a reused reader have to seek, and the seek
/// has to land — a reader that carried on from wherever it happened to be would
/// answer with peaks from the wrong part of the track. Scrubbing the timeline
/// asks in exactly this pattern.
#[test]
fn out_of_order_windows_on_a_reused_reader_still_seek() {
	let fixture = ensure_stepped_fixture();
	let mut reader = open_audio(&fixture, None, None).expect("the reader opens");

	// Forwards, back past the start of the last read, then a jump: each of these
	// has to invalidate the resume position rather than trust it.
	for start in [6.0_f64, 1.5, 3.0, 0.0, 8.5, 4.5] {
		let fresh =
			waveform_segment(&fixture, start, 1.0, BUCKET_SIZE).expect("a fresh window succeeds");
		let resumed = waveform_segment_from(&mut reader, start, 1.0, BUCKET_SIZE)
			.expect("a seeking window succeeds");
		assert_eq!(
			resumed.first_bucket, fresh.first_bucket,
			"the window at {start}s landed on a different bucket on the reused reader"
		);
		assert_eq!(
			decode_peaks(&resumed.peaks_base64),
			decode_peaks(&fresh.peaks_base64),
			"the window at {start}s came back with different peaks on the reused reader"
		);
	}
}

/// What the header of a window response says, and where its samples start.
struct Window {
	channels: usize,
	sample_rate: u32,
	frames: usize,
	first_seconds: f64,
	planes: Vec<Vec<f32>>,
}

/// Reads the wire format the webview reads: three little-endian `u32`s, an
/// `f64`, then one contiguous run of `f32` per channel. Parsed here by offset
/// exactly as the page does, so a field packed in the wrong order fails here
/// rather than turning into silence in the app.
fn parse_window(bytes: &[u8]) -> Window {
	let u32_at = |offset: usize| {
		u32::from_le_bytes([
			bytes[offset],
			bytes[offset + 1],
			bytes[offset + 2],
			bytes[offset + 3],
		])
	};
	let channels = u32_at(0) as usize;
	let sample_rate = u32_at(4);
	let frames = u32_at(8) as usize;
	let first_seconds = f64::from_le_bytes(bytes[12..20].try_into().expect("8 bytes"));

	let mut planes = Vec::with_capacity(channels);
	let mut offset = 20;
	for _ in 0..channels {
		let mut plane = Vec::with_capacity(frames);
		for index in 0..frames {
			let at = offset + index * 4;
			plane.push(f32::from_le_bytes(
				bytes[at..at + 4].try_into().expect("4 bytes"),
			));
		}
		offset += frames * 4;
		planes.push(plane);
	}
	Window {
		channels,
		sample_rate,
		frames,
		first_seconds,
		planes,
	}
}

/// Playback reads a track a window at a time so it can start on the first one
/// instead of waiting for the whole track to reach disk. Those windows have to
/// be the same samples the whole-track decode produces, in the same order, with
/// nothing dropped at a window boundary — a gap is an audible click and a
/// repeat is a stutter, and both would pass any check that only looked at one
/// window.
#[test]
fn windows_reassemble_into_the_whole_track_pcm() {
	let fixture = ensure_stepped_fixture();

	let dir = std::env::temp_dir().join("bluper-window-pcm");
	let _ = std::fs::remove_dir_all(&dir);
	let whole = decode_audio_pcm_into(&fixture, &dir, None, None).expect("pcm decode succeeds");
	let reference: Vec<Vec<f32>> = whole
		.channel_paths
		.iter()
		.map(|path| {
			std::fs::read(path)
				.expect("a channel file reads")
				.chunks_exact(4)
				.map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
				.collect()
		})
		.collect();

	let mut reader = open_audio(&fixture, None, None).expect("the reader opens");
	let mut assembled: Vec<Vec<f32>> = Vec::new();
	let mut start = 0.0_f64;
	let mut windows = 0;

	while start < whole.shape.duration_seconds {
		let window = parse_window(
			&decode_audio_window(&mut reader, start, 1.0).expect("a window decodes"),
		);
		windows += 1;
		assert!(windows <= 64, "the window chain did not terminate");
		if window.frames == 0 {
			break;
		}

		assert_eq!(
			window.sample_rate, whole.shape.sample_rate,
			"a window reported a different rate to the track"
		);
		assert_eq!(
			window.channels,
			reference.len(),
			"a window reported a different channel count to the track"
		);
		// The first window begins at zero and each one after it picks up where
		// the last left off, which is what the webview relies on to place a
		// window without counting what came before.
		let expected_start = assembled.first().map_or(0, |plane: &Vec<f32>| plane.len());
		assert!(
			(window.first_seconds * f64::from(window.sample_rate)).round() as usize
				== expected_start,
			"window {windows} says it starts at {}s, but {} frames have been read",
			window.first_seconds,
			expected_start
		);

		if assembled.is_empty() {
			assembled = vec![Vec::new(); window.channels];
		}
		for (channel, plane) in window.planes.iter().enumerate() {
			assembled[channel].extend_from_slice(plane);
		}
		start += 1.0;
	}

	assert!(windows >= 8, "10s in 1s windows should take ~10, got {windows}");
	for (channel, (got, want)) in assembled.iter().zip(reference.iter()).enumerate() {
		assert_eq!(
			got.len(),
			want.len(),
			"channel {channel} reassembled to {} frames against {} decoded whole",
			got.len(),
			want.len()
		);
		// Bit-exact: both routes run the same decoder and resampler over the same
		// packets, so anything other than equality means a window dropped or
		// duplicated samples at its edge.
		let mismatch = got.iter().zip(want.iter()).position(|(a, b)| a != b);
		assert_eq!(
			mismatch, None,
			"channel {channel} diverges from the whole-track decode at frame {mismatch:?}"
		);
	}

	let _ = std::fs::remove_dir_all(&dir);
}

/// A window asked for out of order has to seek, and land — scrubbing while
/// audio plays asks in exactly this pattern, and a reader that carried on from
/// wherever it was would play the wrong part of the track.
#[test]
fn a_window_out_of_order_lands_where_it_was_asked_for() {
	let fixture = ensure_stepped_fixture();
	let mut reader = open_audio(&fixture, None, None).expect("the reader opens");
	let mut fresh = open_audio(&fixture, None, None).expect("the reference reader opens");

	for start in [5.0_f64, 1.0, 8.0, 0.0, 3.0] {
		let reused = parse_window(
			&decode_audio_window(&mut reader, start, 0.5).expect("a window decodes"),
		);
		// A reader that has only ever been asked for this one window cannot have
		// carried anything over, so it is the reference for where the samples
		// should be.
		let mut reference_reader = open_audio(&fixture, None, None).expect("a fresh reader opens");
		let reference = parse_window(
			&decode_audio_window(&mut reference_reader, start, 0.5).expect("a window decodes"),
		);

		assert_eq!(
			reused.frames, reference.frames,
			"the window at {start}s came back a different length on the reused reader"
		);
		assert!(
			(reused.first_seconds - reference.first_seconds).abs() < 1e-9,
			"the window at {start}s landed at {}s instead of {}s",
			reused.first_seconds,
			reference.first_seconds
		);
		assert_eq!(
			reused.planes, reference.planes,
			"the window at {start}s came back with different samples on the reused reader"
		);
	}

	// And the sequential path still resumes: asking for the window straight
	// after the last one must not need a seek to be correct.
	let _ = decode_audio_window(&mut fresh, 0.0, 0.5).expect("a window decodes");
	let resumed =
		parse_window(&decode_audio_window(&mut fresh, 0.5, 0.5).expect("a window decodes"));
	assert!(
		(resumed.first_seconds - 0.5).abs() < 0.05,
		"the resumed window landed at {}s rather than 0.5s",
		resumed.first_seconds
	);
}

/// A window past the end of the track must come back empty and terminal rather
/// than erroring or looping — the webview asks for one whenever a clip's
/// declared duration runs a little past its last sample.
#[test]
fn a_window_past_the_end_terminates() {
	let fixture = ensure_stepped_fixture();
	let segment =
		waveform_segment(&fixture, 99.0, 1.5, BUCKET_SIZE).expect("a window past the end succeeds");
	assert!(
		segment.next_start_seconds.is_none(),
		"a window past the end must not ask for another"
	);
}

/// Bucket size is a caller's choice and the grid has to follow it: at double
/// the size there are half as many buckets, and each one is the max of the pair
/// it replaced.
#[test]
fn bucket_size_sets_the_grid() {
	let fixture = ensure_stepped_fixture();
	let fine = decode_peaks(
		&waveform_segment(&fixture, 0.0, 0.0, BUCKET_SIZE)
			.expect("fine summary succeeds")
			.peaks_base64,
	);
	let coarse = decode_peaks(
		&waveform_segment(&fixture, 0.0, 0.0, BUCKET_SIZE * 2)
			.expect("coarse summary succeeds")
			.peaks_base64,
	);

	assert!(
		coarse.len().abs_diff(fine.len().div_ceil(2)) <= 1,
		"doubling the bucket size should halve the count ({} vs {})",
		coarse.len(),
		fine.len()
	);
	for (index, value) in coarse.iter().enumerate() {
		let pair = fine[index * 2].max(*fine.get(index * 2 + 1).unwrap_or(&0.0));
		assert!(
			(value - pair).abs() < 1e-6,
			"coarse bucket {index} is {value}, but the pair it covers peaks at {pair}"
		);
	}
}

fn read_channel(path: &str) -> Vec<f32> {
	let bytes = std::fs::read(path).expect("channel file is readable");
	bytes
		.chunks_exact(4)
		.map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
		.collect()
}

/// The PCM route is what preview playback and the exported mix are built from,
/// so "roughly right" is not enough: a track that comes back short is a gap in
/// the export, and one that comes back at the wrong rate is the whole mix out
/// of tune.
#[test]
fn decodes_a_whole_track_to_per_channel_pcm() {
	let fixture = ensure_stepped_fixture();
	let dir = std::env::temp_dir().join("bluper-pcm-whole");
	let _ = std::fs::remove_dir_all(&dir);

	let decoded = decode_audio_pcm_into(&fixture, &dir, None, None).expect("pcm decode succeeds");

	assert_eq!(decoded.shape.sample_rate, 48_000);
	assert_eq!(decoded.shape.channels, 2);
	assert_eq!(
		decoded.channel_paths.len(),
		2,
		"a stereo track must produce one file per channel"
	);

	// Within a frame either way of 10s at 48kHz. A lossy codec would need more
	// slack; this fixture is PCM, so it should be exact.
	assert!(
		decoded.frames.abs_diff(480_000) <= 1,
		"expected 480,000 frames, got {}",
		decoded.frames
	);

	let left = read_channel(&decoded.channel_paths[0]);
	let right = read_channel(&decoded.channel_paths[1]);
	assert_eq!(left.len() as u64, decoded.frames, "the file must hold every frame it reported");
	assert_eq!(left.len(), right.len(), "channels must be the same length");
	assert!(
		left.iter().all(|s| s.abs() <= 1.001),
		"samples must come back normalised, not as raw integers"
	);

	// The fixture fades in linearly, so the second half has to be louder than
	// the first — the check that samples are in source order rather than
	// reassembled out of sequence.
	let head = left[..left.len() / 2].iter().fold(0.0f32, |a, b| a.max(b.abs()));
	let tail = left[left.len() / 2..].iter().fold(0.0f32, |a, b| a.max(b.abs()));
	assert!(tail > head, "the fade is not in the samples (head {head}, tail {tail})");

	let _ = std::fs::remove_dir_all(&dir);
}

/// The caller asks for the rate its `AudioContext` runs at and a channel cap,
/// and gets exactly that — the mixdown and resample happen here rather than in
/// an `OfflineAudioContext` render in the page.
#[test]
fn resamples_and_mixes_down_on_request() {
	let fixture = ensure_stepped_fixture();
	let dir = std::env::temp_dir().join("bluper-pcm-resampled");
	let _ = std::fs::remove_dir_all(&dir);

	let decoded =
		decode_audio_pcm_into(&fixture, &dir, Some(44_100), Some(1)).expect("pcm decode succeeds");

	assert_eq!(decoded.shape.sample_rate, 44_100);
	assert_eq!(decoded.shape.channels, 1);
	assert_eq!(decoded.channel_paths.len(), 1, "a mono request gets one file");

	// 10s at 44.1kHz. The resampler's own latency moves this by a handful of
	// frames, which is why this is a tolerance rather than an equality.
	let expected = 441_000_u64;
	assert!(
		decoded.frames.abs_diff(expected) <= 2_000,
		"expected ~{expected} frames at 44.1kHz, got {}",
		decoded.frames
	);

	let mono = read_channel(&decoded.channel_paths[0]);
	assert_eq!(mono.len() as u64, decoded.frames);
	assert!(mono.iter().any(|s| s.abs() > 0.1), "the mixdown came back silent");

	let _ = std::fs::remove_dir_all(&dir);
}

/// The peaks the waveform route folds must describe the samples the PCM route
/// returns. They run through the same decoder but different code after it, and
/// a disagreement means the wave a user drags against does not match what they
/// hear.
#[test]
fn peaks_agree_with_the_decoded_samples() {
	let fixture = ensure_stepped_fixture();
	let dir = std::env::temp_dir().join("bluper-pcm-agree");
	let _ = std::fs::remove_dir_all(&dir);

	let peaks = whole_track_peaks(&fixture);
	let decoded = decode_audio_pcm_into(&fixture, &dir, None, None).expect("pcm decode succeeds");
	let channels: Vec<Vec<f32>> = decoded
		.channel_paths
		.iter()
		.map(|path| read_channel(path))
		.collect();

	let bucket = BUCKET_SIZE as usize;
	let mut compared = 0;
	for (index, peak) in peaks.iter().enumerate() {
		let start = index * bucket;
		if start >= channels[0].len() {
			break;
		}
		let end = (start + bucket).min(channels[0].len());
		let mut actual = 0.0f32;
		for channel in &channels {
			for sample in &channel[start..end] {
				actual = actual.max(sample.abs());
			}
		}
		assert!(
			(peak - actual).abs() < 1e-6,
			"bucket {index} reports a peak of {peak} but its samples reach {actual}"
		);
		compared += 1;
	}

	assert!(compared > 3000, "only {compared} buckets were compared");
	let _ = std::fs::remove_dir_all(&dir);
}
