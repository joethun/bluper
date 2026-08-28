//! What counts as media on the way in, and what the editor can do with it.
//!
//! `File.type` is the OS's opinion, not the file's: it comes from the shared
//! MIME database on Linux, from the registry on Windows and from the extension
//! map in the webview. Plenty of real media arrives with an empty string — MKV,
//! M2TS and Opus routinely do on Windows — and the import used to reject those
//! outright, because the only question asked was whether the type started with
//! `video/`. The extension is the fallback answer, and between the two nearly
//! everything a user drops in is now recognised.
//!
//! Recognising a container is not the same as decoding it. Frames only ever come
//! from mediabunny, so a container it cannot demux (AVI, WMV, MPEG program
//! streams) can never render, however well the platform plays it elsewhere.
//! Those are listed anyway, with [`MediaFileSupport::Unsupported`], so the
//! import can name the format and say what to convert it to instead of failing
//! anonymously.

use bridge::export;
use serde::{Deserialize, Serialize};

/// The three kinds of media the editor holds. Mirrors `MediaType` on the
/// TypeScript side, which is where this crosses to.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaFileType {
    Image,
    Video,
    Audio,
}

/// - `Decodable`: something in the stack reads it — mediabunny demuxes it
///   through WebCodecs, or the platform decoders do behind `<img>`, `<audio>`
///   or `decodeAudioData`. Not a promise that every engine can: HEIC needs
///   Safari, AIFF needs WebKit. Import probes rather than assumes.
/// - `Unsupported`: recognised only so the failure can be specific.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaFileSupport {
    Decodable,
    Unsupported,
}

/// One row of the format table, as static data. Nothing here is allocated;
/// [`MediaFileFormat`] is the owned copy that crosses the wasm boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaFormatEntry {
    /// Lower-case, no leading dot. The first is the canonical one.
    pub extensions: &'static [&'static str],
    /// MIME to assume when the file arrives without one.
    pub mime: &'static str,
    pub kind: MediaFileType,
    /// How the format is named to the user, e.g. "Matroska (MKV)".
    pub label: &'static str,
    pub support: MediaFileSupport,
}

impl MediaFormatEntry {
    /// The owned shape the boundary sends. `type` rather than `kind`, because
    /// that is the field name the TypeScript callers read.
    fn to_media_file_format(self) -> MediaFileFormat {
        MediaFileFormat {
            extensions: self
                .extensions
                .iter()
                .map(|ext| (*ext).to_string())
                .collect(),
            mime: self.mime.to_string(),
            kind: self.kind,
            label: self.label.to_string(),
            support: self.support,
        }
    }
}

