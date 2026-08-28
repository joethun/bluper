//! Editing an element's animation channels: splitting, cloning, moving and
//! removing keys.
//!
//! Everything here runs when someone edits, not once per frame, so a whole
//! `ElementAnimations` crossing per call is not a cost worth designing around.
//!
//! **Generated ids.** The TypeScript called `crypto.randomUUID()` for split
//! boundaries and regenerated clone ids. Rather than pull randomness into wasm,
//! the caller passes one `idSeed` and this derives `"{seed}-{n}"` from it. Ids
//! are opaque — nothing parses them — so what matters is that they are unique
//! within the document, and a fresh seed per call gives that.

use std::collections::HashMap;

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::model::{
    AnimationChannel, ChannelData, DiscreteAnimationKey, DiscreteValue, ElementAnimations,
    ParamValue,
};

use super::bezier::{
    CurveHandle, DefaultHandleOptions, ScalarAnimationKey, ScalarSegmentType, TangentMode,
    SolveBezierProgressOptions, default_left_handle, default_right_handle,
    solve_bezier_progress_for_time,
};
use super::interpolation::{
    AnimationInterpolation, ChannelOptions, ChannelValueAtTimeOptions,
    get_channel_value_at_time, get_scalar_segment_interpolation, normalize_channel,
    normalize_discrete_keys, normalize_scalar_keys,
};

/// Keys the fork used to store animations under, which are no longer written and
/// must not be carried forward.
const LEGACY_STORAGE_KEYS: [&str; 2] = ["bindings", "channels"];

fn is_animation_storage_key(key: &str) -> bool {
    !LEGACY_STORAGE_KEYS.contains(&key)
}

/// Mints unique ids from a single caller-supplied seed.
struct IdMinter {
    seed: String,
    next: usize,
}

impl IdMinter {
    fn new(seed: String) -> Self {
        Self { seed, next: 0 }
    }

    fn mint(&mut self) -> String {
        let id = format!("{}-{}", self.seed, self.next);
        self.next += 1;
        id
    }
}

fn channel_keys_len(channel: &AnimationChannel) -> usize {
    match channel {
        AnimationChannel::Scalar { keys, .. } => keys.len(),
        AnimationChannel::Discrete { keys } => keys.len(),
    }
}

fn channels_of(data: &ChannelData) -> Vec<&AnimationChannel> {
    match data {
        ChannelData::Channel(channel) => vec![channel],
        ChannelData::Composite(components) => components.values().collect(),
    }
}

/// Component key → channel. A leaf channel answers under `"value"`, which is the
/// key the rest of the system uses for a value with no components.
fn channel_entries(data: &ChannelData) -> Vec<(String, AnimationChannel)> {
    match data {
        ChannelData::Channel(channel) => vec![("value".to_string(), channel.clone())],
        ChannelData::Composite(components) => {
            let mut entries: Vec<(String, AnimationChannel)> = components
                .iter()
                .map(|(key, channel)| (key.clone(), channel.clone()))
                .collect();
            // `Object.entries` follows insertion order; a `HashMap` has none, so
            // sort to make the traversal deterministic.
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        }
    }
}

fn channel_from_data(data: Option<&ChannelData>, component_key: &str) -> Option<AnimationChannel> {
    match data? {
        ChannelData::Channel(channel) => {
            (component_key == "value").then(|| channel.clone())
        }
        ChannelData::Composite(components) => components.get(component_key).cloned(),
    }
}

fn set_channel_in_data(
    data: Option<&ChannelData>,
    component_key: &str,
    channel: Option<AnimationChannel>,
) -> Option<ChannelData> {
    if component_key == "value" {
        return channel.map(ChannelData::Channel);
    }

    let mut components: HashMap<String, AnimationChannel> = match data {
        Some(ChannelData::Composite(existing)) => existing.clone(),
        _ => HashMap::new(),
    };
    match channel {
        Some(channel) if channel_keys_len(&channel) > 0 => {
            components.insert(component_key.to_string(), channel);
        }
        _ => {
            components.remove(component_key);
        }
    }
    (!components.is_empty()).then_some(ChannelData::Composite(components))
}

/// Drops legacy keys and anything with no keys left, and collapses an entirely
/// empty result to nothing — an element with an empty animations bag is stored
/// as having none.
fn to_animation(animations: HashMap<String, ChannelData>) -> Option<ElementAnimations> {
    let kept: HashMap<String, ChannelData> = animations
        .into_iter()
        .filter(|(key, data)| {
            is_animation_storage_key(key)
                && channels_of(data)
                    .iter()
                    .any(|channel| channel_keys_len(channel) > 0)
        })
        .collect();
    (!kept.is_empty()).then_some(kept)
}

fn scalar_segment_type(interpolation: AnimationInterpolation) -> ScalarSegmentType {
    match interpolation {
        AnimationInterpolation::Hold => ScalarSegmentType::Step,
        AnimationInterpolation::Bezier => ScalarSegmentType::Bezier,
        AnimationInterpolation::Linear => ScalarSegmentType::Linear,
    }
}

fn create_scalar_key(
    id: String,
    time: MediaTime,
    value: f64,
    interpolation: AnimationInterpolation,
    previous: Option<&ScalarAnimationKey>,
) -> ScalarAnimationKey {
    ScalarAnimationKey {
        id,
        time,
        value,
        left_handle: previous.and_then(|key| key.left_handle),
        right_handle: previous.and_then(|key| key.right_handle),
        segment_to_next: previous
            .map(|key| key.segment_to_next)
            .unwrap_or_else(|| scalar_segment_type(interpolation)),
        tangent_mode: previous.map_or(TangentMode::Flat, |key| key.tangent_mode),
    }
}

/// Project a fractional tick count onto the lattice the way `roundMediaTime`
/// does: half away from zero, `-0` normalised to `0`.
fn round_ticks(time: f64) -> MediaTime {
    let magnitude = time.abs().round();
    if magnitude == 0.0 {
        return MediaTime::ZERO;
    }
    MediaTime::from_ticks(if time < 0.0 {
        -magnitude as i64
    } else {
        magnitude as i64
    })
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

fn lerp_point(from: Point, to: Point, progress: f64) -> Point {
    Point {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
    }
}

struct Subdivision {
    p01: Point,
    p23: Point,
    p012: Point,
    p123: Point,
    point: Point,
}

/// De Casteljau at `t`: the two halves' control points, and where the curve is.
fn subdivide_cubic_bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: f64) -> Subdivision {
    let p01 = lerp_point(p0, p1, t);
    let p12 = lerp_point(p1, p2, t);
    let p23 = lerp_point(p2, p3, t);
    let p012 = lerp_point(p01, p12, t);
    let p123 = lerp_point(p12, p23, t);
    Subdivision {
        p01,
        p23,
        p012,
        p123,
        point: lerp_point(p012, p123, t),
    }
}

struct SplitChannels {
    left: Option<AnimationChannel>,
    right: Option<AnimationChannel>,
}

