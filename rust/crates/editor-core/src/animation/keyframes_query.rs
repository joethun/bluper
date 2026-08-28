//! Querying an element's animation channels. The editor asks these questions
//! every time it draws a keyframe diamond, picks up a drag, or shows a
//! properties panel — they are the read path to a domain the editing side of
//! `keyframes.rs` already owns. Until the channel map itself moves into Rust
//! these still cross the boundary per call, which is what makes the per-frame
//! callers stay on TypeScript for now; the queries themselves are pure and
//! belong here.

use std::collections::HashMap;

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::animation::{
    AnimationInterpolation, ScalarSegmentType, get_scalar_segment_interpolation,
};
use crate::animation::interpolation::{ChannelValueAtTimeOptions, get_channel_value_at_time};
use crate::model::{
    AnimationChannel, ChannelData, DiscreteValue, ElementAnimations, ParamValue,
};
use crate::params::{LinearRgba, format_linear_rgba, parse_color_to_linear_rgba};

use super::path::{is_animation_path, is_animation_storage_key};

/// Whether a property path has any keyframes at all — a `HashMap` lookup with
/// the channels empty-filtered out, no allocation. Cheap enough to call from
/// every transform-handle drag tick.
pub fn has_keyframes_for_path_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
) -> bool {
    let Some(data) = animations.and_then(|a| a.get(property_path)) else {
        return false;
    };
    any_key_present(data)
}

fn any_key_present(data: &ChannelData) -> bool {
    match data {
        ChannelData::Channel(channel) => channel_has_keys(channel),
        ChannelData::Composite(components) => components.values().any(channel_has_keys),
    }
}

fn channel_has_keys(channel: &AnimationChannel) -> bool {
    match channel {
        AnimationChannel::Scalar { keys, .. } => !keys.is_empty(),
        AnimationChannel::Discrete { keys } => !keys.is_empty(),
    }
}

/// Map a timeline time onto a clip's local span: clamp to `[0, duration]` so
/// the renderer can ask for "what is on this clip right now" without having to
/// think about edges itself. Half-open at the end, same as the renderer.
pub fn get_element_local_time_inner(options: GetElementLocalTimeOptions) -> f64 {
    let GetElementLocalTimeOptions {
        timeline_time,
        element_start_time,
        element_duration,
    } = options;
    let local = timeline_time - element_start_time;
    if local <= 0.0 {
        return 0.0;
    }
    if local >= element_duration {
        return element_duration;
    }
    local
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HasKeyframesOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
    pub property_path: String,
}

#[export]
pub fn has_keyframes_for_path_value(
    HasKeyframesOptions {
        animations,
        property_path,
    }: HasKeyframesOptions,
) -> bool {
    let as_element = animations.map(ElementAnimations::from);
    has_keyframes_for_path_inner(as_element.as_ref(), &property_path)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetElementLocalTimeOptions {
    pub timeline_time: f64,
    pub element_start_time: f64,
    pub element_duration: f64,
}

#[export]
pub fn get_element_local_time_value(options: GetElementLocalTimeOptions) -> f64 {
    get_element_local_time_inner(options)
}

// --- Element keyframes --------------------------------------------------------

/// One keyframe on one property path of one element, in the shape the editor's
/// timeline UI consumes. The matching TypeScript type is `ElementKeyframe` in
/// `apps/web/src/animation/types.ts`.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElementKeyframe {
    pub property_path: String,
    pub id: String,
    pub time: MediaTime,
    pub value: ParamValue,
    pub interpolation: AnimationInterpolation,
}

/// One keyframe across all components of a property, tagged with the component
/// index it came from so the "preferred component" rule can pick the right one
/// when several components share a time.
struct KeyframeMatch {
    component_index: usize,
    time: i64,
    id: String,
    segment: Option<ScalarSegmentType>,
}

/// Component key → channel, sorted alphabetically for a composite. The same
/// shape as `keyframes::channel_entries`; duplicated here because the helper in
/// the editing module is private and this module is the only consumer for the
/// query path.
fn query_channel_entries(data: &ChannelData) -> Vec<(String, AnimationChannel)> {
    match data {
        ChannelData::Channel(channel) => vec![("value".to_string(), channel.clone())],
        ChannelData::Composite(components) => {
            let mut entries: Vec<(String, AnimationChannel)> = components
                .iter()
                .map(|(key, channel)| (key.clone(), channel.clone()))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        }
    }
}

fn collect_keyframe_matches(
    data: &ChannelData,
    predicate: impl Fn(i64, &str) -> bool,
) -> Vec<KeyframeMatch> {
    let mut result = Vec::new();
    for (component_index, (_component_key, channel)) in
        query_channel_entries(data).into_iter().enumerate()
    {
        match channel {
            AnimationChannel::Scalar { keys, .. } => {
                for key in keys {
                    if predicate(key.time.as_ticks(), &key.id) {
                        result.push(KeyframeMatch {
                            component_index,
                            time: key.time.as_ticks(),
                            id: key.id.clone(),
                            segment: Some(key.segment_to_next),
                        });
                    }
                }
            }
            AnimationChannel::Discrete { keys } => {
                for key in keys {
                    if predicate(key.time.as_ticks(), &key.id) {
                        result.push(KeyframeMatch {
                            component_index,
                            time: key.time.as_ticks(),
                            id: key.id.clone(),
                            segment: None,
                        });
                    }
                }
            }
        }
    }
    result
}

fn keyframe_interpolation_for(segment: Option<ScalarSegmentType>) -> AnimationInterpolation {
    match segment {
        Some(segment) => get_scalar_segment_interpolation(
            super::interpolation::ScalarSegmentInterpolationOptions { segment },
        ),
        None => AnimationInterpolation::Hold,
    }
}