/// Every format the import recognises, in the order the `accept` list wants
/// them: images, then video, then audio.
pub const MEDIA_FILE_FORMATS: &[MediaFormatEntry] = &[
    // Images.
    MediaFormatEntry {
        extensions: &["png", "apng"],
        mime: "image/png",
        kind: MediaFileType::Image,
        label: "PNG",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["jpg", "jpeg", "jpe", "jfif", "pjpeg"],
        mime: "image/jpeg",
        kind: MediaFileType::Image,
        label: "JPEG",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["gif"],
        mime: "image/gif",
        kind: MediaFileType::Image,
        label: "GIF",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["webp"],
        mime: "image/webp",
        kind: MediaFileType::Image,
        label: "WebP",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["avif"],
        mime: "image/avif",
        kind: MediaFileType::Image,
        label: "AVIF",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["svg", "svgz"],
        mime: "image/svg+xml",
        kind: MediaFileType::Image,
        label: "SVG",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["bmp", "dib"],
        mime: "image/bmp",
        kind: MediaFileType::Image,
        label: "BMP",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["ico", "cur"],
        mime: "image/x-icon",
        kind: MediaFileType::Image,
        label: "Icon",
        support: MediaFileSupport::Decodable,
    },
    // Decoded by the platform rather than by anything portable: HEIC needs a
    // system decoder (Safari, and Windows with the codec pack), TIFF needs
    // WebKit. Listed as decodable so the attempt is made — the import falls
    // back to a message naming the format when the attempt fails.
    MediaFormatEntry {
        extensions: &["heic", "heif", "heics"],
        mime: "image/heic",
        kind: MediaFileType::Image,
        label: "HEIC",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["tif", "tiff"],
        mime: "image/tiff",
        kind: MediaFileType::Image,
        label: "TIFF",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["jxl"],
        mime: "image/jxl",
        kind: MediaFileType::Image,
        label: "JPEG XL",
        support: MediaFileSupport::Decodable,
    },
    // Video.
    MediaFormatEntry {
        extensions: &["mp4", "m4v", "mp4v"],
        mime: "video/mp4",
        kind: MediaFileType::Video,
        label: "MP4",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["mov", "qt"],
        mime: "video/quicktime",
        kind: MediaFileType::Video,
        label: "QuickTime (MOV)",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["webm"],
        mime: "video/webm",
        kind: MediaFileType::Video,
        label: "WebM",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["mkv", "mk3d"],
        mime: "video/x-matroska",
        kind: MediaFileType::Video,
        label: "Matroska (MKV)",
        support: MediaFileSupport::Decodable,
    },
    // Camera and broadcast transport streams. AVCHD camcorders write .mts and
    // .m2ts, and neither has ever had a MIME type the OS agrees on.
    MediaFormatEntry {
        extensions: &["ts", "m2ts", "mts", "m2t", "tsv"],
        mime: "video/mp2t",
        kind: MediaFileType::Video,
        label: "MPEG-TS",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["3gp", "3gpp", "3g2", "3gp2"],
        mime: "video/3gpp",
        kind: MediaFileType::Video,
        label: "3GPP",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["ogv"],
        mime: "video/ogg",
        kind: MediaFileType::Video,
        label: "Ogg video",
        support: MediaFileSupport::Decodable,
    },
    // Recognised, never readable: no demuxer in the stack handles these, so the
    // clip would import and then render nothing.
    MediaFormatEntry {
        extensions: &["avi", "divx"],
        mime: "video/x-msvideo",
        kind: MediaFileType::Video,
        label: "AVI",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["wmv", "asf"],
        mime: "video/x-ms-wmv",
        kind: MediaFileType::Video,
        label: "Windows Media",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["flv", "f4v"],
        mime: "video/x-flv",
        kind: MediaFileType::Video,
        label: "Flash video",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["mpg", "mpeg", "mpe", "m1v", "m2v", "vob", "mod"],
        mime: "video/mpeg",
        kind: MediaFileType::Video,
        label: "MPEG program stream",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["rm", "rmvb"],
        mime: "application/vnd.rn-realmedia",
        kind: MediaFileType::Video,
        label: "RealMedia",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["mxf"],
        mime: "application/mxf",
        kind: MediaFileType::Video,
        label: "MXF",
        support: MediaFileSupport::Unsupported,
    },
    // Audio.
    MediaFormatEntry {
        extensions: &["mp3"],
        mime: "audio/mpeg",
        kind: MediaFileType::Audio,
        label: "MP3",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["m4a", "m4b", "m4r"],
        mime: "audio/mp4",
        kind: MediaFileType::Audio,
        label: "MPEG-4 audio",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["aac", "adts"],
        mime: "audio/aac",
        kind: MediaFileType::Audio,
        label: "AAC",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["wav", "wave"],
        mime: "audio/wav",
        kind: MediaFileType::Audio,
        label: "WAVE",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["flac"],
        mime: "audio/flac",
        kind: MediaFileType::Audio,
        label: "FLAC",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["opus"],
        mime: "audio/opus",
        kind: MediaFileType::Audio,
        label: "Opus",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["ogg", "oga"],
        mime: "audio/ogg",
        kind: MediaFileType::Audio,
        label: "Ogg audio",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["weba"],
        mime: "audio/webm",
        kind: MediaFileType::Audio,
        label: "WebM audio",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["mka"],
        mime: "audio/x-matroska",
        kind: MediaFileType::Audio,
        label: "Matroska audio",
        support: MediaFileSupport::Decodable,
    },
    // No WebCodecs path, but `decodeAudioData` runs the platform decoders and
    // WebKit reads both — which is what the desktop build runs on.
    MediaFormatEntry {
        extensions: &["aif", "aiff", "aifc"],
        mime: "audio/aiff",
        kind: MediaFileType::Audio,
        label: "AIFF",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["caf"],
        mime: "audio/x-caf",
        kind: MediaFileType::Audio,
        label: "Core Audio",
        support: MediaFileSupport::Decodable,
    },
    MediaFormatEntry {
        extensions: &["wma"],
        mime: "audio/x-ms-wma",
        kind: MediaFileType::Audio,
        label: "Windows Media Audio",
        support: MediaFileSupport::Unsupported,
    },
    MediaFormatEntry {
        extensions: &["amr", "awb"],
        mime: "audio/amr",
        kind: MediaFileType::Audio,
        label: "AMR",
        support: MediaFileSupport::Unsupported,
    },
];

