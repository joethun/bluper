//! The container and codec vocabulary an export is described in, and the
//! capability probe that says which of it this machine can actually write.
//!
//! This replaces what `mediabunny` used to answer on the JavaScript side.
//! Two different questions decided what an export ended up as, and they were
//! asked of two different authorities: what a *container* may hold, which is a
//! property of the format, and what this *machine* can encode, which could
//! only be learned by asking WebCodecs. Both are answered here now, by the
//! same ffmpeg build that does the encoding — so the list the export panel
//! offers and the encoder that runs are the same authority, and a codec
//! cannot be offered and then fail to open.
//!
//! [`ExportContainer`] is the muxer, [`ExportVideoCodec`] and
//! [`ExportAudioCodec`] the streams inside it. Each container names the codecs
//! it accepts in preference order; [`capabilities`] intersects that with the
//! encoders ffmpeg was built with.

use std::path::Path;

#[cfg(not(target_arch = "wasm32"))]
mod encoder;
#[cfg(not(target_arch = "wasm32"))]
pub use encoder::MediaSink;

/// The containers an export can be written into. The wire names match the
/// `ExportFormat` union the UI has always used, so the two sides need no
/// translation table.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ExportContainer {
    Mp4,
    Mov,
    Mkv,
    WebM,
    M4a,
    Wav,
    Ogg,
}

/// Video codecs an export may carry. Named as the UI names them (`avc`, not
/// `h264`) because that vocabulary is already in the user's settings.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ExportVideoCodec {
    Avc,
    Hevc,
    Av1,
    Vp9,
    Vp8,
    ProRes,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ExportAudioCodec {
    Aac,
    Opus,
    Vorbis,
    Flac,
    Mp3,
    PcmS16,
    PcmS24,
    PcmF32,
}

impl ExportContainer {
    /// The file extension, and the name ffmpeg knows the muxer by. Both are
    /// needed: the extension is what the user's file ends in, and the muxer is
    /// named explicitly rather than guessed from it, because `.m4a` and `.mp4`
    /// are the same muxer and `.ogg` is not the one a guess would pick for an
    /// Opus stream.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "mkv",
            Self::WebM => "webm",
            Self::M4a => "m4a",
            Self::Wav => "wav",
            Self::Ogg => "ogg",
        }
    }

    pub fn muxer_name(self) -> &'static str {
        match self {
            // `ipod` is ffmpeg's audio-only MP4 muxer, which is what an `.m4a`
            // wants: the plain `mp4` muxer writes a file players will open but
            // that some libraries decline to treat as audio.
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Mkv => "matroska",
            Self::WebM => "webm",
            Self::M4a => "ipod",
            Self::Wav => "wav",
            Self::Ogg => "ogg",
        }
    }

    /// Whether the container carries pictures or is a sound file.
    pub fn is_audio_only(self) -> bool {
        matches!(self, Self::M4a | Self::Wav | Self::Ogg)
    }

    /// Video codecs this container accepts, best first. Preference, not
    /// capability — [`capabilities`] filters this by what ffmpeg can encode.
    pub fn video_codecs(self) -> &'static [ExportVideoCodec] {
        use ExportVideoCodec::*;
        match self {
            Self::Mp4 => &[Avc, Hevc, Av1, Vp9],
            Self::Mov => &[Avc, Hevc, ProRes, Av1, Vp9],
            Self::Mkv => &[Avc, Hevc, Av1, Vp9, Vp8],
            Self::WebM => &[Vp9, Av1, Vp8],
            Self::M4a | Self::Wav | Self::Ogg => &[],
        }
    }

    /// Audio codecs this container accepts, best first.
    pub fn audio_codecs(self) -> &'static [ExportAudioCodec] {
        use ExportAudioCodec::*;
        match self {
            Self::Mp4 => &[Aac, Opus, Flac],
            Self::Mov => &[Aac, Opus, PcmS16, Flac],
            Self::Mkv => &[Opus, Aac, Vorbis, Flac],
            Self::WebM => &[Opus, Vorbis],
            Self::M4a => &[Aac, Opus, Flac],
            Self::Wav => &[PcmS16, PcmS24, PcmF32],
            Self::Ogg => &[Opus, Vorbis],
        }
    }
}

impl ExportVideoCodec {
    /// How the codec is named in the UI, rather than in the spec that defines
    /// it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Avc => "H.264",
            Self::Hevc => "H.265 (HEVC)",
            Self::Av1 => "AV1",
            Self::Vp9 => "VP9",
            Self::Vp8 => "VP8",
            Self::ProRes => "ProRes",
        }
    }
}

impl ExportAudioCodec {
    /// Bitrate for the codecs that take one. Transparent for stereo music and
    /// well above what speech needs. The lossless codecs answer `None`,
    /// because a bitrate would mean nothing to them.
    pub fn bitrate(self) -> Option<u64> {
        match self {
            Self::Aac => Some(192_000),
            Self::Opus => Some(128_000),
            Self::Vorbis => Some(160_000),
            Self::Mp3 => Some(192_000),
            Self::Flac | Self::PcmS16 | Self::PcmS24 | Self::PcmF32 => None,
        }
    }
}