/// The value a keyframe carries. A scalar channel returns the stored key value
/// as a number; a discrete channel returns the stored discrete value; a
/// composite channel resolves the r/g/b/a tuple at the key's time and formats
/// it as a hex string.
fn resolve_keyframe_value(data: &ChannelData, time: i64) -> Option<ParamValue> {
    match data {
        ChannelData::Channel(channel) => channel_key_value_at_time(channel, time),
        ChannelData::Composite(components) => composite_value_at_time(components, time),
    }
}

fn channel_key_value_at_time(channel: &AnimationChannel, time: i64) -> Option<ParamValue> {
    match channel {
        AnimationChannel::Scalar { keys, .. } => keys
            .iter()
            .find(|key| key.time.as_ticks() == time)
            .map(|key| ParamValue::Number(key.value)),
        AnimationChannel::Discrete { keys } => keys
            .iter()
            .find(|key| key.time.as_ticks() == time)
            .map(|key| match &key.value {
                DiscreteValue::Bool(value) => ParamValue::Bool(*value),
                DiscreteValue::Text(value) => ParamValue::Text(value.clone()),
            }),
    }
}

fn composite_value_at_time(
    components: &HashMap<String, AnimationChannel>,
    time: i64,
) -> Option<ParamValue> {
    let mut r = None;
    let mut g = None;
    let mut b = None;
    let mut a = None;
    for (component_key, channel) in components {
        let ParamValue::Number(value) = channel_key_value_at_time(channel, time)? else {
            return None;
        };
        match component_key.as_str() {
            "r" => r = Some(value),
            "g" => g = Some(value),
            "b" => b = Some(value),
            "a" => a = Some(value),
            _ => return None,
        }
    }
    Some(ParamValue::Text(format_linear_rgba(&LinearRgba {
        r: r?,
        g: g?,
        b: b?,
        a: a?,
    })))
}

/// Every keyframe on the element, in a stable order: by property path, then by
/// time. When several components of one property share a time, the one the
/// iteration meets first wins, which is the alphabetically-first component in
/// Rust (matching the sorted iteration the rest of the editor uses for a
/// composite). Legacy `bindings` and `channels` keys are filtered out, and any
/// path `is_animation_path` doesn't recognise is skipped entirely.
pub fn get_element_keyframes_inner(
    animations: Option<&ElementAnimations>,
) -> Vec<ElementKeyframe> {
    let Some(animations) = animations else {
        return Vec::new();
    };

    let mut paths: Vec<&String> = animations.keys().collect();
    paths.sort();

    let mut result = Vec::new();
    for path in paths {
        if !is_animation_storage_key(path) || !is_animation_path(path) {
            continue;
        }
        let Some(data) = animations.get(path) else {
            continue;
        };

        let mut matches = collect_keyframe_matches(data, |_, _| true);
        matches.sort_by(|left, right| {
            left.time
                .cmp(&right.time)
                .then(left.component_index.cmp(&right.component_index))
        });

        let mut last_time: Option<i64> = None;
        for keyframe_match in matches {
            if last_time == Some(keyframe_match.time) {
                continue;
            }
            last_time = Some(keyframe_match.time);

            let Some(value) = resolve_keyframe_value(data, keyframe_match.time) else {
                continue;
            };

            result.push(ElementKeyframe {
                property_path: path.clone(),
                id: keyframe_match.id,
                time: MediaTime::from_ticks(keyframe_match.time),
                value,
                interpolation: keyframe_interpolation_for(keyframe_match.segment),
            });
        }
    }

    result
}

/// One keyframe at a precise time on one property path. The leaf component (the
/// one whose component key is `"value"`, which the rest of the system uses for
/// a value with no components) is preferred, then any component that happens to
/// have a key at the requested time.
pub fn get_keyframe_at_time_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
    time: i64,
) -> Option<ElementKeyframe> {
    let data = animations?.get(property_path)?;
    let matches = collect_keyframe_matches(data, |key_time, _| key_time == time);
    let preferred = preferred_match(&matches)?;

    let value = resolve_keyframe_value(data, preferred.time)?;
    Some(ElementKeyframe {
        property_path: property_path.to_string(),
        id: preferred.id.clone(),
        time: MediaTime::from_ticks(preferred.time),
        value,
        interpolation: keyframe_interpolation_for(preferred.segment),
    })
}

/// One keyframe by its id on one property path. Same preference rule as
/// [`get_keyframe_at_time_inner`]: component 0 first, then the rest.
pub fn get_keyframe_by_id_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
    keyframe_id: &str,
) -> Option<ElementKeyframe> {
    let data = animations?.get(property_path)?;
    let matches = collect_keyframe_matches(data, |_, id| id == keyframe_id);
    let preferred = preferred_match(&matches)?;

    let value = resolve_keyframe_value(data, preferred.time)?;
    Some(ElementKeyframe {
        property_path: property_path.to_string(),
        id: preferred.id.clone(),
        time: MediaTime::from_ticks(preferred.time),
        value,
        interpolation: keyframe_interpolation_for(preferred.segment),
    })
}

/// The match the TypeScript called "preferred": the one with `componentIndex
/// === 0` (the leaf channel under `"value"`, or the alphabetically-first
/// component of a composite), falling back to the first match in iteration
/// order when none is.
fn preferred_match(matches: &[KeyframeMatch]) -> Option<&KeyframeMatch> {
    matches
        .iter()
        .find(|candidate| candidate.component_index == 0)
        .or(matches.first())
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetElementKeyframesOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetKeyframeAtTimeOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
    pub property_path: String,
    pub time: i64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GetKeyframeByIdOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
    pub property_path: String,
    pub keyframe_id: String,
}

#[export]
pub fn get_element_keyframes_value(
    GetElementKeyframesOptions { animations }: GetElementKeyframesOptions,
) -> Vec<ElementKeyframe> {
    let as_element = animations.map(ElementAnimations::from);
    get_element_keyframes_inner(as_element.as_ref())
}

#[export]
pub fn get_keyframe_at_time_value(
    GetKeyframeAtTimeOptions {
        animations,
        property_path,
        time,
    }: GetKeyframeAtTimeOptions,
) -> Option<ElementKeyframe> {
    let as_element = animations.map(ElementAnimations::from);
    get_keyframe_at_time_inner(as_element.as_ref(), &property_path, time)
}

