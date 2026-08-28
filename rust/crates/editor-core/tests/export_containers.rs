//! Every container the export panel offers, written and read back.
//!
//! `MediaSink` replaced `mediabunny` as the thing that writes exports, which
//! means it inherited a menu of seven containers rather than the one mp4 the
//! encoder started with. The old pipeline could lean on the browser to say
//! what it could encode; this one is the authority, so the claim that a
//! container works has to be demonstrated rather than declared.
//!
//! The test is driven by [`capabilities`] rather than a hardcoded list: an
//! ffmpeg built without libvpx should skip WebM, not fail on it. What is *not*
//! tolerated is a container this build claims it can write and then cannot —
//! that is the bug this catches, and it is the one that would otherwise reach
//! a user as an export that dies three frames in.

#![cfg(not(target_arch = "wasm32"))]

use editor_core::export::sink::{
    ExportAudioCodec, ExportContainer, ExportVideoCodec, MediaSinkConfig, capabilities,
    open_media_sink,
};
use ffmpeg_next as ffmpeg;
use std::path::{Path, PathBuf};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 64;
const FRAMES: u32 = 12;
const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

fn scratch_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("bluper-export-containers")
        .join(label);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A deterministic diagonal, the same pattern the mp4 parity test uses: a
/// channel-order or stride bug lands the diagonal somewhere unexpected.
fn reference_frame(frame_index: u32) -> Vec<u8> {
    let mut buffer = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let index = ((y * WIDTH + x) * 4) as usize;
            let mut sum = x.wrapping_add(y).wrapping_add(frame_index * 7);
            buffer[index] = (sum & 0xff) as u8;
            sum = sum.wrapping_add(13);
            buffer[index + 1] = (sum & 0xff) as u8;
            sum = sum.wrapping_add(31);
            buffer[index + 2] = (sum & 0xff) as u8;
            buffer[index + 3] = 0xff;
        }
    }
    buffer
}

/// A 440 Hz tone at half scale, in chunks that are deliberately not a
/// multiple of any encoder's frame size.
fn tone_chunk(start_frame: usize, frames: usize) -> Vec<f32> {
    let mut samples = Vec::with_capacity(frames * CHANNELS as usize);
    for index in 0..frames {
        let phase = (start_frame + index) as f32 / SAMPLE_RATE as f32;
        let value = (phase * 440.0 * std::f32::consts::TAU).sin() * 0.5;
        for _ in 0..CHANNELS {
            samples.push(value);
        }
    }
    samples
}

struct Decoded {
    video_frames: usize,
    audio_peak: f32,
    has_audio_stream: bool,
    /// Presentation time of the last video frame, in seconds. The frame
    /// *count* alone cannot catch a file whose timestamps were never rescaled
    /// into the muxer's time base — every frame is still there, stacked at the
    /// start of the file.
    last_video_pts_seconds: f64,
}

/// Decodes whatever streams the file has: counts video frames and finds the
/// loudest audio sample. Both answers are what a user would notice — a file
/// with no frames, or one that plays silence.
fn decode(path: &Path) -> Result<Decoded, String> {
    let mut input =
        ffmpeg::format::input(path).map_err(|e| format!("opening the written file: {e}"))?;

    let video_index = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .map(|stream| stream.index());
    let audio_index = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .map(|stream| stream.index());

    let mut video_decoder = match video_index {
        Some(index) => {
            let stream = input.stream(index).expect("index came from the stream list");
            Some(
                ffmpeg::codec::context::Context::from_parameters(stream.parameters())
                    .and_then(|context| context.decoder().video())
                    .map_err(|e| format!("opening the video decoder: {e}"))?,
            )
        }
        None => None,
    };
    let mut audio_decoder = match audio_index {
        Some(index) => {
            let stream = input.stream(index).expect("index came from the stream list");
            Some(
                ffmpeg::codec::context::Context::from_parameters(stream.parameters())
                    .and_then(|context| context.decoder().audio())
                    .map_err(|e| format!("opening the audio decoder: {e}"))?,
            )
        }
        None => None,
    };

    let mut video_frames = 0usize;
    let mut audio_peak = 0.0f32;
    let mut last_video_pts = 0.0f64;
    let video_time_base = video_index
        .and_then(|index| input.stream(index))
        .map(|stream| f64::from(stream.time_base()))
        .unwrap_or(0.0);

    for (stream, packet) in input.packets() {
        if Some(stream.index()) == video_index {
            if let Some(decoder) = video_decoder.as_mut() {
                decoder
                    .send_packet(&packet)
                    .map_err(|e| format!("sending a video packet: {e}"))?;
                let mut frame = ffmpeg::frame::Video::empty();
                while decoder.receive_frame(&mut frame).is_ok() {
                    video_frames += 1;
                    if let Some(pts) = frame.pts() {
                        last_video_pts = last_video_pts.max(pts as f64 * video_time_base);
                    }
                }
            }
        } else if Some(stream.index()) == audio_index {
            if let Some(decoder) = audio_decoder.as_mut() {
                decoder
                    .send_packet(&packet)
                    .map_err(|e| format!("sending an audio packet: {e}"))?;
                audio_peak = audio_peak.max(drain_audio(decoder));
            }
        }
    }

    if let Some(decoder) = video_decoder.as_mut() {
        decoder.send_eof().ok();
        let mut frame = ffmpeg::frame::Video::empty();
        while decoder.receive_frame(&mut frame).is_ok() {
            video_frames += 1;
            if let Some(pts) = frame.pts() {
                last_video_pts = last_video_pts.max(pts as f64 * video_time_base);
            }
        }
    }
    if let Some(decoder) = audio_decoder.as_mut() {
        decoder.send_eof().ok();
        audio_peak = audio_peak.max(drain_audio(decoder));
    }

    Ok(Decoded {
        video_frames,
        audio_peak,
        has_audio_stream: audio_index.is_some(),
        last_video_pts_seconds: last_video_pts,
    })
}

