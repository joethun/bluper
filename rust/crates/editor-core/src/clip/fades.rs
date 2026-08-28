//! Fading a clip against the background.
//!
//! A fade needs no neighbour, which is what separates it from a transition: the
//! clip ramps against whatever is behind it rather than against another clip.

use serde::{Deserialize, Serialize};

use time::MediaTime;

use crate::model::{FadeConfig, TimelineElement};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FadeEdge {
    In,
    Out,
}

/// The longest a fade may run on a clip. A fade in and a fade out have to share
/// the clip between them, or the two ramps would overlap and neither would reach
/// full opacity.
pub fn max_fade_duration(element: &TimelineElement, edge: FadeEdge) -> MediaTime {
    let fade = element.fade();
    let opposite = match edge {
        FadeEdge::In => fade.and_then(|fade| fade.out),
        FadeEdge::Out => fade.and_then(|fade| fade.fade_in),
    };
    match opposite {
        Some(duration) if duration > MediaTime::ZERO => {
            // Half away from zero, matching how the rest of the editor lands a
            // fractional tick count on the lattice.
            MediaTime::from_ticks((element.duration.as_ticks() as f64 / 2.0).round() as i64)
        }
        _ => element.duration,
    }
}

/// The opacity the fades put on a clip at `clip_time`, as a multiplier on
/// whatever the clip already resolved to. 1 outside both ramps.
///
/// The ramps are clamped to half the clip each when both are set, so they meet
/// in the middle at worst instead of fighting over the same frames.
///
/// Times are tick counts rather than `MediaTime`, because the renderer asks this
/// per clip per frame with whatever instant it is drawing.
pub fn resolve_fade_opacity(fade: Option<&FadeConfig>, clip_time: f64, duration: f64) -> f64 {
    let Some(fade) = fade else {
        return 1.0;
    };

    let ticks = |value: Option<MediaTime>| value.map(|time| time.as_ticks() as f64);
    let fade_in_setting = ticks(fade.fade_in).filter(|value| *value != 0.0);
    let fade_out_setting = ticks(fade.out).filter(|value| *value != 0.0);

    let both_set = fade_in_setting.is_some() && fade_out_setting.is_some();
    let limit = if both_set { duration / 2.0 } else { duration };

    let mut opacity: f64 = 1.0;

    let fade_in = fade_in_setting.map_or(0.0, |value| value.min(limit));
    if fade_in > 0.0 && clip_time < fade_in {
        opacity = opacity.min((clip_time / fade_in).max(0.0));
    }

    let fade_out = fade_out_setting.map_or(0.0, |value| value.min(limit));
    if fade_out > 0.0 {
        let remaining = duration - clip_time;
        if remaining < fade_out {
            opacity = opacity.min((remaining / fade_out).max(0.0));
        }
    }

    opacity
}