#[export]
pub fn get_keyframe_by_id_value(
    GetKeyframeByIdOptions {
        animations,
        property_path,
        keyframe_id,
    }: GetKeyframeByIdOptions,
) -> Option<ElementKeyframe> {
    let as_element = animations.map(ElementAnimations::from);
    get_keyframe_by_id_inner(as_element.as_ref(), &property_path, &keyframe_id)
}

// --- Resolving an animated value ---------------------------------------------

/// The three shapes the orchestrator can hand back. Tagged untagged so the
/// serde path falls through in the same order the JavaScript overloads try:
/// a number first (most common), then a colour string, then a boolean.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ResolvedAnimationValue {
    Number(f64),
    Text(String),
    Bool(bool),
}

/// What `resolveAnimationPathValueAtTime` answers across its four overloads.
/// The orchestrator picks the right arm of `get_channel_value_at_time` from the
/// fallback's variant, the same way the TypeScript did: scalar channel + number
/// fallback reads as a number; discrete channel + string/boolean fallback reads
/// as the discrete value; a composite channel is read as the colour its
/// r/g/b/a components form at the time, with the fallback string supplying the
/// components that have no keys.
pub fn resolve_animation_path_value_at_time_inner(
    animations: Option<&ElementAnimations>,
    property_path: &str,
    local_time: i64,
    fallback: &ParamValue,
) -> ResolvedAnimationValue {
    let clamped_time = local_time.max(0);

    let Some(data) = animations.and_then(|a| a.get(property_path)) else {
        return wrap_fallback(fallback);
    };

    match data {
        ChannelData::Channel(channel) => resolve_leaf(channel, clamped_time, fallback),
        ChannelData::Composite(components) => resolve_composite(components, clamped_time, fallback),
    }
}

fn wrap_fallback(fallback: &ParamValue) -> ResolvedAnimationValue {
    match fallback {
        ParamValue::Number(value) => ResolvedAnimationValue::Number(*value),
        ParamValue::Text(value) => ResolvedAnimationValue::Text(value.clone()),
        ParamValue::Bool(value) => ResolvedAnimationValue::Bool(*value),
    }
}

fn resolve_leaf(
    channel: &AnimationChannel,
    clamped_time: i64,
    fallback: &ParamValue,
) -> ResolvedAnimationValue {
    let is_scalar = matches!(channel, AnimationChannel::Scalar { .. });
    let time = clamped_time as f64;

    match fallback {
        ParamValue::Number(value) => {
            let passed_channel = if is_scalar { Some(channel.clone()) } else { None };
            let result = get_channel_value_at_time(ChannelValueAtTimeOptions {
                channel: passed_channel,
                time,
                fallback_value: ParamValue::Number(*value),
            });
            match result {
                ParamValue::Number(v) => ResolvedAnimationValue::Number(v),
                // The number arm of `get_channel_value_at_time` always answers
                // with a number when it has a channel to read, and the fallback
                // otherwise; this guard keeps the type explicit for the
                // unwrap-er.
                other => wrap_fallback(&other),
            }
        }
        ParamValue::Text(value) => {
            let passed_channel = if !is_scalar { Some(channel.clone()) } else { None };
            let result = get_channel_value_at_time(ChannelValueAtTimeOptions {
                channel: passed_channel,
                time,
                fallback_value: ParamValue::Text(value.clone()),
            });
            match result {
                ParamValue::Text(t) => ResolvedAnimationValue::Text(t),
                // A discrete channel answered with a boolean value (the
                // discrete kind crosses the scalar/discrete divide the same
                // way), so hand it back in the right slot.
                ParamValue::Bool(b) => ResolvedAnimationValue::Bool(b),
                ParamValue::Number(_) => ResolvedAnimationValue::Text(value.clone()),
            }
        }
        ParamValue::Bool(value) => {
            let passed_channel = if !is_scalar { Some(channel.clone()) } else { None };
            let result = get_channel_value_at_time(ChannelValueAtTimeOptions {
                channel: passed_channel,
                time,
                fallback_value: ParamValue::Bool(*value),
            });
            match result {
                ParamValue::Bool(b) => ResolvedAnimationValue::Bool(b),
                ParamValue::Text(t) => ResolvedAnimationValue::Text(t),
                ParamValue::Number(_) => ResolvedAnimationValue::Bool(*value),
            }
        }
    }
}

fn resolve_composite(
    components: &HashMap<String, AnimationChannel>,
    clamped_time: i64,
    fallback: &ParamValue,
) -> ResolvedAnimationValue {
    let ParamValue::Text(fallback_str) = fallback else {
        return wrap_fallback(fallback);
    };

    let required = ["r", "g", "b", "a"];
    if !required.iter().all(|key| components.contains_key(*key)) {
        return ResolvedAnimationValue::Text(fallback_str.clone());
    }

    let Some(fallback_components) = parse_color_to_linear_rgba(fallback_str) else {
        return ResolvedAnimationValue::Text(fallback_str.clone());
    };

    let r = sample_component(components.get("r"), clamped_time, fallback_components.r);
    let g = sample_component(components.get("g"), clamped_time, fallback_components.g);
    let b = sample_component(components.get("b"), clamped_time, fallback_components.b);
    let a = sample_component(components.get("a"), clamped_time, fallback_components.a);

    ResolvedAnimationValue::Text(format_linear_rgba(&LinearRgba { r, g, b, a }))
}

