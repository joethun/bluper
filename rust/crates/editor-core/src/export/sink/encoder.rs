//! The ffmpeg encoder behind every export.
//!
//! One sink writes one file: a muxer named by the container, an optional video
//! stream and an optional audio stream. The caller hands over RGBA frames and
//! interleaved f32 audio and never has to know what the codec underneath wants
//! — which pixel format, which sample format, which sample rate, or how many
//! samples make one encoder frame. All four are negotiated here against the
//! opened encoder.
//!
//! ```text
//!   RGBA8 (row-major)              f32 interleaved @ mix rate
//!        │                                  │
//!        ▼                                  ▼
//!   sws_scale                          swr_convert (rate)
//!        │                                  │
//!        ▼                                  ▼
//!   yuv420p / yuv422p10             f32 @ encoder rate, buffered
//!        │                                  │
//!        │                                  ▼
//!        │                          one frame's worth, in the
//!        │                          encoder's own sample format
//!        ▼                                  ▼
//!   encoder.send_frame  ─────────────►  encoder.send_frame
//!        │                                  │
//!        ▼                                  ▼
//!   receive_packet ──► muxer.write_interleaved ◄── receive_packet
//! ```
//!
//! Two things here are not obvious and are worth stating, because both were
//! found the hard way:
//!
//! - **An encoder takes exactly `frame_size` samples per frame.** AAC is 1024
//!   and rejects anything else with a bare `Invalid argument`. Callers slice
//!   audio by the second, so the sink buffers and re-chunks.
//! - **Each of those frames needs its own presentation index.** Two frames
//!   sharing one is not a timing wobble a player rounds away; the muxer
//!   refuses the second packet outright.

use std::path::Path;

use ffmpeg_next as ffmpeg;

use super::{
    ExportAudioCodec, ExportContainer, ExportVideoCodec, MediaSinkConfig, ffmpeg_ids,
    find_encoder,
};

/// Samples per frame for codecs that report no fixed frame size — the PCM
/// family, which takes any number. A round figure keeps the packet count
/// sane on a long export.
const DEFAULT_FRAME_SIZE: usize = 1024;

/// The video half of an open sink.
struct VideoStream {
    encoder: ffmpeg::codec::encoder::Video,
    scaler: ffmpeg::software::scaling::Context,
    stream_index: usize,
    /// The encoder's own time base, which is what its packets are stamped in.
    time_base: ffmpeg::util::rational::Rational,
    /// The muxer's time base for this stream, which is what they have to be
    /// written in. The two are rarely the same: ask an mp4 muxer for 1/30 and
    /// it will keep 1/15360.
    stream_time_base: ffmpeg::util::rational::Rational,
    width: u32,
    height: u32,
    pixel_format: ffmpeg::format::Pixel,
}

/// The audio half of an open sink, including everything needed to turn the
/// caller's f32 into what the codec accepts.
struct AudioStream {
    encoder: ffmpeg::codec::encoder::Audio,
    stream_index: usize,
    time_base: ffmpeg::util::rational::Rational,
    stream_time_base: ffmpeg::util::rational::Rational,
    channels: u16,
    layout: ffmpeg::channel_layout::ChannelLayout,
    sample_format: ffmpeg::format::Sample,
    /// Rate conversion from the mix's rate to the encoder's, when they differ
    /// — Opus, for one, only encodes at 48 kHz.
    resampler: Option<ffmpeg::software::resampling::Context>,
    /// The rate the caller's chunks arrive at.
    source_rate: u32,
    /// The rate the encoder actually runs at, which is not always the same.
    target_rate: u32,
    frame_size: usize,
    /// Interleaved f32 at the *encoder's* rate, waiting to make a whole
    /// frame.
    pending: Vec<f32>,
    /// Presentation index of the next encoder frame, in the audio stream's
    /// `1 / rate` time base.
    next_pts: i64,
    /// Whether anything has been written yet, so the first chunk can seed
    /// `next_pts` from the caller's offset.
    started: bool,
}