fn normalized(channel: AnimationChannel) -> AnimationChannel {
    normalize_channel(ChannelOptions { channel })
}

fn split_discrete_channel(
    keys: &[DiscreteAnimationKey],
    split_time: MediaTime,
    left_boundary_id: &str,
    right_boundary_id: &str,
    include_boundary: bool,
) -> SplitChannels {
    if keys.is_empty() {
        return SplitChannels {
            left: None,
            right: None,
        };
    }

    let source = normalized(AnimationChannel::Discrete {
        keys: keys.to_vec(),
    });
    let AnimationChannel::Discrete { keys: source_keys } = &source else {
        unreachable!("a discrete channel normalises to a discrete channel")
    };

    let mut left_keys: Vec<DiscreteAnimationKey> = source_keys
        .iter()
        .filter(|key| key.time.as_ticks() <= split_time.as_ticks())
        .cloned()
        .collect();
    let mut right_keys: Vec<DiscreteAnimationKey> = source_keys
        .iter()
        .filter(|key| key.time.as_ticks() >= split_time.as_ticks())
        .map(|key| DiscreteAnimationKey {
            time: MediaTime::from_ticks(key.time.as_ticks() - split_time.as_ticks()),
            ..key.clone()
        })
        .collect();

    if include_boundary {
        let has_left = left_keys
            .iter()
            .any(|key| key.time.as_ticks() == split_time.as_ticks());
        let has_right = right_keys.iter().any(|key| key.time.as_ticks() == 0);
        let boundary = match get_channel_value_at_time(ChannelValueAtTimeOptions {
            channel: Some(source.clone()),
            time: split_time.as_ticks() as f64,
            fallback_value: match &source_keys[0].value {
                DiscreteValue::Bool(value) => ParamValue::Bool(*value),
                DiscreteValue::Text(value) => ParamValue::Text(value.clone()),
            },
        }) {
            ParamValue::Bool(value) => DiscreteValue::Bool(value),
            ParamValue::Text(value) => DiscreteValue::Text(value),
            ParamValue::Number(_) => source_keys[0].value.clone(),
        };

        if !has_left {
            left_keys.push(DiscreteAnimationKey {
                id: left_boundary_id.to_string(),
                time: split_time,
                value: boundary.clone(),
            });
        }
        if !has_right {
            right_keys.insert(
                0,
                DiscreteAnimationKey {
                    id: right_boundary_id.to_string(),
                    time: MediaTime::ZERO,
                    value: boundary,
                },
            );
        }
    }

    SplitChannels {
        left: (!left_keys.is_empty())
            .then(|| normalized(AnimationChannel::Discrete { keys: left_keys })),
        right: (!right_keys.is_empty())
            .then(|| normalized(AnimationChannel::Discrete { keys: right_keys })),
    }
}

fn split_scalar_channel(
    keys: &[ScalarAnimationKey],
    extrapolation: Option<crate::model::ChannelExtrapolation>,
    split_time: MediaTime,
    left_boundary_id: &str,
    right_boundary_id: &str,
    include_boundary: bool,
) -> SplitChannels {
    if keys.is_empty() {
        return SplitChannels {
            left: None,
            right: None,
        };
    }

    let source = normalized(AnimationChannel::Scalar {
        keys: keys.to_vec(),
        extrapolation,
    });
    let AnimationChannel::Scalar {
        keys: source_keys,
        extrapolation,
    } = &source
    else {
        unreachable!("a scalar channel normalises to a scalar channel")
    };
    let split_ticks = split_time.as_ticks();

    let mut left_keys: Vec<ScalarAnimationKey> = source_keys
        .iter()
        .filter(|key| key.time.as_ticks() <= split_ticks)
        .cloned()
        .collect();
    let mut right_keys: Vec<ScalarAnimationKey> = source_keys
        .iter()
        .filter(|key| key.time.as_ticks() >= split_ticks)
        .map(|key| ScalarAnimationKey {
            time: MediaTime::from_ticks(key.time.as_ticks() - split_ticks),
            ..key.clone()
        })
        .collect();

    let has_left = left_keys.iter().any(|key| key.time.as_ticks() == split_ticks);
    let has_right = right_keys.iter().any(|key| key.time.as_ticks() == 0);
    let build = |keys: Vec<ScalarAnimationKey>| {
        (!keys.is_empty()).then(|| {
            normalized(AnimationChannel::Scalar {
                keys,
                extrapolation: *extrapolation,
            })
        })
    };

    if !include_boundary || (has_left && has_right) {
        return SplitChannels {
            left: build(left_keys),
            right: build(right_keys),
        };
    }

    // Find the segment the split falls strictly inside. Outside every segment
    // there is nothing to cut, so the halves stand as filtered.
    for index in 0..source_keys.len().saturating_sub(1) {
        let left_key = &source_keys[index];
        let right_key = &source_keys[index + 1];
        if !(split_ticks > left_key.time.as_ticks() && split_ticks < right_key.time.as_ticks()) {
            continue;
        }

        let boundary_value = match get_channel_value_at_time(ChannelValueAtTimeOptions {
            channel: Some(source.clone()),
            time: split_ticks as f64,
            fallback_value: ParamValue::Number(left_key.value),
        }) {
            ParamValue::Number(value) => value,
            _ => left_key.value,
        };

        if left_key.segment_to_next == ScalarSegmentType::Bezier {
            // Cutting a curve is not the same as dropping a key at the crossing
            // point: both halves have to keep the shape they had. De Casteljau
            // gives the two sets of control points that do that.
            let right_handle = left_key.right_handle.unwrap_or_else(|| {
                default_right_handle(DefaultHandleOptions {
                    left_key: left_key.clone(),
                    right_key: right_key.clone(),
                })
            });
            let left_handle = right_key.left_handle.unwrap_or_else(|| {
                default_left_handle(DefaultHandleOptions {
                    left_key: left_key.clone(),
                    right_key: right_key.clone(),
                })
            });
            let progress = solve_bezier_progress_for_time(SolveBezierProgressOptions {
                time: split_ticks as f64,
                left_key: left_key.clone(),
                right_key: right_key.clone(),
            });

            let p0 = Point {
                x: left_key.time.as_ticks() as f64,
                y: left_key.value,
            };
            let p1 = Point {
                x: left_key.time.as_ticks() as f64 + right_handle.dt,
                y: left_key.value + right_handle.dv,
            };
            let p2 = Point {
                x: right_key.time.as_ticks() as f64 + left_handle.dt,
                y: right_key.value + left_handle.dv,
            };
            let p3 = Point {
                x: right_key.time.as_ticks() as f64,
                y: right_key.value,
            };
            let cut = subdivide_cubic_bezier(p0, p1, p2, p3, progress);

            left_keys = source_keys
                .iter()
                .filter(|key| key.time.as_ticks() < split_ticks)
                .cloned()
                .collect();
            left_keys.push(ScalarAnimationKey {
                right_handle: Some(CurveHandle {
                    dt: round_ticks(cut.p01.x - p0.x).as_ticks() as f64,
                    dv: cut.p01.y - p0.y,
                }),
                ..left_key.clone()
            });
            left_keys.push(ScalarAnimationKey {
                id: left_boundary_id.to_string(),
                time: split_time,
                value: boundary_value,
                left_handle: Some(CurveHandle {
                    dt: round_ticks(cut.p012.x - cut.point.x).as_ticks() as f64,
                    dv: cut.p012.y - cut.point.y,
                }),
                right_handle: None,
                segment_to_next: left_key.segment_to_next,
                tangent_mode: left_key.tangent_mode,
            });

            right_keys = vec![
                ScalarAnimationKey {
                    id: right_boundary_id.to_string(),
                    time: MediaTime::ZERO,
                    value: boundary_value,
                    left_handle: None,
                    right_handle: Some(CurveHandle {
                        dt: round_ticks(cut.p123.x - cut.point.x).as_ticks() as f64,
                        dv: cut.p123.y - cut.point.y,
                    }),
                    segment_to_next: ScalarSegmentType::Bezier,
                    tangent_mode: left_key.tangent_mode,
                },
                ScalarAnimationKey {
                    time: MediaTime::from_ticks(right_key.time.as_ticks() - split_ticks),
                    left_handle: Some(CurveHandle {
                        dt: round_ticks(cut.p23.x - p3.x).as_ticks() as f64,
                        dv: cut.p23.y - p3.y,
                    }),
                    ..right_key.clone()
                },
            ];
            right_keys.extend(
                source_keys
                    .iter()
                    .filter(|key| key.time.as_ticks() > right_key.time.as_ticks())
                    .map(|key| ScalarAnimationKey {
                        time: MediaTime::from_ticks(key.time.as_ticks() - split_ticks),
                        ..key.clone()
                    }),
            );
        } else {
            left_keys.push(create_scalar_key(
                left_boundary_id.to_string(),
                split_time,
                boundary_value,
                AnimationInterpolation::Linear,
                None,
            ));
            right_keys.insert(
                0,
                create_scalar_key(
                    right_boundary_id.to_string(),
                    MediaTime::ZERO,
                    boundary_value,
                    get_scalar_segment_interpolation(
                        super::interpolation::ScalarSegmentInterpolationOptions {
                            segment: left_key.segment_to_next,
                        },
                    ),
                    None,
                ),
            );
        }

        return SplitChannels {
            left: Some(normalized(AnimationChannel::Scalar {
                keys: left_keys,
                extrapolation: *extrapolation,
            })),
            right: Some(normalized(AnimationChannel::Scalar {
                keys: right_keys,
                extrapolation: *extrapolation,
            })),
        };
    }

    SplitChannels {
        left: build(left_keys),
        right: build(right_keys),
    }
}

