//! The sizes an export may be rendered at, and the bitrate each one deserves.
//!
//! A project has one canvas size; an export does not have to use it. The panel
//! offers a ladder of smaller sizes so a 4K timeline can be handed over as a
//! 720p file without the user resizing the project and moving every clip.
//!
//! Two constraints shape what may be offered, and both are the encoder's rather
//! than the UI's:
//!
//! - **Every dimension has to be even.** 4:2:0 chroma is subsampled by two in
//!   each axis, so an odd side has no representation at all — `SinkConfig`
//!   refuses it outright (see `sink::encoder`). The rungs are even by
//!   construction and the derived side is rounded to even, which is also why
//!   the ladder is built from the *rounded* canvas rather than the raw one: a
//!   1001-pixel-wide project exports at 1002 and every rung below it is
//!   measured against that, so the aspect the user sees offered is the aspect
//!   they get.
//! - **Nothing upscales.** A rung at or above the project's own short side
//!   would encode invented pixels at a larger file size, so the project's own
//!   size is always the top entry and the ladder starts below it.
//!
//! The "p" number names the *short* side, which is the convention for both
//! orientations: 1920x1080 and 1080x1920 are both "1080p", and picking 720p
//! from either lands on 1280x720 and 720x1280 respectively. Labelling is the
//! UI's business, but the number it labels with is decided here so that the
//! offered name and the encoded frame cannot disagree.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::project::CanvasSize;

/// The short sides an export may be scaled down to, tallest first.
///
/// Every entry is even, which is what lets the named side be used verbatim
/// rather than rounded. Rungs at or above a project's own short side are
/// dropped when the ladder is built, so this list covers every canvas rather
/// than describing any one of them.
const RESOLUTION_LADDER: [u32; 7] = [2160, 1440, 1080, 720, 480, 360, 240];

/// The smallest bitrate a scaled-down export is given, in bits per second.
///
/// Scaling the source's bitrate by area is right until the area gets small,
/// where a proportional share of a low-bitrate source is not enough to hold a
/// picture together. The floor is itself capped at the source's own bitrate in
/// [`export_video_bitrate`] — raising an export above what went in would be
/// spending bits on detail that was never there.
const MIN_EXPORT_BITRATE: u32 = 400_000;

/// One size the export panel may offer.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResolution {
    /// The shorter of the two sides — the number the "p" in "1080p" names.
    pub short_side: u32,
    pub width: u32,
    pub height: u32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ListExportResolutionsOptions {
    pub canvas: CanvasSize,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportVideoBitrateOptions {
    /// What the project's own resolution would be encoded at — the source
    /// video's bitrate, or the exporter's fallback when there is no source.
    pub source_bitrate: u32,
    pub canvas: CanvasSize,
    pub output: ExportResolution,
}

/// The nearest even number of pixels, never zero.
///
/// Rounds to even rather than flooring so a scaled side lands on whichever
/// even number is actually closest: 853.33 becomes 854, which is the size a
/// 16:9 480p frame has everywhere else. A non-finite or non-positive input is
/// a corrupt project rather than a size, and answers the smallest frame an
/// encoder will take instead of panicking on the cast.
fn to_even_pixels(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 2;
    }
    let pairs = (value / 2.0).round().max(1.0);
    (pairs as u32).saturating_mul(2)
}

/// The project's own size, rounded to something an encoder will take.
fn native_resolution(canvas: CanvasSize) -> ExportResolution {
    let width = to_even_pixels(canvas.width);
    let height = to_even_pixels(canvas.height);
    ExportResolution {
        short_side: width.min(height),
        width,
        height,
    }
}

pub fn list_export_resolutions_inner(canvas: CanvasSize) -> Vec<ExportResolution> {
    let native = native_resolution(canvas);
    let mut resolutions = vec![native];

    for short_side in RESOLUTION_LADDER {
        if short_side >= native.short_side {
            continue;
        }
        // Measured against the native *rounded* size, so the scale the caller
        // can derive back out of a pair of widths is the one this used.
        let scale = f64::from(short_side) / f64::from(native.short_side);
        let long_side = to_even_pixels(f64::from(native.width.max(native.height)) * scale);
        resolutions.push(if native.width <= native.height {
            ExportResolution {
                short_side,
                width: short_side,
                height: long_side,
            }
        } else {
            ExportResolution {
                short_side,
                width: long_side,
                height: short_side,
            }
        });
    }

    resolutions
}

pub fn export_video_bitrate_inner(
    source_bitrate: u32,
    canvas: CanvasSize,
    output: ExportResolution,
) -> u32 {
    let native = native_resolution(canvas);
    let canvas_pixels = f64::from(native.width) * f64::from(native.height);
    let output_pixels = f64::from(output.width) * f64::from(output.height);
    if canvas_pixels <= 0.0 {
        return source_bitrate;
    }

    // Bits scale with area, which errs generous: the same bits spread over
    // fewer pixels is a slightly better picture, not a worse one.
    let share = (output_pixels / canvas_pixels).clamp(0.0, 1.0);
    let scaled = (f64::from(source_bitrate) * share).round().max(0.0) as u32;
    scaled.max(MIN_EXPORT_BITRATE.min(source_bitrate))
}