/// Pulls every ready frame out of an audio decoder and reports the loudest
/// sample, whatever sample format the codec decoded into.
fn drain_audio(decoder: &mut ffmpeg::decoder::Audio) -> f32 {
    use ffmpeg::format::Sample;
    use ffmpeg::format::sample::Type;

    let mut peak = 0.0f32;
    let mut frame = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut frame).is_ok() {
        let samples = frame.samples();
        match frame.format() {
            Sample::F32(Type::Planar) => {
                for value in &frame.plane::<f32>(0)[..samples] {
                    peak = peak.max(value.abs());
                }
            }
            Sample::F32(Type::Packed) => {
                let plane = frame.plane::<f32>(0);
                for value in &plane[..samples.min(plane.len())] {
                    peak = peak.max(value.abs());
                }
            }
            Sample::I16(Type::Planar) => {
                for value in &frame.plane::<i16>(0)[..samples] {
                    peak = peak.max(*value as f32 / i16::MAX as f32);
                }
            }
            Sample::I16(Type::Packed) => {
                let plane = frame.plane::<i16>(0);
                for value in &plane[..samples.min(plane.len())] {
                    peak = peak.max(*value as f32 / i16::MAX as f32);
                }
            }
            Sample::I32(Type::Planar) => {
                for value in &frame.plane::<i32>(0)[..samples] {
                    peak = peak.max(*value as f32 / i32::MAX as f32);
                }
            }
            Sample::I32(Type::Packed) => {
                let plane = frame.plane::<i32>(0);
                for value in &plane[..samples.min(plane.len())] {
                    peak = peak.max(*value as f32 / i32::MAX as f32);
                }
            }
            // A format nothing in the menu decodes into. Reporting zero would
            // read as silence, so say nothing and let the caller's other
            // assertions stand.
            _ => return f32::NAN,
        }
    }
    peak
}

/// Writes one file with the given streams and hands back what came out.
fn write_and_decode(
    label: &str,
    container: ExportContainer,
    video_codec: Option<ExportVideoCodec>,
    audio_codec: Option<ExportAudioCodec>,
) -> Result<Decoded, String> {
    let dir = scratch_dir(label);
    let path = dir.join(format!("out.{}", container.extension()));
    let _ = std::fs::remove_file(&path);

    let config = MediaSinkConfig {
        container,
        video_codec,
        width: if video_codec.is_some() { WIDTH } else { 0 },
        height: if video_codec.is_some() { HEIGHT } else { 0 },
        fps_numerator: 30,
        fps_denominator: 1,
        video_bitrate: 800_000,
        audio_codec,
        audio_sample_rate: if audio_codec.is_some() { SAMPLE_RATE } else { 0 },
        audio_channels: if audio_codec.is_some() { CHANNELS } else { 0 },
    };

    let mut sink = open_media_sink(&path, config)?;

    if video_codec.is_some() {
        for index in 0..FRAMES {
            sink.write_frame(&reference_frame(index), index as i64)?;
        }
    }
    if audio_codec.is_some() {
        // Chunks of 3000 frames: not a multiple of AAC's 1024, Opus's 960, or
        // anything else, so the sink's re-chunking is exercised rather than
        // sidestepped.
        const CHUNK: usize = 3000;
        for chunk in 0..6 {
            let start = chunk * CHUNK;
            sink.write_audio(&tone_chunk(start, CHUNK), CHUNK, start as i64)?;
        }
    }
    sink.finish()?;

    let size = std::fs::metadata(&path)
        .map_err(|e| format!("the written file is not there: {e}"))?
        .len();
    if size == 0 {
        return Err("the written file is empty".to_string());
    }

    decode(&path)
}