fn sample_component(
    channel: Option<&AnimationChannel>,
    clamped_time: i64,
    fallback_value: f64,
) -> f64 {
    let scalar_channel = channel
        .filter(|channel| matches!(channel, AnimationChannel::Scalar { .. }))
        .cloned();
    match get_channel_value_at_time(ChannelValueAtTimeOptions {
        channel: scalar_channel,
        time: clamped_time as f64,
        fallback_value: ParamValue::Number(fallback_value),
    }) {
        ParamValue::Number(value) => value,
        // The number arm of `get_channel_value_at_time` always answers with a
        // number, so this branch is unreachable in practice; the fallback
        // keeps a defined answer if it ever changes.
        _ => fallback_value,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAnimationPathValueAtTimeOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
    pub property_path: String,
    pub local_time: i64,
    pub fallback: ParamValue,
}

#[export]
pub fn resolve_animation_path_value_at_time_value(
    ResolveAnimationPathValueAtTimeOptions {
        animations,
        property_path,
        local_time,
        fallback,
    }: ResolveAnimationPathValueAtTimeOptions,
) -> ResolvedAnimationValue {
    let as_element = animations.map(ElementAnimations::from);
    resolve_animation_path_value_at_time_inner(
        as_element.as_ref(),
        &property_path,
        local_time,
        &fallback,
    )
}

// --- Resolving an animated transform ----------------------------------------

/// The element's animated transform resolved at one time. Mirrors the
/// `Transform` interface in `apps/web/src/rendering/index.ts`: each field is
/// the value the per-property animation resolved for, or the corresponding
/// base value when there is no keyframe.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub scale_x: f64,
    pub scale_y: f64,
    pub position: TransformPosition,
    pub rotate: f64,
}

/// The 2D position part of a [`Transform`]. Kept as its own type so the
/// boundary shape matches the `Transform.position` field on the TypeScript
/// side and tsify renders it as a nested object.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransformPosition {
    pub x: f64,
    pub y: f64,
}

/// Pull a number out of a [`ResolvedAnimationValue`], falling back to the base
/// when the orchestrator answered with anything else. The transform paths are
/// always number-typed, so this branch is defensive: it keeps the renderer on
/// a numeric answer when a future change makes the orchestrator return a
/// non-number for a path that should be one.
fn number_or_fallback(value: &ResolvedAnimationValue, fallback: f64) -> f64 {
    match value {
        ResolvedAnimationValue::Number(v) => *v,
        ResolvedAnimationValue::Text(_) | ResolvedAnimationValue::Bool(_) => fallback,
    }
}