fn split_channel(
    channel: Option<&AnimationChannel>,
    split_time: MediaTime,
    left_boundary_id: &str,
    right_boundary_id: &str,
    include_boundary: bool,
) -> SplitChannels {
    match channel {
        Some(AnimationChannel::Discrete { keys }) => split_discrete_channel(
            keys,
            split_time,
            left_boundary_id,
            right_boundary_id,
            include_boundary,
        ),
        Some(AnimationChannel::Scalar { keys, extrapolation }) => split_scalar_channel(
            keys,
            *extrapolation,
            split_time,
            left_boundary_id,
            right_boundary_id,
            include_boundary,
        ),
        None => split_scalar_channel(
            &[],
            None,
            split_time,
            left_boundary_id,
            right_boundary_id,
            include_boundary,
        ),
    }
}

/// Wrapper for a possibly-absent animations bag.
///
/// `Option<HashMap<..>>` cannot be returned directly across the boundary — a map
/// has no `OptionIntoWasmAbi` — and naming the shape is better anyway, since "no
/// animations left" is a real outcome rather than an error.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MaybeAnimations {
    pub animations: Option<ElementAnimations>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitAnimations {
    pub left_animations: Option<ElementAnimations>,
    pub right_animations: Option<ElementAnimations>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SplitAnimationsOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub split_time: MediaTime,
    #[serde(default = "default_true")]
    pub should_include_split_boundary: bool,
    /// Seed for the boundary-key ids. See the module note.
    pub id_seed: String,
}

fn default_true() -> bool {
    true
}