/// Writes one edge of the fade, dropping the config entirely once neither edge
/// ramps — an empty `fade` object would otherwise linger in saved projects.
pub fn with_fade_edge(
    fade: Option<&FadeConfig>,
    edge: FadeEdge,
    duration: MediaTime,
) -> Option<FadeConfig> {
    let next_in = match edge {
        FadeEdge::In => Some(duration),
        FadeEdge::Out => fade.and_then(|fade| fade.fade_in),
    };
    let next_out = match edge {
        FadeEdge::In => fade.and_then(|fade| fade.out),
        FadeEdge::Out => Some(duration),
    };

    let in_duration = next_in.filter(|value| *value > MediaTime::ZERO);
    let out_duration = next_out.filter(|value| *value > MediaTime::ZERO);
    if in_duration.is_none() && out_duration.is_none() {
        return None;
    }

    Some(FadeConfig {
        fade_in: in_duration,
        out: out_duration,
    })
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MaxFadeDurationOptions {
    pub element: TimelineElement,
    pub edge: FadeEdge,
}

#[bridge::export]
pub fn get_max_fade_duration(
    MaxFadeDurationOptions { element, edge }: MaxFadeDurationOptions,
) -> MediaTime {
    max_fade_duration(&element, edge)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FadeOpacityOptions {
    #[serde(default)]
    pub fade: Option<FadeConfig>,
    pub clip_time: f64,
    pub duration: f64,
}

#[bridge::export]
pub fn resolve_fade_opacity_value(
    FadeOpacityOptions {
        fade,
        clip_time,
        duration,
    }: FadeOpacityOptions,
) -> f64 {
    resolve_fade_opacity(fade.as_ref(), clip_time, duration)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WithFadeEdgeOptions {
    #[serde(default)]
    pub fade: Option<FadeConfig>,
    pub edge: FadeEdge,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeFade {
    pub fade: Option<FadeConfig>,
}

#[bridge::export]
pub fn with_fade_edge_value(
    WithFadeEdgeOptions {
        fade,
        edge,
        duration,
    }: WithFadeEdgeOptions,
) -> MaybeFade {
    MaybeFade {
        fade: with_fade_edge(fade.as_ref(), edge, duration),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fade(in_ticks: Option<i64>, out_ticks: Option<i64>) -> FadeConfig {
        FadeConfig {
            fade_in: in_ticks.map(MediaTime::from_ticks),
            out: out_ticks.map(MediaTime::from_ticks),
        }
    }

    #[test]
    fn no_fade_leaves_the_clip_at_full_opacity() {
        assert_eq!(resolve_fade_opacity(None, 0.0, 1_000.0), 1.0);
    }

    #[test]
    fn a_fade_in_ramps_from_zero_to_one() {
        let config = fade(Some(100), None);
        assert_eq!(resolve_fade_opacity(Some(&config), 0.0, 1_000.0), 0.0);
        assert_eq!(resolve_fade_opacity(Some(&config), 50.0, 1_000.0), 0.5);
        assert_eq!(resolve_fade_opacity(Some(&config), 100.0, 1_000.0), 1.0);
        assert_eq!(resolve_fade_opacity(Some(&config), 900.0, 1_000.0), 1.0);
    }

    #[test]
    fn a_fade_out_ramps_back_down_at_the_end() {
        let config = fade(None, Some(100));
        assert_eq!(resolve_fade_opacity(Some(&config), 0.0, 1_000.0), 1.0);
        assert_eq!(resolve_fade_opacity(Some(&config), 950.0, 1_000.0), 0.5);
        assert_eq!(resolve_fade_opacity(Some(&config), 1_000.0, 1_000.0), 0.0);
    }

    #[test]
    fn two_ramps_meet_in_the_middle_rather_than_overlapping() {
        // Both want the whole clip; each is held to half of it, so they touch at
        // the midpoint and the clip still reaches full opacity there.
        let config = fade(Some(1_000), Some(1_000));
        assert_eq!(resolve_fade_opacity(Some(&config), 500.0, 1_000.0), 1.0);
        assert_eq!(resolve_fade_opacity(Some(&config), 250.0, 1_000.0), 0.5);
        assert_eq!(resolve_fade_opacity(Some(&config), 750.0, 1_000.0), 0.5);
    }

    #[test]
    fn a_time_outside_the_clip_is_clamped_rather_than_negative() {
        let config = fade(Some(100), Some(100));
        assert_eq!(resolve_fade_opacity(Some(&config), -50.0, 1_000.0), 0.0);
        assert_eq!(resolve_fade_opacity(Some(&config), 1_050.0, 1_000.0), 0.0);
    }

    #[test]
    fn writing_one_edge_keeps_the_other() {
        let existing = fade(Some(100), None);
        let next = with_fade_edge(Some(&existing), FadeEdge::Out, MediaTime::from_ticks(200))
            .expect("both edges ramp");
        assert_eq!(next.fade_in, Some(MediaTime::from_ticks(100)));
        assert_eq!(next.out, Some(MediaTime::from_ticks(200)));
    }

    #[test]
    fn zeroing_the_last_ramp_drops_the_config() {
        let existing = fade(Some(100), None);
        assert!(with_fade_edge(Some(&existing), FadeEdge::In, MediaTime::ZERO).is_none());
        assert!(with_fade_edge(None, FadeEdge::In, MediaTime::ZERO).is_none());
    }

    #[test]
    fn a_zeroed_edge_is_dropped_rather_than_stored_as_zero() {
        let existing = fade(Some(100), Some(200));
        let next = with_fade_edge(Some(&existing), FadeEdge::In, MediaTime::ZERO)
            .expect("the out edge still ramps");
        assert_eq!(next.fade_in, None);
        assert_eq!(next.out, Some(MediaTime::from_ticks(200)));
    }
}