/// MIME types that describe media without saying so in the prefix. `.ogg` and
/// `.m4a` are the ones seen in the wild; the generic bucket is what an OS falls
/// back to when it recognises nothing, so it resolves by extension instead.
const MIME_TYPE_OVERRIDES: &[(&str, MediaFileType)] = &[
    ("application/ogg", MediaFileType::Audio),
    ("application/x-ogg", MediaFileType::Audio),
    ("application/mp4", MediaFileType::Video),
    ("application/x-matroska", MediaFileType::Video),
    ("application/x-mpegurl", MediaFileType::Video),
    ("application/vnd.apple.mpegurl", MediaFileType::Video),
];

/// The extension of `name`, lower-cased and without the dot. Empty when there
/// is nothing to read: a dotfile (the dot leads), a trailing dot, or no dot at
/// all. Only the last dot counts, so `clip.final.mp4` is an MP4.
pub fn media_file_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(at) if at > 0 && at + 1 < name.len() => name[at + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// The table entry for a filename, or `None` when the extension is unknown.
pub fn media_format_from_name(name: &str) -> Option<&'static MediaFormatEntry> {
    let extension = media_file_extension(name);
    if extension.is_empty() {
        return None;
    }
    MEDIA_FILE_FORMATS
        .iter()
        .find(|format| format.extensions.contains(&extension.as_str()))
}

/// The media kind a MIME type describes, or `None` when it describes something
/// else — or nothing, which is the common case for media on Windows.
pub fn media_type_from_mime_type(mime_type: &str) -> Option<MediaFileType> {
    let lowered = mime_type.to_lowercase();
    // A `type/subtype; parameter=value` string carries its parameters after a
    // semicolon; only the essence names the kind.
    let normalized = lowered.split(';').next().unwrap_or("").trim();
    if normalized.is_empty() {
        return None;
    }

    if normalized.starts_with("image/") {
        return Some(MediaFileType::Image);
    }
    if normalized.starts_with("video/") {
        return Some(MediaFileType::Video);
    }
    if normalized.starts_with("audio/") {
        return Some(MediaFileType::Audio);
    }

    MIME_TYPE_OVERRIDES
        .iter()
        .find(|(mime, _)| *mime == normalized)
        .map(|(_, kind)| *kind)
}

/// What kind of media a file holds: its MIME type when the OS supplied a usable
/// one, its extension otherwise. `None` means neither recognised it.
pub fn media_type_from_file(name: &str, mime_type: &str) -> Option<MediaFileType> {
    media_type_from_mime_type(mime_type)
        .or_else(|| media_format_from_name(name).map(|format| format.kind))
}

/// The `accept` for a file input. Wildcards come first so anything the OS knows
/// to be media is offered; the explicit extensions cover the containers it has
/// no MIME type for, which is exactly the set the wildcards would hide.
pub fn media_file_accept() -> String {
    let mut patterns = vec![
        "image/*".to_string(),
        "video/*".to_string(),
        "audio/*".to_string(),
    ];
    for format in MEDIA_FILE_FORMATS {
        for extension in format.extensions {
            patterns.push(format!(".{extension}"));
        }
    }
    patterns.join(",")
}

/// Why a recognised file cannot be used, phrased as advice. `None` for formats
/// the editor expects to read, whose failures are reported from the decoder
/// rather than guessed at here.
pub fn describe_unsupported_media_format(name: &str) -> Option<String> {
    let format = media_format_from_name(name)?;
    if format.support != MediaFileSupport::Unsupported {
        return None;
    }

    let target = match format.kind {
        MediaFileType::Audio => "WAV, MP3 or FLAC",
        _ => "MP4, MOV or MKV",
    };
    Some(format!(
        "{} files can't be decoded here. Convert this to {target} and reimport it.",
        format.label
    ))
}

// Bridge surface.

/// The owned form of a [`MediaFormatEntry`], as JavaScript sees it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileFormat {
    pub extensions: Vec<String>,
    pub mime: String,
    #[serde(rename = "type")]
    pub kind: MediaFileType,
    pub label: String,
    pub support: MediaFileSupport,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormatLookupOptions {
    pub name: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormatLookupResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<MediaFileFormat>,
}