/// The sizes this project may be exported at, its own first and then each
/// standard rung below it.
#[export]
pub fn list_export_resolutions(
    ListExportResolutionsOptions { canvas }: ListExportResolutionsOptions,
) -> Vec<ExportResolution> {
    list_export_resolutions_inner(canvas)
}

/// What to encode `output` at, given what the project's own resolution would
/// have been encoded at.
#[export]
pub fn export_video_bitrate(
    ExportVideoBitrateOptions {
        source_bitrate,
        canvas,
        output,
    }: ExportVideoBitrateOptions,
) -> u32 {
    export_video_bitrate_inner(source_bitrate, canvas, output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canvas(width: f64, height: f64) -> CanvasSize {
        CanvasSize { width, height }
    }

    fn sizes(canvas: CanvasSize) -> Vec<(u32, u32, u32)> {
        list_export_resolutions_inner(canvas)
            .into_iter()
            .map(|entry| (entry.short_side, entry.width, entry.height))
            .collect()
    }

    #[test]
    fn a_landscape_project_gets_its_own_size_and_every_rung_below_it() {
        assert_eq!(
            sizes(canvas(1920.0, 1080.0)),
            vec![
                (1080, 1920, 1080),
                (720, 1280, 720),
                (480, 854, 480),
                (360, 640, 360),
                (240, 426, 240),
            ]
        );
    }

    /// The same ladder turned on its side. A portrait project's "p" number is
    /// its width, so 720p is 720x1280 rather than a landscape frame.
    #[test]
    fn a_portrait_project_measures_its_rungs_across() {
        assert_eq!(
            sizes(canvas(1080.0, 1920.0)),
            vec![
                (1080, 1080, 1920),
                (720, 720, 1280),
                (480, 480, 854),
                (360, 360, 640),
                (240, 240, 426),
            ]
        );
    }

    #[test]
    fn a_square_project_keeps_its_aspect_down_the_ladder() {
        assert_eq!(
            sizes(canvas(1080.0, 1080.0)),
            vec![
                (1080, 1080, 1080),
                (720, 720, 720),
                (480, 480, 480),
                (360, 360, 360),
                (240, 240, 240),
            ]
        );
    }

    /// The encoder refuses an odd side outright, so nothing this produces may
    /// have one — including the entry for the project's own size, which is the
    /// only one not derived from an even rung.
    #[test]
    fn every_offered_side_is_even() {
        for size in [
            canvas(1920.0, 1080.0),
            canvas(1001.0, 563.0),
            canvas(1440.0, 1080.0),
            canvas(3840.0, 2160.0),
            canvas(1080.0, 1920.0),
        ] {
            for entry in list_export_resolutions_inner(size) {
                assert_eq!(entry.width % 2, 0, "odd width for {size:?}");
                assert_eq!(entry.height % 2, 0, "odd height for {size:?}");
                assert_eq!(entry.short_side, entry.width.min(entry.height));
            }
        }
    }

    /// A rung equal to the project's own short side would be the same file
    /// under a second name, and one above it would be invented pixels.
    #[test]
    fn nothing_upscales_and_the_native_rung_is_not_repeated() {
        let ladder = list_export_resolutions_inner(canvas(1280.0, 720.0));
        assert_eq!(ladder[0].short_side, 720);
        assert!(
            ladder[1..].iter().all(|entry| entry.short_side < 720),
            "{ladder:?}"
        );
    }

    /// An odd canvas is rounded, and the ladder is measured against the
    /// rounded size — otherwise the offered aspect and the encoded one drift.
    /// A side exactly between two even numbers goes up, which is arbitrary but
    /// has to be pinned: it is a pixel either way, and the renderer scales to
    /// whichever this picks.
    #[test]
    fn an_odd_canvas_is_rounded_before_the_ladder_is_built() {
        assert_eq!(sizes(canvas(1001.0, 563.0))[0], (564, 1002, 564));
        assert_eq!(sizes(canvas(1003.0, 565.0))[0], (566, 1004, 566));
    }

    /// A project too small for any rung still exports at its own size.
    #[test]
    fn a_tiny_project_offers_only_itself() {
        assert_eq!(sizes(canvas(320.0, 200.0)), vec![(200, 320, 200)]);
    }

    #[test]
    fn bitrate_follows_the_area_it_is_spread_over() {
        let project = canvas(1920.0, 1080.0);
        let half_height = ExportResolution {
            short_side: 540,
            width: 960,
            height: 540,
        };
        assert_eq!(
            export_video_bitrate_inner(8_000_000, project, half_height),
            2_000_000
        );
    }

    #[test]
    fn the_project_s_own_size_keeps_the_source_bitrate() {
        let project = canvas(1920.0, 1080.0);
        let native = list_export_resolutions_inner(project)[0];
        assert_eq!(export_video_bitrate_inner(6_000_000, project, native), 6_000_000);
    }

    /// The floor stops a small rung from collapsing to an unwatchable
    /// bitrate — but it must not *raise* an export above its source, which
    /// would spend bits on detail the source never had.
    #[test]
    fn the_floor_never_exceeds_the_source() {
        let project = canvas(1920.0, 1080.0);
        let smallest = *list_export_resolutions_inner(project).last().unwrap();

        assert_eq!(
            export_video_bitrate_inner(1_000_000, project, smallest),
            MIN_EXPORT_BITRATE
        );
        assert_eq!(
            export_video_bitrate_inner(150_000, project, smallest),
            150_000
        );
    }
}