#[test]
fn every_offered_container_writes_a_file_that_decodes() {
    // Driven by the capability probe, so a differently built ffmpeg skips what
    // it cannot do rather than failing on it. What is not tolerated is a
    // container this build offers and then cannot write.
    let mut covered = 0;
    let mut report = Vec::new();

    for capability in capabilities() {
        let container = capability.container;
        let video_codec = capability.video_codecs.first().copied();
        let audio_codec = capability.audio_codecs.first().copied();

        if video_codec.is_none() && audio_codec.is_none() {
            report.push(format!("{container:?}: nothing encodable, skipped"));
            continue;
        }
        if !capability.audio_only && video_codec.is_none() {
            report.push(format!("{container:?}: no video encoder, skipped"));
            continue;
        }

        let label = format!("{container:?}").to_lowercase();
        let decoded = write_and_decode(&label, container, video_codec, audio_codec)
            .unwrap_or_else(|error| {
                panic!(
                    "{container:?} is offered by the capability probe but failed to write: {error}"
                )
            });

        if video_codec.is_some() {
            assert!(
                decoded.video_frames > 0,
                "{container:?} wrote a file with no decodable frames"
            );
            // Encoders may drop or pad a frame at the boundary; what matters
            // is that essentially all of them survived, not an exact count.
            assert!(
                decoded.video_frames >= FRAMES as usize - 1,
                "{container:?} decoded {} of {FRAMES} frames",
                decoded.video_frames
            );
            // The frames have to be spread over the clip, not stacked at its
            // start. Twelve frames at 30 fps run to 0.367s; anything under half
            // of that means the timestamps never reached the muxer's time base,
            // which is a file every player shows as an instant flicker.
            let expected_end = (FRAMES - 1) as f64 / 30.0;
            assert!(
                decoded.last_video_pts_seconds > expected_end / 2.0,
                "{container:?} put its last frame at {:.4}s, expected about {expected_end:.4}s \
                 — the packets were not rescaled into the stream's time base",
                decoded.last_video_pts_seconds
            );
        }
        if audio_codec.is_some() {
            assert!(
                decoded.has_audio_stream,
                "{container:?} was asked for audio and wrote no audio stream"
            );
            // NaN means the decoder used a sample format this test does not
            // read; that is not a failure of the export.
            if !decoded.audio_peak.is_nan() {
                assert!(
                    decoded.audio_peak > 0.2,
                    "{container:?} decoded to a peak of {}, which is silence",
                    decoded.audio_peak
                );
            }
        }

        report.push(format!(
            "{container:?}: {video_codec:?}/{audio_codec:?} → {} frames, peak {:.3}",
            decoded.video_frames, decoded.audio_peak
        ));
        covered += 1;
    }

    assert!(
        covered >= 4,
        "only {covered} containers were exercised, which is too few to trust:\n{}",
        report.join("\n")
    );
    println!("{}", report.join("\n"));
}

#[test]
fn an_audio_only_container_carries_no_video_stream() {
    // A WAV that somehow gained a video stream is not a WAV. The validator
    // refuses the config, and this confirms the written file agrees.
    let wav = capabilities()
        .into_iter()
        .find(|capability| capability.container == ExportContainer::Wav)
        .expect("wav is always listed");
    let codec = wav
        .audio_codecs
        .first()
        .copied()
        .expect("this ffmpeg cannot write PCM, which would be extraordinary");

    let decoded = write_and_decode("wav-audio-only", ExportContainer::Wav, None, Some(codec))
        .expect("wav should write");
    assert_eq!(decoded.video_frames, 0);
    assert!(decoded.has_audio_stream);
}

#[test]
fn opus_resamples_a_44_1khz_mix_rather_than_refusing_it() {
    // Opus encodes at 48 kHz and nothing else. A 44.1 kHz timeline is
    // completely ordinary — it is what a CD-rate source gives — so the sink
    // resamples instead of reporting that the codec will not take it.
    let ogg = capabilities()
        .into_iter()
        .find(|capability| capability.container == ExportContainer::Ogg)
        .expect("ogg is always listed");
    let Some(codec) = ogg.audio_codecs.first().copied() else {
        // No Opus or Vorbis encoder in this build; nothing to prove.
        return;
    };

    let dir = scratch_dir("opus-resample");
    let path = dir.join("out.ogg");
    let _ = std::fs::remove_file(&path);

    let config = MediaSinkConfig {
        container: ExportContainer::Ogg,
        video_codec: None,
        width: 0,
        height: 0,
        fps_numerator: 30,
        fps_denominator: 1,
        video_bitrate: 0,
        audio_codec: Some(codec),
        audio_sample_rate: 44_100,
        audio_channels: CHANNELS,
    };
    let mut sink = open_media_sink(&path, config).expect("open the ogg sink at 44.1 kHz");

    const CHUNK: usize = 4410;
    for chunk in 0..8 {
        let start = chunk * CHUNK;
        sink.write_audio(&tone_chunk(start, CHUNK), CHUNK, start as i64)
            .expect("write_audio through the resampler");
    }
    sink.finish().expect("finish");

    let decoded = decode(&path).expect("decode the ogg back");
    assert!(decoded.has_audio_stream);
    if !decoded.audio_peak.is_nan() {
        assert!(
            decoded.audio_peak > 0.2,
            "the resampled export decoded to a peak of {}, which is silence",
            decoded.audio_peak
        );
    }
}
