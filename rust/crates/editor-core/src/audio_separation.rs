//! Source-audio extraction: turning a video clip's built-in audio track into a
//! standalone audio element on the timeline.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::animation::{clone_animations, CloneAnimationsOptions};
use crate::model::{ElementAnimations, RetimeConfig};

/// Whether the source clip's own audio is still playing. Stored as an explicit
/// `Some(false)` when extraction has happened and an implicit `true` otherwise,
/// so `None` counts as enabled.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IsSourceAudioEnabledOptions {
    #[serde(default)]
    pub is_source_audio_enabled: Option<bool>,
}

/// `None` and `Some(true)` both count as enabled; only an explicit `Some(false)`
/// (set by the separation toggle) disables it.
#[export]
pub fn is_source_audio_enabled(
    IsSourceAudioEnabledOptions {
        is_source_audio_enabled: value,
    }: IsSourceAudioEnabledOptions,
) -> bool {
    value != Some(false)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IsSourceAudioSeparatedOptions {
    #[serde(default)]
    pub is_source_audio_enabled: Option<bool>,
}

#[export]
pub fn is_source_audio_separated(
    IsSourceAudioSeparatedOptions {
        is_source_audio_enabled: value,
    }: IsSourceAudioSeparatedOptions,
) -> bool {
    !is_source_audio_enabled(IsSourceAudioEnabledOptions {
        is_source_audio_enabled: value,
    })
}

/// Which label the UI shows on the toggle. "Recover audio" when the source has
/// already been extracted (so the action would put it back); "Extract audio"
/// otherwise.
#[export]
pub fn get_source_audio_action_label(
    IsSourceAudioSeparatedOptions {
        is_source_audio_enabled: value,
    }: IsSourceAudioSeparatedOptions,
) -> String {
    if is_source_audio_separated(IsSourceAudioSeparatedOptions {
        is_source_audio_enabled: value,
    }) {
        "Recover audio".to_string()
    } else {
        "Extract audio".to_string()
    }
}

/// The volume/muted pair a clip carries. Stored under `params` on the element
/// itself, so the bridge hands it back as a small object rather than a `Map`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioElementParams {
    pub volume: f64,
    pub muted: bool,
}

/// The fields needed to build a standalone audio element from a video clip's
/// source. The volume/muted are already resolved out of `element.params`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildSeparatedAudioElementOptions {
    pub media_id: String,
    pub name: String,
    pub duration: MediaTime,
    pub start_time: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub source_duration: Option<MediaTime>,
    pub volume: f64,
    pub muted: bool,
    pub retime: Option<RetimeConfig>,
    pub animations: Option<ElementAnimations>,
}

/// The constructed audio element, with `sourceType: "upload"` because the
/// separation reuses the original video's media id rather than a library url.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeparatedAudioElement {
    pub source_type: &'static str,
    pub media_id: String,
    pub name: String,
    pub duration: MediaTime,
    pub start_time: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub source_duration: Option<MediaTime>,
    pub params: AudioElementParams,
    pub retime: Option<RetimeConfig>,
    pub animations: Option<ElementAnimations>,
}

/// Builds a standalone audio element that mirrors the source clip's timeline
/// shape and retime, but only carries the volume envelope from the animations.
/// Everything else (effects, masks, transitions) is dropped because the
/// extracted element has nothing to apply them to.
#[export]
pub fn build_separated_audio_element(
    BuildSeparatedAudioElementOptions {
        media_id,
        name,
        duration,
        start_time,
        trim_start,
        trim_end,
        source_duration,
        volume,
        muted,
        retime,
        animations,
    }: BuildSeparatedAudioElementOptions,
) -> SeparatedAudioElement {
    // The curve comes across with the rate: the detached audio has to walk its
    // source exactly as the picture does, or the two drift apart the moment the
    // speed stops being constant.
    let retime = retime;
    let animations = clone_volume_animations(animations);

    SeparatedAudioElement {
        source_type: "upload",
        media_id,
        name,
        duration,
        start_time,
        trim_start,
        trim_end,
        source_duration,
        params: AudioElementParams { volume, muted },
        retime,
        animations,
    }
}

fn clone_volume_animations(
    animations: Option<ElementAnimations>,
) -> Option<ElementAnimations> {
    let volume_data = animations?.get("volume")?.clone();
    let mut filtered = ElementAnimations::new();
    filtered.insert("volume".to_string(), volume_data);
    // The seed is local to this clone — keyframe ids only have to be unique
    // within the document, and the volume keyframes' previous ids are still
    // live on the source element.
    let cloned = clone_animations(CloneAnimationsOptions {
        animations: Some(filtered),
        should_regenerate_keyframe_ids: true,
        id_seed: "audio-separation".to_string(),
    });
    cloned.animations
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_means_neither_none_nor_false() {
        assert!(is_source_audio_enabled(IsSourceAudioEnabledOptions {
            is_source_audio_enabled: None,
        }));
        assert!(is_source_audio_enabled(IsSourceAudioEnabledOptions {
            is_source_audio_enabled: Some(true),
        }));
        assert!(!is_source_audio_enabled(IsSourceAudioEnabledOptions {
            is_source_audio_enabled: Some(false),
        }));
    }

    #[test]
    fn separated_is_the_inverse() {
        assert!(!is_source_audio_separated(IsSourceAudioSeparatedOptions {
            is_source_audio_enabled: None,
        }));
        assert!(!is_source_audio_separated(IsSourceAudioSeparatedOptions {
            is_source_audio_enabled: Some(true),
        }));
        assert!(is_source_audio_separated(IsSourceAudioSeparatedOptions {
            is_source_audio_enabled: Some(false),
        }));
    }

    #[test]
    fn the_action_label_flips_with_the_separated_state() {
        assert_eq!(
            get_source_audio_action_label(IsSourceAudioSeparatedOptions {
                is_source_audio_enabled: None,
            }),
            "Extract audio"
        );
        assert_eq!(
            get_source_audio_action_label(IsSourceAudioSeparatedOptions {
                is_source_audio_enabled: Some(false),
            }),
            "Recover audio"
        );
    }
}
