//! Media on the way in: what the editor recognises, and what it can decode.

mod file_types;
mod fps;
mod waveform;

pub use file_types::{
    MEDIA_FILE_FORMATS, MediaFileAcceptResult, MediaFileFormat, MediaFileSupport, MediaFileType,
    MediaFileTypeOptions, MediaFileTypeResult, MediaFormatAdviceResult, MediaFormatEntry,
    MediaFormatLookupOptions, MediaFormatLookupResult, describe_unsupported_media_format,
    describe_unsupported_media_format_value, get_media_format_from_name_value,
    get_media_type_from_file_value, media_file_accept, media_file_accept_value,
    media_file_extension, media_format_from_name, media_type_from_file, media_type_from_mime_type,
};
pub use fps::{
    FloatToFrameRateOptions, FrameRateOptions, FrameRatesEqualOptions, HighestImportedVideoFpsOptions,
    ImportedMediaFps, RaisedProjectFpsOptions, float_to_frame_rate, float_to_frame_rate_value,
    frame_rate_to_float, frame_rate_to_float_value, frame_rates_equal, frame_rates_equal_value,
    get_highest_imported_video_fps, get_highest_imported_video_fps_value,
    get_raised_project_fps_for_imported_media, get_raised_project_fps_for_imported_media_value,
};
pub use waveform::{WaveformBucket, fold_channel_peaks_inner};
