//! Held stills: where a clip shows the frame pinned at a particular source time
//! rather than continuing to walk the source. The freeze replaces the clip's
//! own progress for its whole span.

use bridge::export;
use serde::Deserialize;

use crate::model::{FreezeConfig, RetimeConfig};
use crate::retime::{get_source_time_at_clip_time, SourceTimeAtClipTimeOptions};

/// The source time a clip samples at `clipTime`. A frozen clip ignores its own
/// progress and holds the pinned frame for its whole span; everything else walks
/// the source at whatever rate retime asks for. `clipDuration` is what places a
/// speed curve's handles in time, so a curved clip needs it to answer exactly.
///
/// Both the preview and the exporter go through here, so a still looks the same
/// on screen as it does in the finished file.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSampledSourceTimeOptions {
    #[serde(default)]
    pub freeze: Option<FreezeConfig>,
    pub trim_start: i64,
    pub clip_time: f64,
    #[serde(default)]
    pub clip_duration: Option<f64>,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
}

/// Rounded to the nearest tick — matches `roundMediaTime` on the TypeScript side,
/// which is half-away-from-zero so the result always lands on the integer-tick
/// lattice the rest of the editor lives on.
#[export]
pub fn resolve_sampled_source_time(
    ResolveSampledSourceTimeOptions {
        freeze,
        trim_start,
        clip_time,
        clip_duration,
        retime,
    }: ResolveSampledSourceTimeOptions,
) -> i64 {
    if let Some(freeze) = freeze {
        return freeze.source_time.as_ticks();
    }

    let source_span = get_source_time_at_clip_time(SourceTimeAtClipTimeOptions {
        clip_time,
        clip_duration,
        retime,
    });
    ((trim_start as f64) + source_span).round() as i64
}

#[cfg(test)]
mod tests {
    use time::MediaTime;

    use super::*;

    fn freeze(source_time_ticks: i64) -> FreezeConfig {
        FreezeConfig {
            source_time: MediaTime::from_ticks(source_time_ticks),
        }
    }

    #[test]
    fn a_freeze_holds_its_pinned_frame_regardless_of_clip_time() {
        assert_eq!(
            resolve_sampled_source_time(ResolveSampledSourceTimeOptions {
                freeze: Some(freeze(12_345)),
                trim_start: 0,
                clip_time: 0.0,
                clip_duration: None,
                retime: None,
            }),
            12_345
        );
        // Halfway through a 3s clip: still 12_345.
        assert_eq!(
            resolve_sampled_source_time(ResolveSampledSourceTimeOptions {
                freeze: Some(freeze(12_345)),
                trim_start: 999,
                clip_time: 1500.0,
                clip_duration: Some(3000.0),
                retime: Some(RetimeConfig {
                    rate: 2.0,
                    maintain_pitch: None,
                    curve: None,
                }),
            }),
            12_345
        );
    }

    #[test]
    fn a_uniform_retime_walks_the_source_at_its_own_rate() {
        // rate=2 with no curve means we walk the source twice as fast as the clip:
        // clipTime 1000 → sourceSpan 2000, plus trimStart 2000 → 4000.
        let result = resolve_sampled_source_time(ResolveSampledSourceTimeOptions {
            freeze: None,
            trim_start: 2000,
            clip_time: 1000.0,
            clip_duration: Some(4000.0),
            retime: Some(RetimeConfig {
                rate: 2.0,
                maintain_pitch: None,
                curve: None,
            }),
        });
        assert_eq!(result, 4000);
    }

    #[test]
    fn a_slowed_down_clip_walks_less_of_the_source() {
        // rate=0.5 (half speed): clipTime 1000 → sourceSpan 500, plus trimStart 2000 → 2500.
        let result = resolve_sampled_source_time(ResolveSampledSourceTimeOptions {
            freeze: None,
            trim_start: 2000,
            clip_time: 1000.0,
            clip_duration: Some(4000.0),
            retime: Some(RetimeConfig {
                rate: 0.5,
                maintain_pitch: None,
                curve: None,
            }),
        });
        assert_eq!(result, 2500);
    }

    #[test]
    fn a_uniform_retime_at_unit_rate_equals_clip_time() {
        let result = resolve_sampled_source_time(ResolveSampledSourceTimeOptions {
            freeze: None,
            trim_start: 100,
            clip_time: 500.0,
            clip_duration: Some(1000.0),
            retime: None,
        });
        assert_eq!(result, 600);
    }
}