/// Resolve an element's transform at one local time: read the five
/// `transform.*` animation paths against a base transform, and stitch the
/// answers back into a [`Transform`]. This is the per-frame path the renderer
/// was previously issuing as six separate wasm calls; doing the five reads
/// here keeps it to a single boundary crossing.
pub fn resolve_transform_at_time_inner(
    animations: Option<&ElementAnimations>,
    base: &Transform,
    local_time: i64,
) -> Transform {
    let safe_local_time = local_time.max(0);

    let position_x = resolve_animation_path_value_at_time_inner(
        animations,
        "transform.positionX",
        safe_local_time,
        &ParamValue::Number(base.position.x),
    );
    let position_y = resolve_animation_path_value_at_time_inner(
        animations,
        "transform.positionY",
        safe_local_time,
        &ParamValue::Number(base.position.y),
    );
    let scale_x = resolve_animation_path_value_at_time_inner(
        animations,
        "transform.scaleX",
        safe_local_time,
        &ParamValue::Number(base.scale_x),
    );
    let scale_y = resolve_animation_path_value_at_time_inner(
        animations,
        "transform.scaleY",
        safe_local_time,
        &ParamValue::Number(base.scale_y),
    );
    let rotate = resolve_animation_path_value_at_time_inner(
        animations,
        "transform.rotate",
        safe_local_time,
        &ParamValue::Number(base.rotate),
    );

    Transform {
        scale_x: number_or_fallback(&scale_x, base.scale_x),
        scale_y: number_or_fallback(&scale_y, base.scale_y),
        position: TransformPosition {
            x: number_or_fallback(&position_x, base.position.x),
            y: number_or_fallback(&position_y, base.position.y),
        },
        rotate: number_or_fallback(&rotate, base.rotate),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveTransformAtTimeOptions {
    #[serde(default)]
    pub animations: Option<HashMap<String, ChannelData>>,
    pub base_transform: Transform,
    pub local_time: i64,
}

#[export]
pub fn resolve_transform_at_time_value(
    ResolveTransformAtTimeOptions {
        animations,
        base_transform,
        local_time,
    }: ResolveTransformAtTimeOptions,
) -> Transform {
    let as_element = animations.map(ElementAnimations::from);
    resolve_transform_at_time_inner(as_element.as_ref(), &base_transform, local_time)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{ScalarAnimationKey, ScalarSegmentType, TangentMode};
    use crate::model::{ChannelData, DiscreteAnimationKey, ElementAnimations};
    use time::MediaTime;

    fn scalar_channel(keys: Vec<ScalarAnimationKey>) -> ChannelData {
        ChannelData::Channel(AnimationChannel::Scalar {
            keys,
            extrapolation: None,
        })
    }

    fn test_key(time: f64, value: f64) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: "k".to_string(),
            time: MediaTime::from_ticks(time as i64),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: ScalarSegmentType::Linear,
            tangent_mode: TangentMode::Auto,
        }
    }

    #[test]
    fn absent_path_is_not_keyframed() {
        let animations: ElementAnimations = HashMap::new();
        assert!(!has_keyframes_for_path_inner(Some(&animations), "opacity"));
    }

    #[test]
    fn empty_channel_is_not_keyframed() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("opacity".to_string(), scalar_channel(vec![]));
        assert!(!has_keyframes_for_path_inner(Some(&animations), "opacity"));
    }

    #[test]
    fn populated_channel_is_keyframed() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![test_key(0.0, 1.0)]),
        );
        assert!(has_keyframes_for_path_inner(Some(&animations), "opacity"));
    }

    #[test]
    fn composite_channel_with_any_populated_component_is_keyframed() {
        let mut components: HashMap<String, AnimationChannel> = HashMap::new();
        components.insert(
            "r".to_string(),
            AnimationChannel::Scalar {
                keys: vec![test_key(0.0, 0.0)],
                extrapolation: None,
            },
        );
        components.insert(
            "g".to_string(),
            AnimationChannel::Scalar {
                keys: vec![],
                extrapolation: None,
            },
        );
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "background.color".to_string(),
            ChannelData::Composite(components),
        );
        assert!(has_keyframes_for_path_inner(
            Some(&animations),
            "background.color"
        ));
    }

    #[test]
    fn missing_animations_argument_is_not_keyframed() {
        assert!(!has_keyframes_for_path_inner(None, "opacity"));
    }

    #[test]
    fn local_time_clamps_to_start_when_before_clip() {
        assert_eq!(
            get_element_local_time_inner(GetElementLocalTimeOptions {
                timeline_time: -100.0,
                element_start_time: 0.0,
                element_duration: 1000.0,
            }),
            0.0
        );
    }

    #[test]
    fn local_time_clamps_to_end_when_past_clip() {
        assert_eq!(
            get_element_local_time_inner(GetElementLocalTimeOptions {
                timeline_time: 5_000.0,
                element_start_time: 1_000.0,
                element_duration: 2_000.0,
            }),
            2_000.0
        );
    }

    #[test]
    fn local_time_passes_through_inside_the_span() {
        assert_eq!(
            get_element_local_time_inner(GetElementLocalTimeOptions {
                timeline_time: 1_500.0,
                element_start_time: 1_000.0,
                element_duration: 2_000.0,
            }),
            500.0
        );
    }

    #[test]
    fn local_time_at_clip_start_is_zero() {
        assert_eq!(
            get_element_local_time_inner(GetElementLocalTimeOptions {
                timeline_time: 1_000.0,
                element_start_time: 1_000.0,
                element_duration: 2_000.0,
            }),
            0.0
        );
    }

    // --- Element keyframes ----------------------------------------------------

    fn scalar_key_with_segment(
        id: &str,
        time: i64,
        value: f64,
        segment: ScalarSegmentType,
    ) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: id.to_string(),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: segment,
            tangent_mode: TangentMode::Flat,
        }
    }

    fn discrete_key(id: &str, time: i64, value: DiscreteValue) -> DiscreteAnimationKey {
        DiscreteAnimationKey {
            id: id.to_string(),
            time: MediaTime::from_ticks(time),
            value,
        }
    }

    fn discrete_channel(keys: Vec<DiscreteAnimationKey>) -> ChannelData {
        ChannelData::Channel(AnimationChannel::Discrete { keys })
    }

    fn composite_color(components: HashMap<String, AnimationChannel>) -> ChannelData {
        ChannelData::Composite(components)
    }

    #[test]
    fn get_element_keyframes_returns_empty_for_absent_animations() {
        assert!(get_element_keyframes_inner(None).is_empty());
    }

    #[test]
    fn get_element_keyframes_returns_empty_for_empty_animations() {
        let animations: ElementAnimations = HashMap::new();
        assert!(get_element_keyframes_inner(Some(&animations)).is_empty());
    }

    #[test]
    fn get_element_keyframes_skips_legacy_bindings_and_channels_keys() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![test_key(0.0, 1.0)]),
        );
        animations.insert(
            "bindings".to_string(),
            scalar_channel(vec![test_key(0.0, 9.0)]),
        );
        animations.insert(
            "channels".to_string(),
            scalar_channel(vec![test_key(0.0, 8.0)]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 1);
        assert_eq!(keyframes[0].property_path, "opacity");
    }

    #[test]
    fn get_element_keyframes_skips_paths_that_are_not_animation_paths() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![test_key(0.0, 1.0)]),
        );
        animations.insert(
            "transform".to_string(),
            scalar_channel(vec![test_key(0.0, 2.0)]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 1);
        assert_eq!(keyframes[0].property_path, "opacity");
    }

    #[test]
    fn get_element_keyframes_includes_graphic_and_effect_param_paths() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "params.radius".to_string(),
            scalar_channel(vec![test_key(0.0, 0.25)]),
        );
        animations.insert(
            "effects.fx1.params.amount".to_string(),
            scalar_channel(vec![test_key(0.0, 0.5)]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 2);
        let paths: Vec<&str> = keyframes
            .iter()
            .map(|keyframe| keyframe.property_path.as_str())
            .collect();
        assert!(paths.contains(&"params.radius"));
        assert!(paths.contains(&"effects.fx1.params.amount"));
    }

    #[test]
    fn get_element_keyframes_returns_one_entry_per_leaf_keyframe() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![
                scalar_key_with_segment("ka", 0, 1.0, ScalarSegmentType::Linear),
                scalar_key_with_segment("kb", 500, 0.5, ScalarSegmentType::Bezier),
            ]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 2);
        assert_eq!(keyframes[0].id, "ka");
        assert_eq!(keyframes[0].time.as_ticks(), 0);
        assert_eq!(keyframes[0].value, ParamValue::Number(1.0));
        assert_eq!(keyframes[0].interpolation, AnimationInterpolation::Linear);
        assert_eq!(keyframes[1].id, "kb");
        assert_eq!(keyframes[1].interpolation, AnimationInterpolation::Bezier);
    }

    #[test]
    fn get_element_keyframes_dedupes_keys_at_the_same_time() {
        // All four colour components share a key at time 100. The iteration
        // order puts the alphabetically-first component first, so the deduped
        // entry comes from `a` (component_index 0) and carries id `ka`, even
        // though `r` is the more conventional first colour channel.
        let components: HashMap<String, AnimationChannel> = HashMap::from([
            (
                "r".to_string(),
                scalar_keyed_channel("kr", 100, 1.0),
            ),
            (
                "g".to_string(),
                scalar_keyed_channel("kg", 100, 0.0),
            ),
            (
                "b".to_string(),
                scalar_keyed_channel("kb", 100, 0.0),
            ),
            (
                "a".to_string(),
                scalar_keyed_channel("ka", 100, 0.5),
            ),
        ]);
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), composite_color(components));

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 1);
        assert_eq!(keyframes[0].id, "ka");
        assert_eq!(keyframes[0].time.as_ticks(), 100);
        // All four r/g/b/a are numeric, so the value is formatted rgba.
        assert!(matches!(keyframes[0].value, ParamValue::Text(_)));
    }

    fn scalar_keyed_channel(id: &str, time: i64, value: f64) -> AnimationChannel {
        AnimationChannel::Scalar {
            keys: vec![scalar_key_with_segment(
                id,
                time,
                value,
                ScalarSegmentType::Linear,
            )],
            extrapolation: None,
        }
    }

    #[test]
    fn get_element_keyframes_resolves_a_color_as_rgba() {
        let component = |value: f64| AnimationChannel::Scalar {
            keys: vec![scalar_key_with_segment(
                "k",
                0,
                value,
                ScalarSegmentType::Linear,
            )],
            extrapolation: None,
        };
        let components: HashMap<String, AnimationChannel> = HashMap::from([
            ("r".to_string(), component(1.0)),
            ("g".to_string(), component(0.0)),
            ("b".to_string(), component(0.0)),
            ("a".to_string(), component(1.0)),
        ]);
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), composite_color(components));

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 1);
        // Linear (1, 0, 0, 1) formats as opaque red: #ff0000.
        assert_eq!(keyframes[0].value, ParamValue::Text("#ff0000".to_string()));
        assert_eq!(keyframes[0].interpolation, AnimationInterpolation::Linear);
    }

    #[test]
    fn get_element_keyframes_skips_a_color_missing_a_component() {
        let components: HashMap<String, AnimationChannel> = HashMap::from([(
            "r".to_string(),
            AnimationChannel::Scalar {
                keys: vec![scalar_key_with_segment(
                    "k",
                    0,
                    1.0,
                    ScalarSegmentType::Linear,
                )],
                extrapolation: None,
            },
        )]);
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), composite_color(components));

        assert!(get_element_keyframes_inner(Some(&animations)).is_empty());
    }

    #[test]
    fn get_element_keyframes_records_a_discrete_value_as_hold() {
        // Discrete channels can sit on any animation path; the channel kind —
        // not the path — decides the value type and interpolation.
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            discrete_channel(vec![discrete_key("kh", 0, DiscreteValue::Bool(true))]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes.len(), 1);
        assert_eq!(keyframes[0].value, ParamValue::Bool(true));
        assert_eq!(keyframes[0].interpolation, AnimationInterpolation::Hold);
    }

    #[test]
    fn get_element_keyframes_maps_step_segment_to_hold() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![scalar_key_with_segment(
                "k",
                0,
                0.0,
                ScalarSegmentType::Step,
            )]),
        );

        let keyframes = get_element_keyframes_inner(Some(&animations));
        assert_eq!(keyframes[0].interpolation, AnimationInterpolation::Hold);
    }

    #[test]
    fn get_keyframe_at_time_returns_none_for_absent_animations() {
        assert!(get_keyframe_at_time_inner(None, "opacity", 0).is_none());
    }

    #[test]
    fn get_keyframe_at_time_returns_none_for_missing_path() {
        let animations: ElementAnimations = HashMap::new();
        assert!(get_keyframe_at_time_inner(Some(&animations), "opacity", 0).is_none());
    }

    #[test]
    fn get_keyframe_at_time_finds_a_match_in_a_leaf_scalar_channel() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![scalar_key_with_segment(
                "k",
                100,
                0.5,
                ScalarSegmentType::Linear,
            )]),
        );

        let keyframe = get_keyframe_at_time_inner(Some(&animations), "opacity", 100)
            .expect("the key exists");
        assert_eq!(keyframe.property_path, "opacity");
        assert_eq!(keyframe.id, "k");
        assert_eq!(keyframe.time.as_ticks(), 100);
        assert_eq!(keyframe.value, ParamValue::Number(0.5));
    }

    #[test]
    fn get_keyframe_at_time_finds_a_match_in_a_composite_when_leaf_has_none() {
        // The composite "color" carries r/g/b/a, all with a key at time 100.
        // The leaf channel under `"value"` doesn't exist for a composite, so
        // the match comes from the alphabetically-first component (`a`).
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "color".to_string(),
            composite_color(HashMap::from([
                ("r".to_string(), scalar_keyed_channel("kr", 100, 1.0)),
                ("g".to_string(), scalar_keyed_channel("kg", 100, 0.0)),
                ("b".to_string(), scalar_keyed_channel("kb", 100, 0.0)),
                ("a".to_string(), scalar_keyed_channel("ka", 100, 1.0)),
            ])),
        );

        let keyframe =
            get_keyframe_at_time_inner(Some(&animations), "color", 100).expect("present");
        assert_eq!(keyframe.property_path, "color");
        // `a` is component_index 0, alphabetically first — its key id wins.
        assert_eq!(keyframe.id, "ka");
        assert_eq!(keyframe.time.as_ticks(), 100);
        // All four components contribute to the rgba value.
        assert_eq!(keyframe.value, ParamValue::Text("#ff0000".to_string()));
    }

    #[test]
    fn get_keyframe_at_time_returns_none_when_no_key_matches() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![scalar_key_with_segment(
                "k",
                100,
                0.5,
                ScalarSegmentType::Linear,
            )]),
        );

        assert!(get_keyframe_at_time_inner(Some(&animations), "opacity", 200).is_none());
    }

    #[test]
    fn get_keyframe_by_id_finds_a_match() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![
                scalar_key_with_segment("ka", 0, 0.0, ScalarSegmentType::Linear),
                scalar_key_with_segment("kb", 500, 1.0, ScalarSegmentType::Bezier),
            ]),
        );

        let keyframe = get_keyframe_by_id_inner(Some(&animations), "opacity", "kb")
            .expect("kb exists");
        assert_eq!(keyframe.id, "kb");
        assert_eq!(keyframe.time.as_ticks(), 500);
        assert_eq!(keyframe.value, ParamValue::Number(1.0));
        assert_eq!(keyframe.interpolation, AnimationInterpolation::Bezier);
    }

    #[test]
    fn get_keyframe_by_id_returns_none_when_id_does_not_match() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "opacity".to_string(),
            scalar_channel(vec![scalar_key_with_segment(
                "ka",
                0,
                1.0,
                ScalarSegmentType::Linear,
            )]),
        );

        assert!(get_keyframe_by_id_inner(Some(&animations), "opacity", "missing").is_none());
    }

    #[test]
    fn get_keyframe_by_id_breaks_id_collisions_with_component_zero_first() {
        // Two components share the same key id. The "preferred" rule picks
        // component_index 0 first, which for a composite is the
        // alphabetically-first component (`a`), not the conventional colour
        // channel (`r`).
        let mut components: HashMap<String, AnimationChannel> = HashMap::new();
        components.insert(
            "r".to_string(),
            scalar_keyed_channel("shared", 100, 1.0),
        );
        components.insert(
            "g".to_string(),
            scalar_keyed_channel("kg", 100, 0.0),
        );
        components.insert(
            "b".to_string(),
            scalar_keyed_channel("kb", 100, 0.0),
        );
        components.insert(
            "a".to_string(),
            scalar_keyed_channel("shared", 100, 1.0),
        );
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert("color".to_string(), composite_color(components));

        let keyframe =
            get_keyframe_by_id_inner(Some(&animations), "color", "shared").expect("present");
        assert_eq!(keyframe.id, "shared");
        assert_eq!(keyframe.interpolation, AnimationInterpolation::Linear);
        // The value field carries the rgba combination when all four
        // components contribute; the preference rule governs which component's
        // segment type the interpolation reports.
        assert!(matches!(keyframe.value, ParamValue::Text(_)));
    }

    // --- Resolving an animated value -----------------------------------------

    #[test]
    fn resolve_returns_the_number_fallback_when_animations_are_absent() {
        let result = resolve_animation_path_value_at_time_inner(
            None,
            "opacity",
            100,
            &ParamValue::Number(0.5),
        );
        assert_eq!(result, ResolvedAnimationValue::Number(0.5));
    }

    #[test]
    fn resolve_returns_the_string_fallback_when_animations_are_absent() {
        let result = resolve_animation_path_value_at_time_inner(
            None,
            "color",
            100,
            &ParamValue::Text("#ff0000".to_string()),
        );
        assert_eq!(
            result,
            ResolvedAnimationValue::Text("#ff0000".to_string())
        );
    }

    #[test]
    fn resolve_returns_the_bool_fallback_when_animations_are_absent() {
        let result = resolve_animation_path_value_at_time_inner(
            None,
            "hidden",
            100,
            &ParamValue::Bool(true),
        );
        assert_eq!(result, ResolvedAnimationValue::Bool(true));
    }

    #[test]
    fn resolve_returns_the_fallback_when_the_property_path_is_missing() {
        let animations: ElementAnimations = HashMap::new();
        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "opacity",
            100,
            &ParamValue::Number(0.25),
        );
        assert_eq!(result, ResolvedAnimationValue::Number(0.25));
    }

    #[test]
    fn resolve_reads_a_leaf_scalar_channel_with_a_number_fallback() {
        let animations = animated("opacity", scalar_channel(vec![
            scalar_key_with_segment("k0", 0, 0.0, ScalarSegmentType::Linear),
            scalar_key_with_segment("k1", 1000, 1.0, ScalarSegmentType::Linear),
        ]));

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "opacity",
            500,
            &ParamValue::Number(7.5),
        );
        assert_eq!(result, ResolvedAnimationValue::Number(0.5));
    }

    #[test]
    fn resolve_returns_the_string_fallback_when_a_scalar_channel_is_asked_for_a_string() {
        // A scalar channel can't answer a string question, so the fallback
        // comes back untouched rather than the channel being misread.
        let animations = animated("font", scalar_channel(vec![test_key(0.0, 12.0)]));

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "font",
            100,
            &ParamValue::Text("Arial".to_string()),
        );
        assert_eq!(
            result,
            ResolvedAnimationValue::Text("Arial".to_string())
        );
    }

    #[test]
    fn resolve_returns_the_bool_fallback_when_a_scalar_channel_is_asked_for_a_bool() {
        let animations = animated("opacity", scalar_channel(vec![test_key(0.0, 1.0)]));

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "opacity",
            100,
            &ParamValue::Bool(true),
        );
        assert_eq!(result, ResolvedAnimationValue::Bool(true));
    }

    #[test]
    fn resolve_reads_a_discrete_channel_with_a_bool_fallback() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "hidden".to_string(),
            discrete_channel(vec![
                discrete_key("k0", 0, DiscreteValue::Bool(false)),
                discrete_key("k1", 1000, DiscreteValue::Bool(true)),
            ]),
        );

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "hidden",
            999,
            &ParamValue::Bool(false),
        );
        assert_eq!(result, ResolvedAnimationValue::Bool(false));

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "hidden",
            1000,
            &ParamValue::Bool(false),
        );
        assert_eq!(result, ResolvedAnimationValue::Bool(true));
    }

    #[test]
    fn resolve_reads_a_composite_channel_as_a_color() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "color".to_string(),
            composite_color(HashMap::from([
                ("r".to_string(), scalar_keyed_channel("kr", 0, 1.0)),
                ("g".to_string(), scalar_keyed_channel("kg", 0, 0.0)),
                ("b".to_string(), scalar_keyed_channel("kb", 0, 0.0)),
                ("a".to_string(), scalar_keyed_channel("ka", 0, 1.0)),
            ])),
        );

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "color",
            0,
            &ParamValue::Text("#000000".to_string()),
        );
        // Linear (1, 0, 0, 1) formats as opaque red.
        assert_eq!(result, ResolvedAnimationValue::Text("#ff0000".to_string()));
    }

    #[test]
    fn resolve_falls_back_to_the_string_when_the_composite_fallback_cannot_be_parsed() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "color".to_string(),
            composite_color(HashMap::from([
                ("r".to_string(), scalar_keyed_channel("kr", 0, 1.0)),
                ("g".to_string(), scalar_keyed_channel("kg", 0, 0.0)),
                ("b".to_string(), scalar_keyed_channel("kb", 0, 0.0)),
                ("a".to_string(), scalar_keyed_channel("ka", 0, 1.0)),
            ])),
        );

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "color",
            0,
            &ParamValue::Text("".to_string()),
        );
        assert_eq!(result, ResolvedAnimationValue::Text("".to_string()));
    }

    #[test]
    fn resolve_falls_back_to_the_string_when_the_composite_is_missing_a_component() {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(
            "color".to_string(),
            composite_color(HashMap::from([
                ("r".to_string(), scalar_keyed_channel("kr", 0, 1.0)),
                ("g".to_string(), scalar_keyed_channel("kg", 0, 0.0)),
                ("b".to_string(), scalar_keyed_channel("kb", 0, 0.0)),
                // "a" intentionally absent.
            ])),
        );

        let result = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "color",
            0,
            &ParamValue::Text("#ff0000".to_string()),
        );
        assert_eq!(
            result,
            ResolvedAnimationValue::Text("#ff0000".to_string())
        );
    }

    #[test]
    fn resolve_clamps_a_negative_local_time_to_zero() {
        let animations = animated("opacity", scalar_channel(vec![
            scalar_key_with_segment("k0", 0, 0.0, ScalarSegmentType::Linear),
            scalar_key_with_segment("k1", 1000, 1.0, ScalarSegmentType::Linear),
        ]));

        let clamped = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "opacity",
            -100,
            &ParamValue::Number(0.0),
        );
        let at_zero = resolve_animation_path_value_at_time_inner(
            Some(&animations),
            "opacity",
            0,
            &ParamValue::Number(0.0),
        );
        assert_eq!(clamped, at_zero);
        assert_eq!(clamped, ResolvedAnimationValue::Number(0.0));
    }

    fn animated(path: &str, data: ChannelData) -> ElementAnimations {
        let mut animations: ElementAnimations = HashMap::new();
        animations.insert(path.to_string(), data);
        animations
    }

    // --- Resolving an animated transform --------------------------------------

    fn base_transform() -> Transform {
        Transform {
            scale_x: 1.0,
            scale_y: 1.5,
            position: TransformPosition { x: 10.0, y: 20.0 },
            rotate: 45.0,
        }
    }

    #[test]
    fn resolve_transform_returns_base_when_animations_are_absent() {
        let base = base_transform();
        let result = resolve_transform_at_time_inner(None, &base, 0);
        assert_eq!(result, base);
    }

    #[test]
    fn resolve_transform_returns_base_when_animations_are_empty() {
        let base = base_transform();
        let animations: ElementAnimations = HashMap::new();
        let result = resolve_transform_at_time_inner(Some(&animations), &base, 0);
        assert_eq!(result, base);
    }

    #[test]
    fn resolve_transform_reads_an_animated_property_and_falls_back_others() {
        let base = base_transform();
        let animations = animated(
            "transform.scaleX",
            scalar_channel(vec![scalar_key_with_segment(
                "k",
                0,
                2.5,
                ScalarSegmentType::Linear,
            )]),
        );

        let result = resolve_transform_at_time_inner(Some(&animations), &base, 0);
        assert_eq!(result.scale_x, 2.5);
        assert_eq!(result.scale_y, base.scale_y);
        assert_eq!(result.position, base.position);
        assert_eq!(result.rotate, base.rotate);
    }

    #[test]
    fn resolve_transform_clamps_negative_local_time_to_zero() {
        let base = base_transform();
        let animations = animated(
            "transform.rotate",
            scalar_channel(vec![
                scalar_key_with_segment("k0", 0, 0.0, ScalarSegmentType::Linear),
                scalar_key_with_segment("k1", 1000, 90.0, ScalarSegmentType::Linear),
            ]),
        );

        let at_zero = resolve_transform_at_time_inner(Some(&animations), &base, 0);
        let at_negative = resolve_transform_at_time_inner(Some(&animations), &base, -100);
        assert_eq!(at_zero, at_negative);
        assert_eq!(at_zero.rotate, 0.0);
    }

    #[test]
    fn resolve_transform_returns_fallback_for_an_unrelated_animated_path() {
        // An animation stored under `unknown.path` does not feed any of the
        // five transform fields, so the resolved transform still equals the
        // base for every field.
        let base = base_transform();
        let animations = animated(
            "unknown.path",
            scalar_channel(vec![scalar_key_with_segment(
                "k",
                0,
                99.0,
                ScalarSegmentType::Linear,
            )]),
        );

        let result = resolve_transform_at_time_inner(Some(&animations), &base, 0);
        assert_eq!(result, base);
    }

    #[test]
    fn resolve_transform_mixes_animated_and_fallback_fields() {
        // Only `transform.positionX` and `transform.scaleY` carry animations;
        // the other three fields fall back to the base.
        let base = base_transform();
        let animations: ElementAnimations = HashMap::from([
            (
                "transform.positionX".to_string(),
                scalar_channel(vec![scalar_key_with_segment(
                    "kx",
                    0,
                    100.0,
                    ScalarSegmentType::Linear,
                )]),
            ),
            (
                "transform.scaleY".to_string(),
                scalar_channel(vec![scalar_key_with_segment(
                    "ky",
                    0,
                    2.0,
                    ScalarSegmentType::Linear,
                )]),
            ),
        ]);

        let result = resolve_transform_at_time_inner(Some(&animations), &base, 0);
        assert_eq!(result.position.x, 100.0);
        assert_eq!(result.position.y, base.position.y);
        assert_eq!(result.scale_x, base.scale_x);
        assert_eq!(result.scale_y, 2.0);
        assert_eq!(result.rotate, base.rotate);
    }
}