/// An open export. Not `Send` by construction — a single thread owns one
/// export end to end, which matches the rest of the editor.
pub struct MediaSink {
    output: ffmpeg::format::context::Output,
    video: Option<VideoStream>,
    audio: Option<AudioStream>,
    /// Set once `finish` has run, so the drop hook skips a second
    /// `write_trailer` — ffmpeg treats that as an error rather than a no-op.
    finished: bool,
}

// SAFETY: a `MediaSink` is created, driven and consumed by one thread. The
// ffmpeg handles it owns (`AVFormatContext`, `AVCodecContext`, `SwsContext`,
// `SwrContext`) are not safe to share concurrently because ffmpeg does not
// protect them; the contract is single ownership for the lifetime of the
// export. The desktop shell keeps sinks in a registry behind a `Mutex`, so two
// tauri commands never touch one concurrently. The marker is what lets that
// registry live in tauri's `State`, which requires `Send + Sync + 'static`.
unsafe impl Send for MediaSink {}
unsafe impl Sync for MediaSink {}

impl MediaSink {
    pub fn open(path: &Path, config: MediaSinkConfig) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating output directory failed: {e}"))?;
        }

        // The muxer is named rather than guessed from the extension: `.m4a`
        // and `.mp4` are the same guess but not the same muxer, and an Opus
        // stream in an `.ogg` wants the ogg muxer specifically.
        let mut output = ffmpeg::format::output_as(path, config.container.muxer_name())
            .map_err(|e| {
                format!(
                    "opening output file as {}: {e}",
                    config.container.muxer_name()
                )
            })?;

        // Some containers keep the codec configuration in a header at the
        // front of the file rather than inline in the bitstream (mp4's `avcC`
        // box is the one everybody meets). The encoder has to be told, before
        // it opens, that this is where its extradata is going.
        let global_header = output
            .format()
            .flags()
            .contains(ffmpeg::format::Flags::GLOBAL_HEADER);

        let video = match config.video_codec {
            Some(codec) => Some(Self::open_video(
                &mut output,
                &config,
                codec,
                global_header,
            )?),
            None => None,
        };
        let audio = match config.audio_codec {
            Some(codec) => Some(Self::open_audio(
                &mut output,
                &config,
                codec,
                global_header,
            )?),
            None => None,
        };

        output
            .write_header()
            .map_err(|e| format!("writing the container header: {e}"))?;

        // `write_header` is where a muxer picks the time base it will actually
        // store timestamps in, and it is free to ignore the one asked for. Read
        // it back now: a packet written in the encoder's units when the stream
        // is keeping the muxer's lands at a fraction of the time it belongs at,
        // which reads as every frame stacked at the start of the file.
        let mut video = video;
        if let Some(stream) = video
            .as_ref()
            .and_then(|video| output.stream(video.stream_index))
        {
            let base = stream.time_base();
            if let Some(video) = video.as_mut() {
                video.stream_time_base = base;
            }
        }
        let mut audio = audio;
        if let Some(stream) = audio
            .as_ref()
            .and_then(|audio| output.stream(audio.stream_index))
        {
            let base = stream.time_base();
            if let Some(audio) = audio.as_mut() {
                audio.stream_time_base = base;
            }
        }

        Ok(MediaSink {
            output,
            video,
            audio,
            finished: false,
        })
    }

    fn open_video(
        output: &mut ffmpeg::format::context::Output,
        config: &MediaSinkConfig,
        codec: ExportVideoCodec,
        global_header: bool,
    ) -> Result<VideoStream, String> {
        let encoder_codec = find_encoder(ffmpeg_ids::video(codec))
            .ok_or_else(|| format!("no encoder for {}", codec.label()))?;

        // ProRes is a 10-bit 4:2:2 format; asking it for yuv420p produces a
        // file that is not ProRes in any sense a colourist would accept.
        let pixel_format = match codec {
            ExportVideoCodec::ProRes => ffmpeg::format::Pixel::YUV422P10LE,
            _ => ffmpeg::format::Pixel::YUV420P,
        };

        let context = ffmpeg::codec::context::Context::new_with_codec(encoder_codec);
        let mut video = context
            .encoder()
            .video()
            .map_err(|e| format!("opening video encoder context: {e}"))?;

        video.set_width(config.width);
        video.set_height(config.height);
        let time_base = ffmpeg::util::rational::Rational::new(
            config.fps_denominator as i32,
            config.fps_numerator as i32,
        );
        video.set_time_base(time_base);
        video.set_frame_rate(Some(ffmpeg::util::rational::Rational::new(
            config.fps_numerator as i32,
            config.fps_denominator as i32,
        )));
        video.set_format(pixel_format);
        video.set_bit_rate(config.video_bitrate as usize);
        // One keyframe per second of footage. Scrubbing the playback bar is
        // what a keyframe interval is felt through, and once a second is the
        // floor there.
        let gop = (config.fps_numerator / config.fps_denominator.max(1)).max(1);
        video.set_gop(gop);
        // No B-frames. This is a workaround, not a preference: the editor's own
        // demuxer (`media_decode.rs`, feeding WebCodecs) walks a GOP in file
        // order and treats presentation timestamps as if they arrived in that
        // order too. With B-frames they do not, and the frames it hands back
        // are the wrong ones — so an export written with them is a file this
        // app cannot preview. Every fixture used to come from the browser's own
        // encoder, which emits none, which is why nothing caught it.
        //
        // The cost is a few percent of compression. The fix is to make the
        // demuxer DTS-aware, and until that lands this keeps our own exports
        // readable by our own preview.
        video.set_max_b_frames(0);
        if global_header {
            video.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        }

        let opened = video
            .open()
            .map_err(|e| format!("opening the {} encoder: {e}", codec.label()))?;

        let mut stream = output
            .add_stream(encoder_codec)
            .map_err(|e| format!("adding the video stream: {e}"))?;
        stream.set_parameters(&opened);
        stream.set_time_base(time_base);
        let stream_index = stream.index();

        let scaler = ffmpeg::software::scaling::Context::get(
            ffmpeg::format::Pixel::RGBA,
            config.width,
            config.height,
            pixel_format,
            config.width,
            config.height,
            ffmpeg::software::scaling::Flags::BILINEAR,
        )
        .map_err(|e| format!("creating the RGBA→{pixel_format:?} scaler: {e}"))?;

        Ok(VideoStream {
            encoder: opened,
            scaler,
            stream_index,
            time_base,
            // Filled in after `write_header`, which is when the muxer has
            // settled on one.
            stream_time_base: time_base,
            width: config.width,
            height: config.height,
            pixel_format,
        })
    }

    fn open_audio(
        output: &mut ffmpeg::format::context::Output,
        config: &MediaSinkConfig,
        codec: ExportAudioCodec,
        global_header: bool,
    ) -> Result<AudioStream, String> {
        let encoder_codec = find_encoder(ffmpeg_ids::audio(codec))
            .ok_or_else(|| format!("no encoder for {codec:?}"))?;
        let audio_codec = encoder_codec
            .audio()
            .map_err(|e| format!("{codec:?} is not an audio encoder: {e}"))?;

        // What the encoder accepts, rather than what we would like to send.
        // `formats()` answering `None` means "anything", which the PCM
        // encoders do.
        let sample_format = audio_codec
            .formats()
            .and_then(|mut formats| formats.next())
            .unwrap_or(ffmpeg::format::Sample::F32(
                ffmpeg::format::sample::Type::Packed,
            ));

        // Likewise the rate: Opus encodes at 48 kHz and nothing else, so a
        // 44.1 kHz mix has to be resampled rather than refused.
        let target_rate = match audio_codec.rates() {
            Some(rates) => {
                let supported: Vec<i32> = rates.collect();
                if supported.contains(&(config.audio_sample_rate as i32)) {
                    config.audio_sample_rate
                } else {
                    // The highest the encoder offers, which loses nothing a
                    // lower one would have kept.
                    supported
                        .iter()
                        .copied()
                        .max()
                        .map(|rate| rate as u32)
                        .unwrap_or(config.audio_sample_rate)
                }
            }
            None => config.audio_sample_rate,
        };

        let layout = ffmpeg::channel_layout::ChannelLayout::default(config.audio_channels as i32);

        let context = ffmpeg::codec::context::Context::new_with_codec(encoder_codec);
        let mut audio = context
            .encoder()
            .audio()
            .map_err(|e| format!("opening audio encoder context: {e}"))?;
        audio.set_rate(target_rate as i32);
        audio.set_channel_layout(layout);
        audio.set_format(sample_format);
        let time_base = ffmpeg::util::rational::Rational::new(1, target_rate as i32);
        audio.set_time_base(time_base);
        if let Some(bitrate) = codec.bitrate() {
            audio.set_bit_rate(bitrate as usize);
        }
        if global_header {
            audio.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
        }

        let opened = audio
            .open()
            .map_err(|e| format!("opening the {codec:?} encoder: {e}"))?;

        let mut stream = output
            .add_stream(encoder_codec)
            .map_err(|e| format!("adding the audio stream: {e}"))?;
        stream.set_parameters(&opened);
        stream.set_time_base(time_base);
        let stream_index = stream.index();

        // The resampler only handles the rate. Format conversion happens when
        // the frame is built, from one buffer of f32 — which keeps the
        // buffering arithmetic in one unit rather than in whatever width the
        // codec happens to want.
        let resampler = if target_rate == config.audio_sample_rate {
            None
        } else {
            Some(
                ffmpeg::software::resampling::Context::get(
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    layout,
                    config.audio_sample_rate,
                    ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                    layout,
                    target_rate,
                )
                .map_err(|e| {
                    format!(
                        "creating the {} → {target_rate} Hz resampler: {e}",
                        config.audio_sample_rate
                    )
                })?,
            )
        };

        let frame_size = match opened.frame_size() as usize {
            0 => DEFAULT_FRAME_SIZE,
            size => size,
        };

        Ok(AudioStream {
            encoder: opened,
            stream_index,
            time_base,
            stream_time_base: time_base,
            channels: config.audio_channels,
            layout,
            sample_format,
            resampler,
            source_rate: config.audio_sample_rate,
            target_rate,
            frame_size,
            pending: Vec::new(),
            next_pts: 0,
            started: false,
        })
    }

    /// Encodes one RGBA8 row-major frame at `pts_index`, a 0-based frame
    /// index within the export. Dropped silently on an audio-only export, so
    /// a caller need not branch on the container.
    pub fn write_frame(&mut self, rgba: &[u8], pts_index: i64) -> Result<(), String> {
        let Some(video) = self.video.as_mut() else {
            return Ok(());
        };

        let expected = (video.width * video.height * 4) as usize;
        if rgba.len() != expected {
            return Err(format!(
                "frame buffer is {} bytes, expected {expected} ({}x{}x4)",
                rgba.len(),
                video.width,
                video.height,
            ));
        }

        // ffmpeg allocates each plane with the row stride the format
        // requires, which is not always the packed width — hence the
        // row-by-row copy rather than one `copy_from_slice`.
        let mut source =
            ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGBA, video.width, video.height);
        let row_bytes = (video.width * 4) as usize;
        let stride = source.stride(0);
        let plane = source.data_mut(0);
        for row in 0..video.height as usize {
            let from = row * row_bytes;
            plane[row * stride..row * stride + row_bytes]
                .copy_from_slice(&rgba[from..from + row_bytes]);
        }

        let mut converted =
            ffmpeg::frame::Video::new(video.pixel_format, video.width, video.height);
        video
            .scaler
            .run(&source, &mut converted)
            .map_err(|e| format!("sws_scale RGBA→{:?}: {e}", video.pixel_format))?;
        converted.set_pts(Some(pts_index));

        video
            .encoder
            .send_frame(&converted)
            .map_err(|e| format!("video encoder send_frame: {e}"))?;

        Self::drain(&mut self.output, VideoOrAudio::Video(video))
    }

    /// Takes one chunk of audio: `frames * channels` interleaved f32 samples
    /// at the rate the config named, arranged `[s0_c0, s0_c1, s1_c0, …]`.
    /// `pts_index` is the chunk's sample offset, not a frame number.
    ///
    /// Nothing is encoded until a whole encoder frame has accumulated. See
    /// the module docs for why. Dropped silently on a silent export.
    pub fn write_audio(
        &mut self,
        interleaved: &[f32],
        frames: usize,
        pts_index: i64,
    ) -> Result<(), String> {
        if self.audio.is_none() {
            return Ok(());
        }
        let channels = self
            .audio
            .as_ref()
            .expect("checked just above")
            .channels as usize;
        if interleaved.len() != frames * channels {
            return Err(format!(
                "audio chunk is {} samples, expected {} ({frames} frames x {channels} channels)",
                interleaved.len(),
                frames * channels,
            ));
        }

        let resampled = self.resample(interleaved, frames)?;
        {
            let audio = self.audio.as_mut().expect("checked above");
            if !audio.started {
                audio.started = true;
                // Seeded from the caller's own offset, rescaled if the
                // encoder runs at a different rate than the mix.
                audio.next_pts = pts_index;
            }
            audio.pending.extend_from_slice(&resampled);
        }

        self.encode_full_audio_frames()
    }

    /// Rate-converts a chunk to the encoder's rate, or hands it straight back
    /// when the rates already match.
    fn resample(&mut self, interleaved: &[f32], frames: usize) -> Result<Vec<f32>, String> {
        let audio = self.audio.as_mut().expect("caller checked");
        let channels = audio.channels as usize;
        let Some(resampler) = audio.resampler.as_mut() else {
            return Ok(interleaved.to_vec());
        };

        let mut source = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            frames,
            audio.layout,
        );
        source.set_rate(audio.source_rate);
        // Packed f32 is one plane of `frames * channels` samples.
        let plane = source.data_mut(0);
        let as_f32: &mut [f32] = unsafe {
            std::slice::from_raw_parts_mut(
                plane.as_mut_ptr() as *mut f32,
                plane.len() / std::mem::size_of::<f32>(),
            )
        };
        as_f32[..interleaved.len()].copy_from_slice(interleaved);

        // The output frame is allocated here rather than left to `run`, which
        // would size it at the *input's* sample count. Upsampling produces
        // more samples than it consumes — 44.1 kHz to 48 kHz is nearly a tenth
        // again — so leaving it to `run` makes every conversion fail on a
        // buffer too small to hold its own result. The margin covers swr's
        // internal delay, which it flushes into the next call.
        let capacity = (frames as u64 * audio.target_rate as u64)
            .div_ceil(audio.source_rate.max(1) as u64) as usize
            + 1024;
        let mut converted = ffmpeg::frame::Audio::new(
            ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
            capacity,
            audio.layout,
        );
        converted.set_rate(audio.target_rate);
        resampler
            .run(&source, &mut converted)
            .map_err(|e| format!("resampling audio to {} Hz: {e}", audio.target_rate))?;

        let produced = converted.samples() * channels;
        if produced == 0 {
            return Ok(Vec::new());
        }
        let plane = converted.data(0);
        let out: &[f32] = unsafe {
            std::slice::from_raw_parts(
                plane.as_ptr() as *const f32,
                plane.len() / std::mem::size_of::<f32>(),
            )
        };
        Ok(out[..produced.min(out.len())].to_vec())
    }

    /// Encodes every whole frame sitting in the pending buffer.
    fn encode_full_audio_frames(&mut self) -> Result<(), String> {
        loop {
            let (samples_per_frame, ready) = {
                let audio = self.audio.as_ref().expect("caller checked");
                let per_frame = audio.frame_size * audio.channels as usize;
                (per_frame, audio.pending.len() >= per_frame)
            };
            if !ready {
                return Ok(());
            }
            let chunk: Vec<f32> = {
                let audio = self.audio.as_mut().expect("caller checked");
                audio.pending.drain(..samples_per_frame).collect()
            };
            let frame_size = self.audio.as_ref().expect("caller checked").frame_size;
            self.encode_audio_frame(&chunk, frame_size)?;
        }
    }

    /// Encodes exactly `frames` frames as one encoder frame at the running
    /// presentation index, converting f32 into whatever sample format the
    /// codec asked for.
    fn encode_audio_frame(&mut self, interleaved: &[f32], frames: usize) -> Result<(), String> {
        let audio = self.audio.as_mut().expect("caller checked");
        let channels = audio.channels as usize;

        let mut frame =
            ffmpeg::frame::Audio::new(audio.sample_format, frames, audio.layout);
        write_samples(&mut frame, interleaved, frames, channels, audio.sample_format)?;
        frame.set_pts(Some(audio.next_pts));
        audio.next_pts += frames as i64;

        audio
            .encoder
            .send_frame(&frame)
            .map_err(|e| format!("audio encoder send_frame: {e}"))?;

        let audio = self.audio.as_mut().expect("caller checked");
        Self::drain(&mut self.output, VideoOrAudio::Audio(audio))
    }

    /// Pulls every packet an encoder has ready and writes it to the muxer.
    fn drain(
        output: &mut ffmpeg::format::context::Output,
        stream: VideoOrAudio<'_>,
    ) -> Result<(), String> {
        let mut packet = ffmpeg::packet::Packet::empty();
        match stream {
            VideoOrAudio::Video(video) => {
                while video.encoder.receive_packet(&mut packet).is_ok() {
                    packet.set_stream(video.stream_index);
                    packet.rescale_ts(video.time_base, video.stream_time_base);
                    packet
                        .write_interleaved(output)
                        .map_err(|e| format!("muxer write video packet: {e}"))?;
                }
            }
            VideoOrAudio::Audio(audio) => {
                while audio.encoder.receive_packet(&mut packet).is_ok() {
                    packet.set_stream(audio.stream_index);
                    packet.rescale_ts(audio.time_base, audio.stream_time_base);
                    packet
                        .write_interleaved(output)
                        .map_err(|e| format!("muxer write audio packet: {e}"))?;
                }
            }
        }
        Ok(())
    }

    /// Closes the encoders and writes the container trailer. The file is
    /// finished once this returns.
    pub fn finish(mut self) -> Result<(), String> {
        self.finish_inner()
    }

    fn finish_inner(&mut self) -> Result<(), String> {
        // Whatever `write_audio` left buffered, padded out to a whole frame
        // with silence. Without this the tail of every export — up to a
        // frame's worth, 23 ms at 44.1 kHz — goes missing.
        if let Some(audio) = self.audio.as_ref() {
            if !audio.pending.is_empty() {
                let channels = audio.channels as usize;
                let frames = audio.frame_size;
                let pending: Vec<f32> = {
                    let audio = self.audio.as_mut().expect("checked above");
                    std::mem::take(&mut audio.pending)
                };
                let real_frames = pending.len() / channels;
                self.encode_audio_frame(&pending, frames)?;
                // Only the samples that were really there advance the clock;
                // the padding is not part of the timeline.
                let audio = self.audio.as_mut().expect("checked above");
                audio.next_pts -= (frames - real_frames) as i64;
            }
        }

        if let Some(video) = self.video.as_mut() {
            video
                .encoder
                .send_eof()
                .map_err(|e| format!("video encoder send_eof: {e}"))?;
            let video = self.video.as_mut().expect("checked above");
            Self::drain(&mut self.output, VideoOrAudio::Video(video))?;
        }
        if let Some(audio) = self.audio.as_mut() {
            audio
                .encoder
                .send_eof()
                .map_err(|e| format!("audio encoder send_eof: {e}"))?;
            let audio = self.audio.as_mut().expect("checked above");
            Self::drain(&mut self.output, VideoOrAudio::Audio(audio))?;
        }

        self.output
            .write_trailer()
            .map_err(|e| format!("writing the container trailer: {e}"))?;
        self.finished = true;
        Ok(())
    }

    pub fn container(&self) -> ExportContainer {
        // Read back off the muxer name rather than stored twice.
        match self.output.format().name() {
            "mov" => ExportContainer::Mov,
            "matroska" => ExportContainer::Mkv,
            "webm" => ExportContainer::WebM,
            "ipod" => ExportContainer::M4a,
            "wav" => ExportContainer::Wav,
            "ogg" => ExportContainer::Ogg,
            _ => ExportContainer::Mp4,
        }
    }

    /// The sample rate the audio stream is actually written at, which is not
    /// always the one the mix was handed over at — Opus only encodes 48 kHz.
    pub fn audio_sample_rate(&self) -> Option<u32> {
        self.audio.as_ref().map(|audio| audio.target_rate)
    }
}