/// Cut every channel at `splitTime`, giving the halves a key on the boundary so
/// neither loses the value it had there.
#[export]
pub fn split_animations_at_time(
    SplitAnimationsOptions {
        animations,
        split_time,
        should_include_split_boundary,
        id_seed,
    }: SplitAnimationsOptions,
) -> SplitAnimations {
    let Some(animations) = animations else {
        return SplitAnimations {
            left_animations: None,
            right_animations: None,
        };
    };

    let mut minter = IdMinter::new(id_seed);
    let mut left: HashMap<String, ChannelData> = HashMap::new();
    let mut right: HashMap<String, ChannelData> = HashMap::new();

    let mut paths: Vec<&String> = animations.keys().collect();
    paths.sort();

    for path in paths {
        if !is_animation_storage_key(path) {
            continue;
        }
        let data = &animations[path];
        // One pair of boundary ids per property, shared by its components, so a
        // colour's four channels agree about which key is the boundary.
        let left_boundary_id = minter.mint();
        let right_boundary_id = minter.mint();

        for (component_key, channel) in channel_entries(data) {
            let split = split_channel(
                Some(&channel),
                split_time,
                &left_boundary_id,
                &right_boundary_id,
                should_include_split_boundary,
            );
            if let Some(channel) = split.left {
                if let Some(next) =
                    set_channel_in_data(left.get(path), &component_key, Some(channel))
                {
                    left.insert(path.clone(), next);
                }
            }
            if let Some(channel) = split.right {
                if let Some(next) =
                    set_channel_in_data(right.get(path), &component_key, Some(channel))
                {
                    right.insert(path.clone(), next);
                }
            }
        }
    }

    SplitAnimations {
        left_animations: to_animation(left),
        right_animations: to_animation(right),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClampAnimationsOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub duration: MediaTime,
    pub id_seed: String,
}

/// Trim every channel to the element's length: the left half of a split at
/// `duration`. A zero-length element keeps no animation at all.
/// The plain-`Option` form, for Rust callers — the exported wrapper below
/// only exists to name the return shape for the boundary.
pub fn clamp_animations_to_duration_inner(
    ClampAnimationsOptions {
        animations,
        duration,
        id_seed,
    }: ClampAnimationsOptions,
) -> Option<ElementAnimations> {
    if animations.is_none() || duration.as_ticks() <= 0 {
        return None;
    }

    split_animations_at_time(SplitAnimationsOptions {
        animations,
        split_time: duration,
        should_include_split_boundary: true,
        id_seed,
    })
    .left_animations
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloneAnimationsOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    #[serde(default)]
    pub should_regenerate_keyframe_ids: bool,
    pub id_seed: String,
}

/// Copy the animations, optionally minting fresh key ids.
///
/// The id map is built from the *first* channel of each property and then
/// applied to all of them, so a colour's components keep pointing at the same
/// logical keyframe as each other.
fn clone_animations_inner(
    CloneAnimationsOptions {
        animations,
        should_regenerate_keyframe_ids,
        id_seed,
    }: CloneAnimationsOptions,
) -> Option<ElementAnimations> {
    let animations = animations?;
    let mut minter = IdMinter::new(id_seed);
    let mut next: HashMap<String, ChannelData> = animations.clone();

    let mut paths: Vec<String> = animations.keys().cloned().collect();
    paths.sort();

    for path in paths {
        if !is_animation_storage_key(&path) {
            continue;
        }
        let data = &animations[&path];
        let mut id_map: HashMap<String, String> = HashMap::new();
        if let Some(primary) = channels_of(data).first() {
            match primary {
                AnimationChannel::Scalar { keys, .. } => {
                    for key in keys {
                        let replacement = if should_regenerate_keyframe_ids {
                            minter.mint()
                        } else {
                            key.id.clone()
                        };
                        id_map.insert(key.id.clone(), replacement);
                    }
                }
                AnimationChannel::Discrete { keys } => {
                    for key in keys {
                        let replacement = if should_regenerate_keyframe_ids {
                            minter.mint()
                        } else {
                            key.id.clone()
                        };
                        id_map.insert(key.id.clone(), replacement);
                    }
                }
            }
        }

        let rewrite = |channel: &AnimationChannel| -> AnimationChannel {
            normalized(match channel {
                AnimationChannel::Scalar { keys, extrapolation } => AnimationChannel::Scalar {
                    keys: keys
                        .iter()
                        .map(|key| ScalarAnimationKey {
                            id: id_map.get(&key.id).cloned().unwrap_or_else(|| key.id.clone()),
                            ..key.clone()
                        })
                        .collect(),
                    extrapolation: *extrapolation,
                },
                AnimationChannel::Discrete { keys } => AnimationChannel::Discrete {
                    keys: keys
                        .iter()
                        .map(|key| DiscreteAnimationKey {
                            id: id_map.get(&key.id).cloned().unwrap_or_else(|| key.id.clone()),
                            ..key.clone()
                        })
                        .collect(),
                },
            })
        };

        let replacement = match data {
            ChannelData::Channel(channel) => ChannelData::Channel(rewrite(channel)),
            ChannelData::Composite(components) => ChannelData::Composite(
                components
                    .iter()
                    .map(|(key, channel)| (key.clone(), rewrite(channel)))
                    .collect(),
            ),
        };
        next.insert(path, replacement);
    }

    to_animation(next)
}

fn set_binding_component_channel(
    animations: Option<ElementAnimations>,
    property_path: &str,
    component_key: &str,
    channel: Option<AnimationChannel>,
) -> Option<ElementAnimations> {
    let mut next: HashMap<String, ChannelData> = animations.unwrap_or_default();
    let normalised = channel.and_then(|channel| {
        (channel_keys_len(&channel) > 0).then(|| normalized(channel))
    });
    match set_channel_in_data(next.get(property_path), component_key, normalised) {
        Some(data) => {
            next.insert(property_path.to_string(), data);
        }
        None => {
            next.remove(property_path);
        }
    }
    to_animation(next)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetChannelOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    #[serde(default)]
    pub channel: Option<AnimationChannel>,
}

fn set_channel_inner(
    SetChannelOptions {
        animations,
        property_path,
        channel,
    }: SetChannelOptions,
) -> Option<ElementAnimations> {
    set_binding_component_channel(animations, &property_path, "value", channel)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyframeRefOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    pub keyframe_id: String,
}

/// Drop a key from every component of a property. A channel left with no keys is
/// removed rather than kept empty.
fn remove_element_keyframe_inner(
    KeyframeRefOptions {
        animations,
        property_path,
        keyframe_id,
    }: KeyframeRefOptions,
) -> Option<ElementAnimations> {
    let mut current = animations;
    let Some(existing) = current.clone() else {
        return None;
    };
    let Some(data) = existing.get(&property_path) else {
        return current;
    };

    for (component_key, channel) in channel_entries(data) {
        let stripped = match channel {
            AnimationChannel::Scalar { keys, extrapolation } => {
                let keys: Vec<ScalarAnimationKey> =
                    keys.into_iter().filter(|key| key.id != keyframe_id).collect();
                (!keys.is_empty()).then(|| AnimationChannel::Scalar { keys, extrapolation })
            }
            AnimationChannel::Discrete { keys } => {
                let keys: Vec<DiscreteAnimationKey> =
                    keys.into_iter().filter(|key| key.id != keyframe_id).collect();
                (!keys.is_empty()).then(|| AnimationChannel::Discrete { keys })
            }
        };
        current = set_binding_component_channel(
            current,
            &property_path,
            &component_key,
            stripped,
        );
    }
    current
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RetimeKeyframeOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    pub keyframe_id: String,
    pub time: MediaTime,
}

/// Move a key to a new time, in every component of the property.
fn retime_element_keyframe_inner(
    RetimeKeyframeOptions {
        animations,
        property_path,
        keyframe_id,
        time,
    }: RetimeKeyframeOptions,
) -> Option<ElementAnimations> {
    let mut current = animations;
    let Some(existing) = current.clone() else {
        return None;
    };
    let Some(data) = existing.get(&property_path) else {
        return current;
    };

    for (component_key, channel) in channel_entries(data) {
        let moved = match channel {
            AnimationChannel::Scalar { keys, extrapolation } => {
                let keys: Vec<ScalarAnimationKey> = keys
                    .into_iter()
                    .map(|key| {
                        if key.id == keyframe_id {
                            ScalarAnimationKey { time, ..key }
                        } else {
                            key
                        }
                    })
                    .collect();
                Some(AnimationChannel::Scalar { keys, extrapolation })
            }
            AnimationChannel::Discrete { keys } => {
                let keys: Vec<DiscreteAnimationKey> = keys
                    .into_iter()
                    .map(|key| {
                        if key.id == keyframe_id {
                            DiscreteAnimationKey { time, ..key }
                        } else {
                            key
                        }
                    })
                    .collect();
                Some(AnimationChannel::Discrete { keys })
            }
        };
        current =
            set_binding_component_channel(current, &property_path, &component_key, moved);
    }
    current
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScalarCurveKeyframePatch {
    /// `Some(None)` clears the handle; `None` leaves it alone.
    #[serde(default, with = "double_option")]
    pub left_handle: Option<Option<CurveHandle>>,
    #[serde(default, with = "double_option")]
    pub right_handle: Option<Option<CurveHandle>>,
    #[serde(default)]
    pub segment_to_next: Option<ScalarSegmentType>,
    #[serde(default)]
    pub tangent_mode: Option<TangentMode>,
}

/// `null` and absent mean different things in this patch — one clears a handle,
/// the other leaves it untouched — and serde collapses both to `None` without
/// this.
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCurveOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    pub component_key: String,
    pub keyframe_id: String,
    pub patch: ScalarCurveKeyframePatch,
}

/// Change one key's handles or segment type.
fn update_scalar_keyframe_curve_inner(
    UpdateCurveOptions {
        animations,
        property_path,
        component_key,
        keyframe_id,
        patch,
    }: UpdateCurveOptions,
) -> Option<ElementAnimations> {
    let data = animations.as_ref().and_then(|map| map.get(&property_path));
    let Some(AnimationChannel::Scalar { keys, extrapolation }) =
        channel_from_data(data, &component_key)
    else {
        return animations;
    };
    if !keys.iter().any(|key| key.id == keyframe_id) {
        return animations;
    }

    let keys: Vec<ScalarAnimationKey> = keys
        .into_iter()
        .map(|key| {
            if key.id != keyframe_id {
                return key;
            }
            ScalarAnimationKey {
                left_handle: patch.left_handle.unwrap_or(key.left_handle),
                right_handle: patch.right_handle.unwrap_or(key.right_handle),
                segment_to_next: patch.segment_to_next.unwrap_or(key.segment_to_next),
                tangent_mode: patch.tangent_mode.unwrap_or(key.tangent_mode),
                ..key
            }
        })
        .collect();

    set_binding_component_channel(
        animations,
        &property_path,
        &component_key,
        Some(AnimationChannel::Scalar { keys, extrapolation }),
    )
}

// The exported surface. These exist only to name the return shape; the logic is
// in the `*_inner` functions above, which keep the plain `Option` that reads
// better inside Rust.

#[export]
pub fn clamp_animations_to_duration(options: ClampAnimationsOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: clamp_animations_to_duration_inner(options),
    }
}