/// What one container can actually be written as on this machine: the
/// container's own preference lists, filtered down to the encoders ffmpeg was
/// built with.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCapability {
    pub container: ExportContainer,
    pub extension: String,
    pub audio_only: bool,
    /// Encodable video codecs, best first. Empty for an audio container, and
    /// also empty for a video container this build cannot encode into at all —
    /// which the caller has to report rather than discover mid-render.
    pub video_codecs: Vec<ExportVideoCodec>,
    pub audio_codecs: Vec<ExportAudioCodec>,
}

/// One configuration of the sink: the container, the streams, and the shape of
/// the frames the caller will hand over.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi))]
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSinkConfig {
    pub container: ExportContainer,
    /// Null for an audio-only export, which renders no frames at all.
    pub video_codec: Option<ExportVideoCodec>,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub video_bitrate: u64,
    /// Null for a silent export. The sink then drops any audio chunk handed
    /// to it rather than erroring, so a caller need not branch.
    pub audio_codec: Option<ExportAudioCodec>,
    pub audio_sample_rate: u32,
    pub audio_channels: u16,
}

impl MediaSinkConfig {
    /// Validates the invariants the encoders rely on. Returns the canonical
    /// reason a config was rejected, so the caller can ask the user to fix the
    /// input rather than face an opaque encoder failure.
    pub fn validate(&self) -> Result<(), String> {
        if self.video_codec.is_some() {
            if self.width == 0 || self.height == 0 {
                return Err("width and height must be > 0".to_string());
            }
            // Every codec here subsamples chroma by two.
            if self.width % 2 != 0 || self.height % 2 != 0 {
                return Err(
                    "width and height must be even for 4:2:0 video (resize the project)"
                        .to_string(),
                );
            }
            if self.fps_numerator == 0 || self.fps_denominator == 0 {
                return Err("fps rational must be > 0".to_string());
            }
            if self.video_bitrate == 0 {
                return Err("video bitrate must be > 0".to_string());
            }
            if !self
                .container
                .video_codecs()
                .contains(&self.video_codec.expect("checked above"))
            {
                return Err(format!(
                    "{:?} cannot carry {:?}",
                    self.container,
                    self.video_codec.expect("checked above")
                ));
            }
        } else if !self.container.is_audio_only() && self.audio_codec.is_none() {
            return Err("an export must carry a video or an audio stream".to_string());
        }

        if let Some(codec) = self.audio_codec {
            if self.audio_channels == 0 || self.audio_channels > 2 {
                return Err("audio channels must be 1 or 2".to_string());
            }
            if self.audio_sample_rate == 0 {
                return Err("audio sample rate must be > 0".to_string());
            }
            if !self.container.audio_codecs().contains(&codec) {
                return Err(format!("{:?} cannot carry {codec:?}", self.container));
            }
        }

        if self.container.is_audio_only() && self.video_codec.is_some() {
            return Err(format!(
                "{:?} is an audio container and cannot carry video",
                self.container
            ));
        }

        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod ffmpeg_ids {
    use super::{ExportAudioCodec, ExportVideoCodec};
    use ffmpeg_next::codec::Id;

    pub fn video(codec: ExportVideoCodec) -> Id {
        match codec {
            ExportVideoCodec::Avc => Id::H264,
            ExportVideoCodec::Hevc => Id::HEVC,
            ExportVideoCodec::Av1 => Id::AV1,
            ExportVideoCodec::Vp9 => Id::VP9,
            ExportVideoCodec::Vp8 => Id::VP8,
            ExportVideoCodec::ProRes => Id::PRORES,
        }
    }

    pub fn audio(codec: ExportAudioCodec) -> Id {
        match codec {
            ExportAudioCodec::Aac => Id::AAC,
            ExportAudioCodec::Opus => Id::OPUS,
            ExportAudioCodec::Vorbis => Id::VORBIS,
            ExportAudioCodec::Flac => Id::FLAC,
            ExportAudioCodec::Mp3 => Id::MP3,
            ExportAudioCodec::PcmS16 => Id::PCM_S16LE,
            ExportAudioCodec::PcmS24 => Id::PCM_S24LE,
            ExportAudioCodec::PcmF32 => Id::PCM_F32LE,
        }
    }
}

/// Finds an encoder for `id`, preferring the external library over ffmpeg's
/// own where the built-in one is a stub.
///
/// `avcodec_find_encoder` answers with whatever is registered, and for several
/// of these that is an experimental native encoder ffmpeg refuses to run
/// without `-strict experimental`. Naming the real one first turns "this
/// machine cannot encode Opus" into "this machine encodes Opus with libopus",
/// which is nearly always the truth.
#[cfg(not(target_arch = "wasm32"))]
fn find_encoder(id: ffmpeg_next::codec::Id) -> Option<ffmpeg_next::codec::codec::Codec> {
    use ffmpeg_next::codec::Id;
    let preferred: &[&str] = match id {
        Id::H264 => &["libx264", "libopenh264"],
        Id::HEVC => &["libx265"],
        Id::AV1 => &["libsvtav1", "libaom-av1", "librav1e"],
        Id::VP9 => &["libvpx-vp9"],
        Id::VP8 => &["libvpx"],
        Id::OPUS => &["libopus"],
        Id::VORBIS => &["libvorbis"],
        Id::MP3 => &["libmp3lame"],
        _ => &[],
    };
    for name in preferred {
        if let Some(codec) = ffmpeg_next::codec::encoder::find_by_name(name) {
            return Some(codec);
        }
    }
    ffmpeg_next::codec::encoder::find(id)
}

/// Which containers and codecs this build can actually write.
///
/// Asked once when the export panel opens. Every answer comes from
/// `avcodec_find_encoder`, so a codec listed here has an encoder present —
/// which is a stronger promise than the old WebCodecs probe made, since that
/// asked the browser about a configuration rather than the library that would
/// run.
#[cfg(not(target_arch = "wasm32"))]
pub fn capabilities() -> Vec<ContainerCapability> {
    const CONTAINERS: &[ExportContainer] = &[
        ExportContainer::Mp4,
        ExportContainer::Mov,
        ExportContainer::Mkv,
        ExportContainer::WebM,
        ExportContainer::M4a,
        ExportContainer::Wav,
        ExportContainer::Ogg,
    ];

    CONTAINERS
        .iter()
        .map(|container| {
            let container = *container;
            ContainerCapability {
                container,
                extension: container.extension().to_string(),
                audio_only: container.is_audio_only(),
                video_codecs: container
                    .video_codecs()
                    .iter()
                    .copied()
                    .filter(|codec| find_encoder(ffmpeg_ids::video(*codec)).is_some())
                    .collect(),
                audio_codecs: container
                    .audio_codecs()
                    .iter()
                    .copied()
                    .filter(|codec| find_encoder(ffmpeg_ids::audio(*codec)).is_some())
                    .collect(),
            }
        })
        .collect()
}

/// Opens a sink after validating its config. The reason a config was rejected
/// reaches the user; the encoder never sees an impossible one.
#[cfg(not(target_arch = "wasm32"))]
pub fn open_media_sink<P: AsRef<Path>>(
    path: P,
    config: MediaSinkConfig,
) -> Result<MediaSink, String> {
    config.validate()?;
    MediaSink::open(path.as_ref(), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video_config(container: ExportContainer, video: ExportVideoCodec) -> MediaSinkConfig {
        MediaSinkConfig {
            container,
            video_codec: Some(video),
            width: 64,
            height: 64,
            fps_numerator: 30,
            fps_denominator: 1,
            video_bitrate: 800_000,
            audio_codec: None,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    #[test]
    fn an_audio_container_refuses_a_video_stream() {
        let config = video_config(ExportContainer::Wav, ExportVideoCodec::Avc);
        assert!(config.validate().is_err());
    }

    #[test]
    fn a_container_refuses_a_codec_it_cannot_carry() {
        // WebM takes VP8/VP9/AV1 and nothing else; H.264 in a WebM is a file
        // no player would open.
        let config = video_config(ExportContainer::WebM, ExportVideoCodec::Avc);
        assert!(config.validate().is_err());
    }

    #[test]
    fn an_odd_size_is_rejected_before_ffmpeg_sees_it() {
        let mut config = video_config(ExportContainer::Mp4, ExportVideoCodec::Avc);
        config.width = 65;
        let message = config.validate().expect_err("odd width should be refused");
        assert!(message.contains("even"), "unhelpful message: {message}");
    }

    #[test]
    fn every_container_names_only_codecs_it_can_carry() {
        // The preference lists and the validator have to agree, or a codec is
        // offered by one and refused by the other.
        for capability in capabilities() {
            for codec in &capability.video_codecs {
                assert!(
                    capability.container.video_codecs().contains(codec),
                    "{:?} offered {codec:?}",
                    capability.container
                );
            }
            for codec in &capability.audio_codecs {
                assert!(
                    capability.container.audio_codecs().contains(codec),
                    "{:?} offered {codec:?}",
                    capability.container
                );
            }
        }
    }

    #[test]
    fn an_audio_container_offers_no_video() {
        for capability in capabilities() {
            if capability.audio_only {
                assert!(capability.video_codecs.is_empty());
            }
        }
    }

    #[test]
    fn mp4_can_be_written_on_this_machine() {
        // Not a property of the code so much as of the build, but an ffmpeg
        // without an H.264 encoder would make every other test here
        // meaningless, and this says so directly.
        let mp4 = capabilities()
            .into_iter()
            .find(|capability| capability.container == ExportContainer::Mp4)
            .expect("mp4 is always listed");
        assert!(
            mp4.video_codecs.contains(&ExportVideoCodec::Avc),
            "this ffmpeg has no H.264 encoder"
        );
        assert!(mp4.audio_codecs.contains(&ExportAudioCodec::Aac));
    }

    #[test]
    fn lossless_codecs_take_no_bitrate() {
        assert_eq!(ExportAudioCodec::Flac.bitrate(), None);
        assert_eq!(ExportAudioCodec::PcmS16.bitrate(), None);
        assert!(ExportAudioCodec::Aac.bitrate().is_some());
    }
}