#[export]
pub fn get_media_format_from_name_value(
    MediaFormatLookupOptions { name }: MediaFormatLookupOptions,
) -> MediaFormatLookupResult {
    MediaFormatLookupResult {
        format: media_format_from_name(&name).map(|entry| entry.to_media_file_format()),
    }
}

/// A `File` cannot cross the boundary, so this takes the two fields the
/// classification actually reads. An absent `mimeType` is the same as an empty
/// one — which is what a typeless MKV on Windows hands over.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileTypeOptions {
    pub name: String,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileTypeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<MediaFileType>,
}

#[export]
pub fn get_media_type_from_file_value(
    MediaFileTypeOptions { name, mime_type }: MediaFileTypeOptions,
) -> MediaFileTypeResult {
    MediaFileTypeResult {
        media_type: media_type_from_file(&name, mime_type.as_deref().unwrap_or("")),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFormatAdviceResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advice: Option<String>,
}

#[export]
pub fn describe_unsupported_media_format_value(
    MediaFormatLookupOptions { name }: MediaFormatLookupOptions,
) -> MediaFormatAdviceResult {
    MediaFormatAdviceResult {
        advice: describe_unsupported_media_format(&name),
    }
}

/// The joined `accept` string, wrapped: a bare `Vec<String>` crosses as an
/// object with numeric keys, and a bare string would still need a name on the
/// far side.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaFileAcceptResult {
    pub accept: String,
}