#[export]
pub fn clone_animations(options: CloneAnimationsOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: clone_animations_inner(options),
    }
}

#[export]
pub fn set_channel(options: SetChannelOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: set_channel_inner(options),
    }
}

#[export]
pub fn remove_element_keyframe(options: KeyframeRefOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: remove_element_keyframe_inner(options),
    }
}

#[export]
pub fn retime_element_keyframe(options: RetimeKeyframeOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: retime_element_keyframe_inner(options),
    }
}

#[export]
pub fn update_scalar_keyframe_curve(options: UpdateCurveOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: update_scalar_keyframe_curve_inner(options),
    }
}

// --- Upserting a key -------------------------------------------------------

fn scalar_segment_for(interpolation: AnimationInterpolation) -> ScalarSegmentType {
    scalar_segment_type(interpolation)
}

/// Which interpolation a component should use. A discrete component can only
/// hold; a scalar one takes what the caller asked for, or its own default.
fn interpolation_for_component(
    component: &crate::params::ChannelComponentDefinition,
    requested: Option<AnimationInterpolation>,
) -> AnimationInterpolation {
    use crate::params::{ChannelValueKind, DefaultInterpolation};
    if component.value_kind == ChannelValueKind::Discrete {
        return AnimationInterpolation::Hold;
    }
    requested.unwrap_or(match component.default_interpolation {
        DefaultInterpolation::Linear => AnimationInterpolation::Linear,
        DefaultInterpolation::Hold => AnimationInterpolation::Hold,
    })
}

struct TargetKey {
    id: String,
    time: MediaTime,
}

/// Which key an upsert lands on.
///
/// An explicit id wins, so dragging a key keeps its identity even as its time
/// changes. Failing that, a key already at this exact time is *edited* rather
/// than joined by a second one — two keys sharing a time is legal but is never
/// what a click means. Otherwise a new id is minted.
fn target_key(
    channel: Option<&AnimationChannel>,
    time: MediaTime,
    keyframe_id: Option<&str>,
    minter: &mut IdMinter,
) -> TargetKey {
    let normalized = channel.cloned().map(normalized);
    let times: Vec<(String, i64)> = match &normalized {
        Some(AnimationChannel::Scalar { keys, .. }) => keys
            .iter()
            .map(|key| (key.id.clone(), key.time.as_ticks()))
            .collect(),
        Some(AnimationChannel::Discrete { keys }) => keys
            .iter()
            .map(|key| (key.id.clone(), key.time.as_ticks()))
            .collect(),
        None => vec![],
    };

    if let Some(wanted) = keyframe_id {
        if let Some((id, _)) = times.iter().find(|(id, _)| id == wanted) {
            return TargetKey {
                id: id.clone(),
                time,
            };
        }
    }

    if let Some((id, at)) = times.iter().find(|(_, at)| *at == time.as_ticks()) {
        return TargetKey {
            id: id.clone(),
            time: MediaTime::from_ticks(*at),
        };
    }

    TargetKey {
        id: keyframe_id.map(str::to_string).unwrap_or_else(|| minter.mint()),
        time,
    }
}

fn upsert_discrete_key(
    channel: Option<&AnimationChannel>,
    time: MediaTime,
    value: DiscreteValue,
    keyframe_id: &str,
) -> AnimationChannel {
    let mut keys: Vec<DiscreteAnimationKey> = match channel {
        Some(AnimationChannel::Discrete { keys }) => normalize_discrete_keys(keys),
        _ => vec![],
    };

    if let Some(existing) = keys.iter_mut().find(|key| key.id == keyframe_id) {
        existing.time = time;
        existing.value = value;
    } else if let Some(existing) = keys
        .iter_mut()
        .find(|key| key.time.as_ticks() == time.as_ticks())
    {
        // Edit the key that is already here rather than stacking another on it.
        existing.value = value;
    } else {
        keys.push(DiscreteAnimationKey {
            id: keyframe_id.to_string(),
            time,
            value,
        });
    }

    normalized(AnimationChannel::Discrete { keys })
}

fn upsert_scalar_key(
    channel: Option<&AnimationChannel>,
    time: MediaTime,
    value: f64,
    interpolation: Option<AnimationInterpolation>,
    default_interpolation: Option<AnimationInterpolation>,
    keyframe_id: &str,
) -> AnimationChannel {
    let (mut keys, extrapolation) = match channel {
        Some(AnimationChannel::Scalar { keys, extrapolation }) => {
            (normalize_scalar_keys(keys), *extrapolation)
        }
        _ => (vec![], None),
    };

    // Editing an existing key keeps its handles and tangent mode; only an
    // explicitly requested interpolation replaces its outgoing segment.
    let apply = |key: &mut ScalarAnimationKey| {
        key.value = value;
        if let Some(interpolation) = interpolation {
            key.segment_to_next = scalar_segment_for(interpolation);
        }
    };

    if let Some(index) = keys.iter().position(|key| key.id == keyframe_id) {
        keys[index].time = time;
        let mut key = keys[index].clone();
        apply(&mut key);
        keys[index] = key;
    } else if let Some(index) = keys
        .iter()
        .position(|key| key.time.as_ticks() == time.as_ticks())
    {
        let mut key = keys[index].clone();
        apply(&mut key);
        keys[index] = key;
    } else {
        keys.push(create_scalar_key(
            keyframe_id.to_string(),
            time,
            value,
            interpolation
                .or(default_interpolation)
                .unwrap_or(AnimationInterpolation::Linear),
            None,
        ));
    }

    normalized(AnimationChannel::Scalar { keys, extrapolation })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpsertKeyframeOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub property_path: String,
    pub time: MediaTime,
    pub value: ParamValue,
    #[serde(default)]
    pub interpolation: Option<AnimationInterpolation>,
    #[serde(default)]
    pub keyframe_id: Option<String>,
    /// The parameter itself, rather than a channel layout: the layout, the
    /// coercion and the decomposition all follow from it, and none of them can
    /// cross a boundary as a closure.
    pub param: crate::params::ParamDefinition,
    pub id_seed: String,
}

