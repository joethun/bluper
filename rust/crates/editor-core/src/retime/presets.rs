//! The stock speed shapes, and the two ways a `RetimeConfig` gets built.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::{RetimeConfig, RetimeCurve, RetimeCurvePoint, RetimeCurvePresetId};

use super::curve::{curve_clip_per_source, sanitize_retime_curve};
use super::rate::clamp_retime_rate;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildConstantRetimeOptions {
    pub rate: f64,
    #[serde(default)]
    pub maintain_pitch: Option<bool>,
}

#[export]
pub fn build_constant_retime(
    BuildConstantRetimeOptions {
        rate,
        maintain_pitch,
    }: BuildConstantRetimeOptions,
) -> RetimeConfig {
    RetimeConfig {
        rate: clamp_retime_rate(rate),
        maintain_pitch: Some(maintain_pitch.unwrap_or(false)),
        curve: None,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildCurveRetimeOptions {
    pub curve: RetimeCurve,
    #[serde(default)]
    pub maintain_pitch: Option<bool>,
}

/// A curved retime. `rate` is filled in with the curve's average speed so that
/// anything describing the clip with one number — a badge on the timeline, a
/// fallback with no clip length to hand — still says something true about it.
#[export]
pub fn build_curve_retime(
    BuildCurveRetimeOptions {
        curve,
        maintain_pitch,
    }: BuildCurveRetimeOptions,
) -> RetimeConfig {
    let sanitized = sanitize_retime_curve(&curve);
    let clip_per_source = curve_clip_per_source(&sanitized);

    RetimeConfig {
        rate: clamp_retime_rate(if clip_per_source > 0.0 {
            1.0 / clip_per_source
        } else {
            1.0
        }),
        maintain_pitch: Some(maintain_pitch.unwrap_or(false)),
        curve: Some(sanitized),
    }
}

/// A preset is just handles: the same spline the editor draws through them is
/// what plays, so it is a starting point to drag rather than a fixed effect.
///
/// `label` travels with the points because the two are one list — adding a
/// preset should not mean editing a table in each language. If these are ever
/// translated, this becomes a key rather than a string.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetimeCurvePreset {
    pub id: RetimeCurvePresetId,
    pub label: String,
    pub points: Vec<RetimeCurvePoint>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetimeCurvePresets {
    pub presets: Vec<RetimeCurvePreset>,
}

fn point(position: f64, rate: f64) -> RetimeCurvePoint {
    RetimeCurvePoint { position, rate }
}

fn presets() -> Vec<RetimeCurvePreset> {
    vec![
        RetimeCurvePreset {
            id: RetimeCurvePresetId::Custom,
            label: "Custom".to_string(),
            points: vec![point(0.0, 1.0), point(0.5, 1.0), point(1.0, 1.0)],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::Montage,
            label: "Montage".to_string(),
            points: vec![
                point(0.0, 1.0),
                point(0.15, 1.0),
                point(0.35, 6.0),
                point(0.55, 0.3),
                point(0.75, 1.0),
                point(1.0, 1.0),
            ],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::Hero,
            label: "Hero".to_string(),
            points: vec![
                point(0.0, 1.0),
                point(0.2, 1.0),
                point(0.4, 0.3),
                point(0.6, 4.0),
                point(0.8, 1.0),
                point(1.0, 1.0),
            ],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::Bullet,
            label: "Bullet".to_string(),
            points: vec![
                point(0.0, 4.0),
                point(0.3, 4.0),
                point(0.42, 0.2),
                point(0.58, 0.2),
                point(0.7, 4.0),
                point(1.0, 4.0),
            ],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::JumpCut,
            label: "Jump Cut".to_string(),
            points: vec![
                point(0.0, 1.0),
                point(0.25, 1.0),
                point(0.4, 5.0),
                point(0.6, 5.0),
                point(0.75, 1.0),
                point(1.0, 1.0),
            ],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::FlashIn,
            label: "Flash In".to_string(),
            points: vec![point(0.0, 8.0), point(0.3, 1.0), point(1.0, 1.0)],
        },
        RetimeCurvePreset {
            id: RetimeCurvePresetId::FlashOut,
            label: "Flash Out".to_string(),
            points: vec![point(0.0, 1.0), point(0.7, 1.0), point(1.0, 8.0)],
        },
    ]
}

#[export]
pub fn get_retime_curve_presets() -> RetimeCurvePresets {
    RetimeCurvePresets {
        presets: presets(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildRetimeCurvePresetOptions {
    pub preset_id: RetimeCurvePresetId,
}

#[export]
pub fn build_retime_curve_preset(
    BuildRetimeCurvePresetOptions { preset_id }: BuildRetimeCurvePresetOptions,
) -> RetimeCurve {
    let all = presets();
    // An unknown id falls back to the first preset rather than failing, which
    // is what the TypeScript's `?? RETIME_CURVE_PRESETS[0]` does.
    let preset = all
        .iter()
        .find(|candidate| candidate.id == preset_id)
        .unwrap_or(&all[0]);

    sanitize_retime_curve(&RetimeCurve {
        preset: preset.id,
        points: preset.points.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_reachable_by_its_own_id() {
        for preset in presets() {
            let built = build_retime_curve_preset(BuildRetimeCurvePresetOptions {
                preset_id: preset.id,
            });
            assert_eq!(built.preset, preset.id);
            assert!(!built.points.is_empty());
        }
    }

    #[test]
    fn a_built_preset_already_spans_the_whole_clip() {
        // Sanitising pins a handle at each end, so no preset can leave part of
        // the clip without a speed.
        for preset in presets() {
            let built = build_retime_curve_preset(BuildRetimeCurvePresetOptions {
                preset_id: preset.id,
            });
            assert_eq!(built.points[0].position, 0.0, "{:?}", preset.id);
            assert_eq!(
                built.points[built.points.len() - 1].position,
                1.0,
                "{:?}",
                preset.id
            );
        }
    }

    #[test]
    fn a_curve_retime_reports_the_curves_average_speed() {
        // The flat "custom" preset runs at 1x throughout, so its average is 1x.
        let curve = build_retime_curve_preset(BuildRetimeCurvePresetOptions {
            preset_id: RetimeCurvePresetId::Custom,
        });
        let config = build_curve_retime(BuildCurveRetimeOptions {
            curve,
            maintain_pitch: None,
        });
        assert!((config.rate - 1.0).abs() < 1e-9, "got {}", config.rate);
        assert_eq!(config.maintain_pitch, Some(false));
        assert!(config.curve.is_some());
    }

    #[test]
    fn a_constant_retime_carries_no_curve() {
        let config = build_constant_retime(BuildConstantRetimeOptions {
            rate: 250.0,
            maintain_pitch: Some(true),
        });
        assert_eq!(config.rate, super::super::rate::MAX_RETIME_RATE);
        assert_eq!(config.maintain_pitch, Some(true));
        assert!(config.curve.is_none());
    }
}