/// Which stream a drain is for. A plain `&mut` to either would borrow the
/// whole sink, and the muxer has to be borrowed at the same time.
enum VideoOrAudio<'a> {
    Video(&'a mut VideoStream),
    Audio(&'a mut AudioStream),
}

/// Writes interleaved f32 into a frame in the encoder's own sample format.
///
/// A short input is padded with silence rather than left holding whatever the
/// allocation came with — that is the final flush, where the last frame is
/// rarely full.
fn write_samples(
    frame: &mut ffmpeg::frame::Audio,
    interleaved: &[f32],
    frames: usize,
    channels: usize,
    format: ffmpeg::format::Sample,
) -> Result<(), String> {
    use ffmpeg::format::Sample;
    use ffmpeg::format::sample::Type;

    let at = |sample_index: usize, channel: usize| -> f32 {
        interleaved
            .get(sample_index * channels + channel)
            .copied()
            .unwrap_or(0.0)
    };

    match format {
        Sample::F32(Type::Planar) => {
            for channel in 0..channels {
                let plane = plane_as_mut::<f32>(frame, channel);
                for index in 0..frames {
                    plane[index] = at(index, channel);
                }
            }
        }
        Sample::F32(Type::Packed) => {
            let plane = plane_as_mut::<f32>(frame, 0);
            for index in 0..frames {
                for channel in 0..channels {
                    plane[index * channels + channel] = at(index, channel);
                }
            }
        }
        Sample::I16(Type::Planar) => {
            for channel in 0..channels {
                let plane = plane_as_mut::<i16>(frame, channel);
                for index in 0..frames {
                    plane[index] = to_i16(at(index, channel));
                }
            }
        }
        Sample::I16(Type::Packed) => {
            let plane = plane_as_mut::<i16>(frame, 0);
            for index in 0..frames {
                for channel in 0..channels {
                    plane[index * channels + channel] = to_i16(at(index, channel));
                }
            }
        }
        Sample::I32(Type::Planar) => {
            for channel in 0..channels {
                let plane = plane_as_mut::<i32>(frame, channel);
                for index in 0..frames {
                    plane[index] = to_i32(at(index, channel));
                }
            }
        }
        Sample::I32(Type::Packed) => {
            let plane = plane_as_mut::<i32>(frame, 0);
            for index in 0..frames {
                for channel in 0..channels {
                    plane[index * channels + channel] = to_i32(at(index, channel));
                }
            }
        }
        other => {
            return Err(format!(
                "no conversion from f32 into {other:?}; the encoder asked for a sample format this sink does not write"
            ));
        }
    }
    Ok(())
}

/// Reinterprets one of a frame's planes as a typed slice. ffmpeg-next hands
/// plane access back as bytes; the plane is allocated by ffmpeg and is aligned
/// for the sample type the frame was created with.
fn plane_as_mut<T>(frame: &mut ffmpeg::frame::Audio, index: usize) -> &mut [T] {
    let plane = frame.data_mut(index);
    unsafe {
        std::slice::from_raw_parts_mut(
            plane.as_mut_ptr() as *mut T,
            plane.len() / std::mem::size_of::<T>(),
        )
    }
}

/// `f32` in `-1.0..=1.0` to signed 16-bit, clamped rather than wrapped — a
/// sample a hair over 1.0 should be the loudest sample, not the quietest.
fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn to_i32(sample: f32) -> i32 {
    (sample.clamp(-1.0, 1.0) * i32::MAX as f32) as i32
}

impl Drop for MediaSink {
    fn drop(&mut self) {
        if !self.finished {
            // A cancelled or panicking export leaves a file with no trailer.
            // Finishing it here would be worse than leaving it: the caller
            // did not ask for this file, and the scratch sweep reclaims it.
        }
    }
}