/// Set the value of one property at one time, creating the key if there is not
/// one there already.
///
/// A composite value — a colour — writes one key per component, all sharing the
/// same id and time, which is what keeps the components in step.
fn upsert_path_keyframe_inner(
    UpsertKeyframeOptions {
        animations,
        property_path,
        time,
        value,
        interpolation,
        keyframe_id,
        param,
        id_seed,
    }: UpsertKeyframeOptions,
) -> Option<ElementAnimations> {
    use crate::params::{ChannelValueKind, ParamChannelLayout};

    let Some(coerced) = param.coerce(&value) else {
        return animations;
    };
    let Some(components) = param.decompose(&coerced) else {
        return animations;
    };

    let layout = param.channel_layout();
    let component_list = match &layout {
        ParamChannelLayout::Leaf { component, .. } => vec![component.clone()],
        ParamChannelLayout::Composite { components, .. } => components.clone(),
    };
    let primary_key = component_list
        .first()
        .map(|component| component.key.clone())
        .unwrap_or_else(|| "value".to_string());

    let mut minter = IdMinter::new(id_seed);
    let current = animations.clone().unwrap_or_default();
    let current_data = current.get(&property_path).cloned();
    let target = target_key(
        channel_from_data(current_data.as_ref(), &primary_key).as_ref(),
        time,
        keyframe_id.as_deref(),
        &mut minter,
    );

    let mut next_data = current_data.clone();
    for component in component_list {
        let Some(next_value) = components.get(&component.key) else {
            continue;
        };
        let existing = channel_from_data(current_data.as_ref(), &component.key);

        let next_channel = if component.value_kind == ChannelValueKind::Discrete {
            let discrete = match next_value {
                ParamValue::Bool(value) => DiscreteValue::Bool(*value),
                ParamValue::Text(value) => DiscreteValue::Text(value.clone()),
                // A number cannot go on a held channel.
                ParamValue::Number(_) => continue,
            };
            upsert_discrete_key(existing.as_ref(), target.time, discrete, &target.id)
        } else {
            let ParamValue::Number(number) = next_value else {
                continue;
            };
            upsert_scalar_key(
                existing.as_ref(),
                target.time,
                *number,
                interpolation.map(|requested| {
                    interpolation_for_component(&component, Some(requested))
                }),
                Some(interpolation_for_component(&component, None)),
                &target.id,
            )
        };

        next_data = set_channel_in_data(
            next_data.as_ref(),
            &component.key,
            Some(next_channel),
        );
    }

    let mut next = current;
    match next_data {
        Some(data) => {
            next.insert(property_path, data);
        }
        None => {
            next.remove(&property_path);
        }
    }
    to_animation(next)
}

#[export]
pub fn upsert_path_keyframe(options: UpsertKeyframeOptions) -> MaybeAnimations {
    MaybeAnimations {
        animations: upsert_path_keyframe_inner(options),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(time: i64, value: f64, segment: ScalarSegmentType) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: format!("k{time}"),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: segment,
            tangent_mode: TangentMode::Flat,
        }
    }

    fn scalar_animations(keys: Vec<ScalarAnimationKey>) -> ElementAnimations {
        HashMap::from([(
            "opacity".to_string(),
            ChannelData::Channel(AnimationChannel::Scalar {
                keys,
                extrapolation: None,
            }),
        )])
    }

    fn scalar_keys(animations: &ElementAnimations, path: &str) -> Vec<ScalarAnimationKey> {
        match animations.get(path).expect("the property is animated") {
            ChannelData::Channel(AnimationChannel::Scalar { keys, .. }) => keys.clone(),
            other => panic!("expected a scalar channel, got {other:?}"),
        }
    }