#[export]
pub fn media_file_accept_value() -> MediaFileAcceptResult {
    MediaFileAcceptResult {
        accept: media_file_accept(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_extension_in_the_table_resolves_to_its_own_format() {
        for format in MEDIA_FILE_FORMATS {
            for extension in format.extensions {
                let found = media_format_from_name(&format!("clip.{extension}"))
                    .unwrap_or_else(|| panic!("no format for .{extension}"));
                assert_eq!(
                    found.label, format.label,
                    ".{extension} resolved to the wrong format"
                );
            }
        }
    }

    #[test]
    fn no_extension_is_claimed_by_two_formats() {
        let mut seen: Vec<&str> = Vec::new();
        for format in MEDIA_FILE_FORMATS {
            for extension in format.extensions {
                assert!(
                    !seen.contains(extension),
                    ".{extension} is listed on more than one format"
                );
                seen.push(extension);
            }
        }
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        // The TypeScript lower-cases the extension before the lookup, so a
        // camcorder's `CLIP.M2TS` and a Windows `IMAGE.JPG` both resolve.
        assert_eq!(
            media_format_from_name("CLIP.M2TS").map(|f| f.label),
            Some("MPEG-TS")
        );
        assert_eq!(
            media_format_from_name("Image.JpG").map(|f| f.label),
            Some("JPEG")
        );
    }

    #[test]
    fn a_name_without_an_extension_resolves_to_nothing() {
        assert_eq!(media_file_extension("clip"), "");
        assert!(media_format_from_name("clip").is_none());
        // A trailing dot leaves nothing to read.
        assert_eq!(media_file_extension("clip."), "");
        assert!(media_format_from_name("clip.").is_none());
        // A leading dot is a dotfile, not an extension.
        assert_eq!(media_file_extension(".mp4"), "");
        assert!(media_format_from_name(".mp4").is_none());
        assert_eq!(media_file_extension(""), "");
        assert!(media_format_from_name("").is_none());
    }

    #[test]
    fn only_the_last_dot_counts() {
        assert_eq!(media_file_extension("my.holiday.clip.MP4"), "mp4");
        assert_eq!(
            media_format_from_name("my.holiday.clip.MP4").map(|f| f.label),
            Some("MP4")
        );
        // An earlier segment that looks like an extension is ignored.
        assert!(media_format_from_name("song.mp3.txt").is_none());
    }

    #[test]
    fn an_unknown_extension_resolves_to_nothing() {
        assert!(media_format_from_name("notes.txt").is_none());
        assert!(media_format_from_name("archive.zip").is_none());
        assert!(media_format_from_name("clip.mp5").is_none());
    }

    #[test]
    fn mime_type_prefixes_win_before_the_overrides() {
        assert_eq!(
            media_type_from_mime_type("image/png"),
            Some(MediaFileType::Image)
        );
        assert_eq!(
            media_type_from_mime_type("VIDEO/MP4"),
            Some(MediaFileType::Video)
        );
        // Parameters after the semicolon are not part of the essence.
        assert_eq!(
            media_type_from_mime_type("audio/ogg; codecs=opus"),
            Some(MediaFileType::Audio)
        );
        assert_eq!(media_type_from_mime_type(""), None);
        assert_eq!(media_type_from_mime_type("   "), None);
        assert_eq!(media_type_from_mime_type("text/plain"), None);
    }

    #[test]
    fn generic_container_mime_types_resolve_through_the_overrides() {
        assert_eq!(
            media_type_from_mime_type("application/ogg"),
            Some(MediaFileType::Audio)
        );
        assert_eq!(
            media_type_from_mime_type("application/x-matroska"),
            Some(MediaFileType::Video)
        );
        assert_eq!(media_type_from_mime_type("application/octet-stream"), None);
    }

    #[test]
    fn the_mime_type_beats_the_extension_and_the_extension_is_the_fallback() {
        // The OS's opinion is taken first, even when the extension disagrees.
        assert_eq!(
            media_type_from_file("clip.mp4", "audio/mpeg"),
            Some(MediaFileType::Audio)
        );
        // The typeless case that motivated the extension fallback.
        assert_eq!(
            media_type_from_file("clip.mkv", ""),
            Some(MediaFileType::Video)
        );
        assert_eq!(media_type_from_file("notes.txt", ""), None);
        assert_eq!(media_type_from_file("notes.txt", "text/plain"), None);
    }

    #[test]
    fn unsupported_formats_are_described_with_a_conversion_target() {
        assert_eq!(
            describe_unsupported_media_format("clip.avi").as_deref(),
            Some(
                "AVI files can't be decoded here. Convert this to MP4, MOV or MKV and reimport it."
            )
        );
        assert_eq!(
            describe_unsupported_media_format("track.wma").as_deref(),
            Some(
                "Windows Media Audio files can't be decoded here. Convert this to WAV, MP3 or FLAC and reimport it."
            )
        );
        assert_eq!(
            describe_unsupported_media_format("stream.MPG").as_deref(),
            Some(
                "MPEG program stream files can't be decoded here. Convert this to MP4, MOV or MKV and reimport it."
            )
        );
    }

    #[test]
    fn decodable_and_unknown_formats_get_no_description() {
        // A decodable format's failures come from the decoder, not from here.
        assert_eq!(describe_unsupported_media_format("clip.mp4"), None);
        assert_eq!(describe_unsupported_media_format("notes.txt"), None);
        assert_eq!(describe_unsupported_media_format("clip"), None);
    }

    #[test]
    fn the_accept_list_starts_with_the_wildcards_and_then_every_extension() {
        let accept = media_file_accept();
        let patterns: Vec<&str> = accept.split(',').collect();
        assert_eq!(&patterns[..3], &["image/*", "video/*", "audio/*"]);

        let extension_count: usize = MEDIA_FILE_FORMATS
            .iter()
            .map(|format| format.extensions.len())
            .sum();
        assert_eq!(patterns.len(), 3 + extension_count);
        // Table order, dotted: the first image format's canonical extension
        // follows the wildcards.
        assert_eq!(patterns[3], ".png");
        assert!(patterns.contains(&".mp4"));
        assert!(patterns.contains(&".amr"));
    }

    #[test]
    fn the_bridge_surface_reports_the_same_answers() {
        let looked_up = get_media_format_from_name_value(MediaFormatLookupOptions {
            name: "clip.mkv".to_string(),
        });
        let format = looked_up.format.expect("mkv is in the table");
        assert_eq!(format.label, "Matroska (MKV)");
        assert_eq!(format.kind, MediaFileType::Video);
        assert_eq!(format.mime, "video/x-matroska");
        assert_eq!(format.extensions, vec!["mkv", "mk3d"]);

        assert!(
            get_media_format_from_name_value(MediaFormatLookupOptions {
                name: "notes.txt".to_string(),
            })
            .format
            .is_none()
        );

        // A missing `mimeType` is the typeless Windows case.
        assert_eq!(
            get_media_type_from_file_value(MediaFileTypeOptions {
                name: "clip.m2ts".to_string(),
                mime_type: None,
            })
            .media_type,
            Some(MediaFileType::Video)
        );

        assert!(
            describe_unsupported_media_format_value(MediaFormatLookupOptions {
                name: "clip.wmv".to_string(),
            })
            .advice
            .is_some()
        );

        assert_eq!(media_file_accept_value().accept, media_file_accept());
    }
}
