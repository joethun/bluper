//! Editing-side queries over an element's animation channels: which components
//! of a property are animatable scalar curves, and which keyframe a dragged
//! diamond belongs to. These run from the panel and the timeline once per
//! interaction, not once per frame, so the whole `ElementAnimations` crossing
//! per call is fine — what mattered was getting the logic somewhere it could be
//! held equal with the TypeScript by a parity test.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::{AnimationChannel, ChannelData, ChannelExtrapolation, ElementAnimations};
use crate::params::ChannelEasingMode;

use super::bezier::ScalarAnimationKey;

#[cfg(test)]
use crate::animation::interpolation::{ChannelOptions, is_scalar_channel};

/// The shape of one scalar channel as the keyframe graph sees it: keys plus the
/// optional extrapolation rules the editor stores alongside them. Mirrors the
/// TypeScript `ScalarAnimationChannel` (the parameterised `Channel<number>`),
/// using `Vec<ScalarAnimationKey>` directly rather than the model-internal
/// `AnimationChannel` enum, so the boundary shape is what callers already see.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScalarGraphChannelData {
    pub keys: Vec<ScalarAnimationKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extrapolation: Option<ChannelExtrapolation>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScalarGraphChannel {
    pub property_path: String,
    pub component_key: String,
    pub channel: ScalarGraphChannelData,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScalarGraphKeyframeContext {
    pub property_path: String,
    pub component_key: String,
    pub channel: ScalarGraphChannelData,
    pub keyframe: ScalarAnimationKey,
    pub keyframe_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_key: Option<ScalarAnimationKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_key: Option<ScalarAnimationKey>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditableScalarChannels {
    pub easing_mode: ChannelEasingMode,
    pub channels: Vec<ScalarGraphChannel>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetEditableScalarChannelsOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetScalarKeyframeContextOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    pub component_key: String,
    pub keyframe_id: String,
}

fn to_scalar_graph_channel_data(channel: &AnimationChannel) -> Option<ScalarGraphChannelData> {
    match channel {
        AnimationChannel::Scalar {
            keys,
            extrapolation,
        } => Some(ScalarGraphChannelData {
            keys: keys.clone(),
            extrapolation: *extrapolation,
        }),
        AnimationChannel::Discrete { .. } => None,
    }
}

/// Component key → scalar channel data. A leaf channel answers under
/// `"value"`; a composite answers under its component keys. Non-scalar channels
/// are dropped, matching the TypeScript `isScalarAnimationChannel` filter.
/// Component keys are sorted so a `HashMap` traversal produces the same answer
/// every run.
fn scalar_components(data: &ChannelData) -> Vec<(String, ScalarGraphChannelData)> {
    match data {
        ChannelData::Channel(channel) => to_scalar_graph_channel_data(channel)
            .map(|channel| vec![("value".to_string(), channel)])
            .unwrap_or_default(),
        ChannelData::Composite(components) => {
            let mut entries: Vec<(String, ScalarGraphChannelData)> = components
                .iter()
                .filter_map(|(key, channel)| {
                    to_scalar_graph_channel_data(channel).map(|data| (key.clone(), data))
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        }
    }
}

/// "shared" when the data is a composite whose four colour components are all
/// present; "independent" otherwise. The check is on the keys' presence only,
/// not on whether each component is scalar — a half-built colour is still a
/// colour.
fn easing_mode_for(data: &ChannelData) -> ChannelEasingMode {
    if let ChannelData::Composite(components) = data {
        if ["r", "g", "b", "a"]
            .iter()
            .all(|key| components.contains_key(*key))
        {
            return ChannelEasingMode::Shared;
        }
    }
    ChannelEasingMode::Independent
}

/// The query the editor's panel makes when it draws the keyframe graph: which
/// components of `property_path` are scalar curves, and what easing mode the
/// graph should use.
pub fn get_editable_scalar_channels_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
) -> Option<EditableScalarChannels> {
    let data = animations?.get(property_path)?;
    let channels = scalar_components(data)
        .into_iter()
        .map(|(component_key, channel)| ScalarGraphChannel {
            property_path: property_path.to_string(),
            component_key,
            channel,
        })
        .collect();
    Some(EditableScalarChannels {
        easing_mode: easing_mode_for(data),
        channels,
    })
}

/// One component's full context for the diamond the user is dragging: the
/// channel itself, the targeted key, and the keys immediately around it.
pub fn get_scalar_keyframe_context_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
    component_key: &str,
    keyframe_id: &str,
) -> Option<ScalarGraphKeyframeContext> {
    let data = animations?.get(property_path)?;
    let (_, channel) = scalar_components(data)
        .into_iter()
        .find(|(key, _)| key == component_key)?;
    let keys = &channel.keys;
    let keyframe_index = keys.iter().position(|key| key.id == keyframe_id)?;
    let keyframe = keys[keyframe_index].clone();
    let previous_key = if keyframe_index == 0 {
        None
    } else {
        keys.get(keyframe_index - 1).cloned()
    };
    let next_key = keys.get(keyframe_index + 1).cloned();
    Some(ScalarGraphKeyframeContext {
        property_path: property_path.to_string(),
        component_key: component_key.to_string(),
        channel,
        keyframe,
        keyframe_index: keyframe_index as u32,
        previous_key,
        next_key,
    })
}

#[export]
pub fn get_editable_scalar_channels_value(
    GetEditableScalarChannelsOptions {
        animations,
        property_path,
    }: GetEditableScalarChannelsOptions,
) -> Option<EditableScalarChannels> {
    get_editable_scalar_channels_inner(animations.as_ref(), &property_path)
}

#[export]
pub fn get_scalar_keyframe_context_value(
    GetScalarKeyframeContextOptions {
        animations,
        property_path,
        component_key,
        keyframe_id,
    }: GetScalarKeyframeContextOptions,
) -> Option<ScalarGraphKeyframeContext> {
    get_scalar_keyframe_context_inner(
        animations.as_ref(),
        &property_path,
        &component_key,
        &keyframe_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{ScalarAnimationKey, ScalarSegmentType, TangentMode};
    use std::collections::HashMap;
    use time::MediaTime;

    fn scalar_channel(keys: Vec<ScalarAnimationKey>) -> ChannelData {
        ChannelData::Channel(AnimationChannel::Scalar {
            keys,
            extrapolation: None,
        })
    }

    fn discrete_channel() -> ChannelData {
        ChannelData::Channel(AnimationChannel::Discrete {
            keys: vec![crate::model::DiscreteAnimationKey {
                id: "d".to_string(),
                time: MediaTime::from_ticks(0),
                value: crate::model::DiscreteValue::Bool(false),
            }],
        })
    }

    fn test_key(id: &str, time: i64, value: f64) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: id.to_string(),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: ScalarSegmentType::Linear,
            tangent_mode: TangentMode::Flat,
        }
    }

    fn composite_with_scalars(
        components: &[(&str, Vec<ScalarAnimationKey>)],
    ) -> ChannelData {
        let map: HashMap<String, AnimationChannel> = components
            .iter()
            .map(|(key, keys)| {
                (
                    (*key).to_string(),
                    AnimationChannel::Scalar {
                        keys: keys.clone(),
                        extrapolation: None,
                    },
                )
            })
            .collect();
        ChannelData::Composite(map)
    }

    #[test]
    fn missing_animations_argument_returns_none() {
        assert!(
            get_editable_scalar_channels_inner(None, "opacity").is_none(),
            "no animations means no channels"
        );
    }

    #[test]
    fn absent_path_returns_none() {
        let animations: ElementAnimations = HashMap::new();
        assert!(get_editable_scalar_channels_inner(Some(&animations), "opacity").is_none());
    }

    #[test]
    fn leaf_scalar_channel_is_returned_under_value() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![test_key("k0", 0, 1.0)]),
        );
        let result = get_editable_scalar_channels_inner(Some(&animations), "opacity")
            .expect("the path exists");
        assert_eq!(result.easing_mode, ChannelEasingMode::Independent);
        assert_eq!(result.channels.len(), 1);
        assert_eq!(result.channels[0].component_key, "value");
        assert_eq!(result.channels[0].property_path, "opacity");
        assert_eq!(result.channels[0].channel.keys.len(), 1);
        assert_eq!(result.channels[0].channel.keys[0].id, "k0");
        // Sanity: the channel it returned is actually a scalar one, not the
        // model-internal enum discriminant.
        let channel = crate::model::AnimationChannel::Scalar {
            keys: result.channels[0].channel.keys.clone(),
            extrapolation: result.channels[0].channel.extrapolation,
        };
        assert!(is_scalar_channel(ChannelOptions { channel }));
    }

    #[test]
    fn composite_with_one_keyframed_component_lists_only_that_component() {
        // Only `r` carries keys — `g` is discrete. The keyframe graph surfaces
        // `r` as the one animatable scalar component; the discrete one is
        // dropped by `isScalarAnimationChannel` in the TypeScript, mirrored
        // here by `to_scalar_graph_channel_data`.
        let mut components: HashMap<String, AnimationChannel> = HashMap::new();
        components.insert(
            "r".to_string(),
            AnimationChannel::Scalar {
                keys: vec![test_key("kr", 0, 0.5)],
                extrapolation: None,
            },
        );
        components.insert(
            "g".to_string(),
            AnimationChannel::Discrete {
                keys: vec![crate::model::DiscreteAnimationKey {
                    id: "kg".to_string(),
                    time: MediaTime::from_ticks(0),
                    value: crate::model::DiscreteValue::Bool(true),
                }],
            },
        );
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), ChannelData::Composite(components));
        let result = get_editable_scalar_channels_inner(Some(&animations), "color")
            .expect("composite is animated");
        assert_eq!(result.channels.len(), 1);
        assert_eq!(result.channels[0].component_key, "r");
    }

    #[test]
    fn composite_components_are_emitted_in_sorted_order() {
        // A HashMap has no insertion order. Two runs over the same data must
        // produce the same answer.
        let animations: ElementAnimations = HashMap::from([(
            "color".to_string(),
            composite_with_scalars(&[
                ("b", vec![test_key("kb", 0, 0.25)]),
                ("r", vec![test_key("kr", 0, 0.5)]),
                ("g", vec![test_key("kg", 0, 0.75)]),
                ("a", vec![test_key("ka", 0, 1.0)]),
            ]),
        )]);
        let result = get_editable_scalar_channels_inner(Some(&animations), "color")
            .expect("composite is animated");
        let keys: Vec<&str> = result
            .channels
            .iter()
            .map(|channel| channel.component_key.as_str())
            .collect();
        assert_eq!(keys, vec!["a", "b", "g", "r"]);
    }

    #[test]
    fn discrete_channel_is_excluded_from_the_graph() {
        // A leaf that's discrete contributes nothing to the graph.
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("hidden".to_string(), discrete_channel());
        let result = get_editable_scalar_channels_inner(Some(&animations), "hidden")
            .expect("the path exists");
        assert!(result.channels.is_empty());
        assert_eq!(result.easing_mode, ChannelEasingMode::Independent);
    }

    #[test]
    fn discrete_components_are_excluded_from_a_composite() {
        let mut components: HashMap<String, AnimationChannel> = HashMap::new();
        components.insert(
            "r".to_string(),
            AnimationChannel::Scalar {
                keys: vec![test_key("kr", 0, 0.5)],
                extrapolation: None,
            },
        );
        components.insert(
            "g".to_string(),
            AnimationChannel::Discrete {
                keys: vec![crate::model::DiscreteAnimationKey {
                    id: "kg".to_string(),
                    time: MediaTime::from_ticks(0),
                    value: crate::model::DiscreteValue::Bool(true),
                }],
            },
        );
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), ChannelData::Composite(components));
        let result = get_editable_scalar_channels_inner(Some(&animations), "color")
            .expect("composite is animated");
        assert_eq!(result.channels.len(), 1);
        assert_eq!(result.channels[0].component_key, "r");
    }

    #[test]
    fn easing_mode_is_shared_only_for_a_full_rgba_composite() {
        // A full colour: every one of r, g, b, a is present.
        let full = composite_with_scalars(&[
            ("r", vec![test_key("kr", 0, 0.5)]),
            ("g", vec![test_key("kg", 0, 0.5)]),
            ("b", vec![test_key("kb", 0, 0.5)]),
            ("a", vec![test_key("ka", 0, 0.5)]),
        ]);
        // One component missing — still composite, but not a full colour.
        let partial = composite_with_scalars(&[
            ("r", vec![test_key("kr", 0, 0.5)]),
            ("g", vec![test_key("kg", 0, 0.5)]),
            ("b", vec![test_key("kb", 0, 0.5)]),
        ]);
        // A leaf channel is never shared.
        let leaf = scalar_channel(vec![test_key("k0", 0, 1.0)]);

        assert_eq!(easing_mode_for(&full), ChannelEasingMode::Shared);
        assert_eq!(easing_mode_for(&partial), ChannelEasingMode::Independent);
        assert_eq!(easing_mode_for(&leaf), ChannelEasingMode::Independent);
    }

    #[test]
    fn keyframe_context_returns_none_for_missing_animations() {
        assert!(get_scalar_keyframe_context_inner(None, "opacity", "value", "k0").is_none());
    }

    #[test]
    fn keyframe_context_returns_none_when_path_is_missing() {
        let animations: ElementAnimations = HashMap::new();
        assert!(
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k0")
                .is_none()
        );
    }

    #[test]
    fn keyframe_context_returns_none_when_component_is_missing() {
        // The path exists but the requested component key is not a scalar.
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("opacity".to_string(), scalar_channel(vec![test_key("k0", 0, 1.0)]));
        assert!(
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "r", "k0")
                .is_none(),
            "a leaf channel has only the \"value\" component"
        );
    }

    #[test]
    fn keyframe_context_finds_a_key_in_the_middle() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![
                test_key("k0", 0, 0.0),
                test_key("k1", 500, 0.5),
                test_key("k2", 1000, 1.0),
            ]),
        );
        let context = get_scalar_keyframe_context_inner(
            Some(&animations),
            "opacity",
            "value",
            "k1",
        )
        .expect("the keyframe exists");
        assert_eq!(context.keyframe.id, "k1");
        assert_eq!(context.keyframe_index, 1);
        assert_eq!(context.previous_key.as_ref().map(|key| key.id.as_str()), Some("k0"));
        assert_eq!(context.next_key.as_ref().map(|key| key.id.as_str()), Some("k2"));
    }

    #[test]
    fn keyframe_context_handles_the_first_key_with_no_predecessor() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![
                test_key("k0", 0, 0.0),
                test_key("k1", 1000, 1.0),
            ]),
        );
        let context = get_scalar_keyframe_context_inner(
            Some(&animations),
            "opacity",
            "value",
            "k0",
        )
        .expect("the keyframe exists");
        assert_eq!(context.keyframe_index, 0);
        assert!(context.previous_key.is_none(), "no key sits before the first");
        assert_eq!(
            context.next_key.as_ref().map(|key| key.id.as_str()),
            Some("k1")
        );
    }

    #[test]
    fn keyframe_context_handles_the_last_key_with_no_successor() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![
                test_key("k0", 0, 0.0),
                test_key("k1", 1000, 1.0),
            ]),
        );
        let context = get_scalar_keyframe_context_inner(
            Some(&animations),
            "opacity",
            "value",
            "k1",
        )
        .expect("the keyframe exists");
        assert_eq!(context.keyframe_index, 1);
        assert_eq!(
            context.previous_key.as_ref().map(|key| key.id.as_str()),
            Some("k0")
        );
        assert!(context.next_key.is_none(), "no key sits after the last");
    }

    #[test]
    fn keyframe_context_returns_none_when_id_does_not_match() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![test_key("k0", 0, 1.0)]),
        );
        assert!(
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "nope")
                .is_none()
        );
    }

    #[test]
    fn keyframe_context_returns_none_when_id_matches_but_channel_is_wrong_shape() {
        // The id collides with a key on a discrete channel, but the requested
        // component is scalar — the discrete channel is not selectable.
        let mut components: HashMap<String, AnimationChannel> = HashMap::new();
        components.insert(
            "r".to_string(),
            AnimationChannel::Discrete {
                keys: vec![crate::model::DiscreteAnimationKey {
                    id: "k0".to_string(),
                    time: MediaTime::from_ticks(0),
                    value: crate::model::DiscreteValue::Bool(true),
                }],
            },
        );
        components.insert(
            "g".to_string(),
            AnimationChannel::Scalar {
                keys: vec![test_key("k0", 0, 0.5)],
                extrapolation: None,
            },
        );
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), ChannelData::Composite(components));

        // The id matches a key on the *discrete* channel. Asking for `r` returns
        // nothing, because `r` is discrete.
        assert!(
            get_scalar_keyframe_context_inner(Some(&animations), "color", "r", "k0").is_none()
        );
        // Asking for `g` (the scalar component) finds that key, even though the
        // id was the same — same id, different component.
        let context = get_scalar_keyframe_context_inner(
            Some(&animations),
            "color",
            "g",
            "k0",
        )
        .expect("the scalar component has a matching key");
        assert_eq!(context.component_key, "g");
        assert_eq!(context.keyframe.id, "k0");
    }

    #[test]
    fn keyframe_context_uses_the_composite_easing_mode() {
        // The context surfaces the easing mode carried by the parent result —
        // a context for a colour component must know it's on a shared curve.
        let animations: ElementAnimations = HashMap::from([(
            "color".to_string(),
            composite_with_scalars(&[
                ("r", vec![test_key("kr", 0, 0.5)]),
                ("g", vec![test_key("kg", 0, 0.5)]),
                ("b", vec![test_key("kb", 0, 0.5)]),
                ("a", vec![test_key("ka", 0, 0.5)]),
            ]),
        )]);
        let from_query =
            get_editable_scalar_channels_inner(Some(&animations), "color").expect("composite");
        assert_eq!(from_query.easing_mode, ChannelEasingMode::Shared);

        let context = get_scalar_keyframe_context_inner(
            Some(&animations),
            "color",
            "r",
            "kr",
        )
        .expect("the keyframe exists");
        assert_eq!(context.component_key, "r");
        assert_eq!(context.keyframe_index, 0);
    }
}