fn number_param() -> crate::params::ParamDefinition {
        crate::params::ParamDefinition::Number {
            key: "opacity".to_string(),
            label: "Opacity".to_string(),
            default: 1.0,
            min: 0.0,
            max: Some(1.0),
            step: 0.01,
            keyframable: Some(true),
            group: None,
            dependencies: Vec::new(),
            display_multiplier: None,
            unit: None,
            suffix: None,
            short_label: None,
            control: None,
            track_gradient: None,
        }
    }

    fn color_param() -> crate::params::ParamDefinition {
        crate::params::ParamDefinition::Color {
            key: "color".to_string(),
            label: "Color".to_string(),
            default: "#000000".to_string(),
            keyframable: Some(true),
            group: None,
            dependencies: Vec::new(),
            control: None,
        }
    }

    fn upsert(
        animations: Option<ElementAnimations>,
        path: &str,
        time: i64,
        value: ParamValue,
        param: crate::params::ParamDefinition,
        keyframe_id: Option<&str>,
    ) -> Option<ElementAnimations> {
        upsert_path_keyframe_inner(UpsertKeyframeOptions {
            animations,
            property_path: path.to_string(),
            time: MediaTime::from_ticks(time),
            value,
            interpolation: None,
            keyframe_id: keyframe_id.map(str::to_string),
            param,
            id_seed: "seed".to_string(),
        })
    }

    #[test]
    fn upserting_creates_the_channel_and_the_key() {
        let animations = upsert(
            None,
            "opacity",
            500,
            ParamValue::Number(0.5),
            number_param(),
            None,
        )
        .expect("now animated");
        let keys = scalar_keys(&animations, "opacity");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].time.as_ticks(), 500);
        assert_eq!(keys[0].value, 0.5);
    }

    #[test]
    fn upserting_at_a_time_that_already_has_a_key_edits_it() {
        // Two keys sharing a time is legal but is never what a click means.
        let first = upsert(None, "opacity", 500, ParamValue::Number(0.5), number_param(), None);
        let second = upsert(first, "opacity", 500, ParamValue::Number(0.25), number_param(), None)
            .expect("still animated");
        let keys = scalar_keys(&second, "opacity");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].value, 0.25);
    }

    #[test]
    fn a_value_the_param_refuses_leaves_the_animations_untouched() {
        // The param is a number; a string is not coercible to one.
        let before = upsert(None, "opacity", 0, ParamValue::Number(1.0), number_param(), None);
        let after = upsert(
            before.clone(),
            "opacity",
            500,
            ParamValue::Text("nope".to_string()),
            number_param(),
            None,
        );
        assert_eq!(after, before);
    }

    #[test]
    fn the_value_is_coerced_before_it_is_stored() {
        // Step 0.01 and a maximum of 1, so 1.004 snaps to 1 rather than storing
        // a value the slider could never produce.
        let animations = upsert(
            None,
            "opacity",
            0,
            ParamValue::Number(1.004),
            number_param(),
            None,
        )
        .expect("animated");
        assert_eq!(scalar_keys(&animations, "opacity")[0].value, 1.0);
    }

    #[test]
    fn a_colour_writes_one_key_per_component_sharing_an_id_and_time() {
        let animations = upsert(
            None,
            "color",
            300,
            ParamValue::Text("#3366cc".to_string()),
            color_param(),
            None,
        )
        .expect("animated");

        let ChannelData::Composite(components) = &animations["color"] else {
            panic!("a colour is composite")
        };
        assert_eq!(components.len(), 4);
        let ids: Vec<String> = components
            .values()
            .map(|channel| match channel {
                AnimationChannel::Scalar { keys, .. } => keys[0].id.clone(),
                _ => panic!("scalar"),
            })
            .collect();
        // One id and one time across all four, which is what keeps them in step.
        assert!(ids.windows(2).all(|pair| pair[0] == pair[1]), "{ids:?}");
        for channel in components.values() {
            let AnimationChannel::Scalar { keys, .. } = channel else {
                panic!("scalar")
            };
            assert_eq!(keys[0].time.as_ticks(), 300);
        }
    }

    #[test]
    fn a_colour_that_will_not_parse_changes_nothing() {
        let after = upsert(
            None,
            "color",
            0,
            ParamValue::Text("hsl(var(--background))".to_string()),
            color_param(),
            None,
        );
        assert!(after.is_none());
    }

    #[test]
    fn an_explicit_keyframe_id_moves_that_key_rather_than_adding_one() {
        let first = upsert(None, "opacity", 0, ParamValue::Number(0.2), number_param(), None)
            .expect("animated");
        let id = scalar_keys(&first, "opacity")[0].id.clone();
        let moved = upsert(
            Some(first),
            "opacity",
            900,
            ParamValue::Number(0.8),
            number_param(),
            Some(&id),
        )
        .expect("animated");
        let keys = scalar_keys(&moved, "opacity");
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].id, id);
        assert_eq!(keys[0].time.as_ticks(), 900);
        assert_eq!(keys[0].value, 0.8);
    }

    #[test]
    fn a_boolean_param_gets_a_held_channel_not_an_interpolated_one() {
        let animations = upsert(
            None,
            "hidden",
            0,
            ParamValue::Bool(true),
            crate::params::ParamDefinition::Boolean {
                key: "hidden".to_string(),
                label: "Hidden".to_string(),
                default: false,
                keyframable: Some(true),
                group: None,
                dependencies: Vec::new(),
            },
            None,
        )
        .expect("animated");
        assert!(matches!(
            animations["hidden"],
            ChannelData::Channel(AnimationChannel::Discrete { .. })
        ));
    }

    #[test]
    fn splitting_gives_both_halves_a_key_on_the_boundary() {
        let split = split_animations_at_time(SplitAnimationsOptions {
            animations: Some(scalar_animations(vec![
                key(0, 0.0, ScalarSegmentType::Linear),
                key(1000, 10.0, ScalarSegmentType::Linear),
            ])),
            split_time: MediaTime::from_ticks(400),
            should_include_split_boundary: true,
            id_seed: "seed".to_string(),
        });

        let left = scalar_keys(&split.left_animations.expect("left half"), "opacity");
        let right = scalar_keys(&split.right_animations.expect("right half"), "opacity");

        // The boundary value is the curve's value there — 40% of the way from 0
        // to 10 — and each half is rebased so its own time starts at zero.
        assert_eq!(left.last().unwrap().time.as_ticks(), 400);
        assert!((left.last().unwrap().value - 4.0).abs() < 1e-9);
        assert_eq!(right.first().unwrap().time.as_ticks(), 0);
        assert!((right.first().unwrap().value - 4.0).abs() < 1e-9);
        assert_eq!(right.last().unwrap().time.as_ticks(), 600);
    }

    #[test]
    fn splitting_without_a_boundary_just_divides_the_keys() {
        let split = split_animations_at_time(SplitAnimationsOptions {
            animations: Some(scalar_animations(vec![
                key(0, 0.0, ScalarSegmentType::Linear),
                key(1000, 10.0, ScalarSegmentType::Linear),
            ])),
            split_time: MediaTime::from_ticks(400),
            should_include_split_boundary: false,
            id_seed: "seed".to_string(),
        });
        assert_eq!(
            scalar_keys(&split.left_animations.unwrap(), "opacity").len(),
            1
        );
        assert_eq!(
            scalar_keys(&split.right_animations.unwrap(), "opacity").len(),
            1
        );
    }

    #[test]
    fn cutting_a_bezier_segment_keeps_each_half_curved() {
        let mut left_key = key(0, 0.0, ScalarSegmentType::Bezier);
        left_key.right_handle = Some(CurveHandle { dt: 300.0, dv: 8.0 });
        let mut right_key = key(1000, 10.0, ScalarSegmentType::Bezier);
        right_key.left_handle = Some(CurveHandle { dt: -300.0, dv: -2.0 });

        let split = split_animations_at_time(SplitAnimationsOptions {
            animations: Some(scalar_animations(vec![left_key, right_key])),
            split_time: MediaTime::from_ticks(500),
            should_include_split_boundary: true,
            id_seed: "seed".to_string(),
        });

        let left = scalar_keys(&split.left_animations.expect("left"), "opacity");
        let right = scalar_keys(&split.right_animations.expect("right"), "opacity");

        // De Casteljau hands each half its own control points, so both boundary
        // keys carry a handle rather than falling back to a straight ramp.
        assert!(left.last().unwrap().left_handle.is_some());
        assert!(right.first().unwrap().right_handle.is_some());
        assert_eq!(right.first().unwrap().segment_to_next, ScalarSegmentType::Bezier);
        // Both halves agree on the value at the cut.
        let cut_value = left.last().unwrap().value;
        assert!((cut_value - right.first().unwrap().value).abs() < 1e-9);
    }

    #[test]
    fn clamping_drops_everything_past_the_duration() {
        let clamped = clamp_animations_to_duration_inner(ClampAnimationsOptions {
            animations: Some(scalar_animations(vec![
                key(0, 0.0, ScalarSegmentType::Linear),
                key(500, 5.0, ScalarSegmentType::Linear),
                key(2000, 20.0, ScalarSegmentType::Linear),
            ])),
            duration: MediaTime::from_ticks(1000),
            id_seed: "seed".to_string(),
        })
        .expect("still animated");

        let keys = scalar_keys(&clamped, "opacity");
        assert!(keys.iter().all(|key| key.time.as_ticks() <= 1000));
        assert_eq!(keys.last().unwrap().time.as_ticks(), 1000);
    }

    #[test]
    fn a_zero_length_element_keeps_no_animation() {
        assert!(
            clamp_animations_to_duration_inner(ClampAnimationsOptions {
                animations: Some(scalar_animations(vec![key(
                    0,
                    1.0,
                    ScalarSegmentType::Linear
                )])),
                duration: MediaTime::ZERO,
                id_seed: "seed".to_string(),
            })
            .is_none()
        );
    }

    #[test]
    fn cloning_keeps_ids_unless_asked_to_replace_them() {
        let animations = scalar_animations(vec![
            key(0, 0.0, ScalarSegmentType::Linear),
            key(500, 5.0, ScalarSegmentType::Linear),
        ]);

        let same = clone_animations_inner(CloneAnimationsOptions {
            animations: Some(animations.clone()),
            should_regenerate_keyframe_ids: false,
            id_seed: "seed".to_string(),
        })
        .expect("cloned");
        assert_eq!(
            scalar_keys(&same, "opacity")
                .iter()
                .map(|key| key.id.clone())
                .collect::<Vec<_>>(),
            vec!["k0".to_string(), "k500".to_string()]
        );

        let fresh = clone_animations_inner(CloneAnimationsOptions {
            animations: Some(animations),
            should_regenerate_keyframe_ids: true,
            id_seed: "seed".to_string(),
        })
        .expect("cloned");
        let ids: Vec<String> = scalar_keys(&fresh, "opacity")
            .iter()
            .map(|key| key.id.clone())
            .collect();
        assert_eq!(ids, vec!["seed-0".to_string(), "seed-1".to_string()]);
    }

    #[test]
    fn a_colour_keeps_its_components_pointing_at_the_same_keyframe() {
        // The id map comes from the first channel and is applied to all of them,
        // so r/g/b/a do not drift apart when ids are regenerated.
        let component = |value: f64| {
            AnimationChannel::Scalar {
                keys: vec![key(0, value, ScalarSegmentType::Linear)],
                extrapolation: None,
            }
        };
        let animations: ElementAnimations = HashMap::from([(
            "color".to_string(),
            ChannelData::Composite(HashMap::from([
                ("r".to_string(), component(0.5)),
                ("g".to_string(), component(0.25)),
            ])),
        )]);

        let cloned = clone_animations_inner(CloneAnimationsOptions {
            animations: Some(animations),
            should_regenerate_keyframe_ids: true,
            id_seed: "seed".to_string(),
        })
        .expect("cloned");

        let ChannelData::Composite(components) = &cloned["color"] else {
            panic!("still composite");
        };
        let ids: Vec<&str> = components
            .values()
            .map(|channel| match channel {
                AnimationChannel::Scalar { keys, .. } => keys[0].id.as_str(),
                _ => panic!("scalar"),
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1], "components disagreed about the key id");
    }

    #[test]
    fn removing_the_only_key_removes_the_property() {
        let removed = remove_element_keyframe_inner(KeyframeRefOptions {
            animations: Some(scalar_animations(vec![key(
                0,
                1.0,
                ScalarSegmentType::Linear,
            )])),
            property_path: "opacity".to_string(),
            keyframe_id: "k0".to_string(),
        });
        assert!(removed.is_none(), "an empty channel is not kept");
    }

    #[test]
    fn removing_an_unknown_key_changes_nothing() {
        let animations = scalar_animations(vec![key(0, 1.0, ScalarSegmentType::Linear)]);
        let removed = remove_element_keyframe_inner(KeyframeRefOptions {
            animations: Some(animations.clone()),
            property_path: "opacity".to_string(),
            keyframe_id: "not-here".to_string(),
        })
        .expect("still animated");
        assert_eq!(scalar_keys(&removed, "opacity").len(), 1);
    }

    #[test]
    fn retiming_moves_the_key_and_reorders_the_channel() {
        let retimed = retime_element_keyframe_inner(RetimeKeyframeOptions {
            animations: Some(scalar_animations(vec![
                key(0, 0.0, ScalarSegmentType::Linear),
                key(500, 5.0, ScalarSegmentType::Linear),
            ])),
            property_path: "opacity".to_string(),
            keyframe_id: "k500".to_string(),
            time: MediaTime::from_ticks(-200),
        })
        .expect("still animated");

        let keys = scalar_keys(&retimed, "opacity");
        // Normalising re-sorts, so the moved key is now first.
        assert_eq!(keys[0].id, "k500");
        assert_eq!(keys[0].time.as_ticks(), -200);
    }

    #[test]
    fn setting_a_channel_to_nothing_clears_the_property() {
        assert!(
            set_channel_inner(SetChannelOptions {
                animations: Some(scalar_animations(vec![key(
                    0,
                    1.0,
                    ScalarSegmentType::Linear
                )])),
                property_path: "opacity".to_string(),
                channel: None,
            })
            .is_none()
        );
    }

    #[test]
    fn a_curve_patch_distinguishes_clearing_from_leaving_alone() {
        let mut keyed = key(0, 0.0, ScalarSegmentType::Bezier);
        keyed.right_handle = Some(CurveHandle { dt: 100.0, dv: 2.0 });
        let animations = scalar_animations(vec![keyed, key(500, 5.0, ScalarSegmentType::Linear)]);

        // Absent leaves the handle where it was...
        let untouched = update_scalar_keyframe_curve_inner(UpdateCurveOptions {
            animations: Some(animations.clone()),
            property_path: "opacity".to_string(),
            component_key: "value".to_string(),
            keyframe_id: "k0".to_string(),
            patch: ScalarCurveKeyframePatch {
                segment_to_next: Some(ScalarSegmentType::Step),
                ..Default::default()
            },
        })
        .expect("still animated");
        let keys = scalar_keys(&untouched, "opacity");
        assert!(keys[0].right_handle.is_some());
        assert_eq!(keys[0].segment_to_next, ScalarSegmentType::Step);

        // ...and an explicit `None` clears it.
        let cleared = update_scalar_keyframe_curve_inner(UpdateCurveOptions {
            animations: Some(animations),
            property_path: "opacity".to_string(),
            component_key: "value".to_string(),
            keyframe_id: "k0".to_string(),
            patch: ScalarCurveKeyframePatch {
                right_handle: Some(None),
                ..Default::default()
            },
        })
        .expect("still animated");
        assert!(scalar_keys(&cleared, "opacity")[0].right_handle.is_none());
    }

    #[test]
    fn legacy_storage_keys_are_not_carried_forward() {
        let mut animations = scalar_animations(vec![key(0, 1.0, ScalarSegmentType::Linear)]);
        animations.insert(
            "channels".to_string(),
            ChannelData::Channel(AnimationChannel::Scalar {
                keys: vec![key(0, 9.0, ScalarSegmentType::Linear)],
                extrapolation: None,
            }),
        );

        let cloned = clone_animations_inner(CloneAnimationsOptions {
            animations: Some(animations),
            should_regenerate_keyframe_ids: false,
            id_seed: "seed".to_string(),
        })
        .expect("cloned");
        assert!(cloned.contains_key("opacity"));
        assert!(!cloned.contains_key("channels"), "legacy key survived");
    }
}
