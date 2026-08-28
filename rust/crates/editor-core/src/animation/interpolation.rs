//! Reading a channel's value at a time.
//!
//! Normalisation is not cached here. The TypeScript memoised it on the channel
//! object because rebuilding one in JS meant three array allocations and two
//! objects per key on every single read; in Rust the same work is a couple of
//! `Vec`s and no garbage collector, so a call normalises and discards.

use bridge::export;
use serde::Deserialize;

use crate::model::{
    AnimationChannel, ChannelExtrapolation, ChannelExtrapolationMode, DiscreteAnimationKey,
    DiscreteValue, ParamValue,
};

use super::bezier::{
    BezierPointOptions, CurveHandle, DefaultHandleOptions, ScalarAnimationKey, ScalarSegmentType,
    SolveBezierProgressOptions, bezier_point, default_left_handle, default_right_handle,
    solve_bezier_progress_for_time,
};

/// A handle may not reach past the key it points at, nor turn back on itself.
/// The one-tick floor on the span keeps two keys sharing a time from producing a
/// zero-width clamp window.
fn normalize_right_handle(
    handle: Option<CurveHandle>,
    left: &ScalarAnimationKey,
    right: &ScalarAnimationKey,
) -> Option<CurveHandle> {
    let handle = handle?;
    let span = ((right.time.as_ticks() - left.time.as_ticks()) as f64).max(1.0);
    Some(CurveHandle {
        dt: handle.dt.max(0.0).min(span),
        dv: handle.dv,
    })
}

fn normalize_left_handle(
    handle: Option<CurveHandle>,
    left: &ScalarAnimationKey,
    right: &ScalarAnimationKey,
) -> Option<CurveHandle> {
    let handle = handle?;
    let span = ((right.time.as_ticks() - left.time.as_ticks()) as f64).max(1.0);
    Some(CurveHandle {
        dt: handle.dt.min(0.0).max(-span),
        dv: handle.dv,
    })
}

/// Sorts the keys and derives each handle's geometry from its neighbours.
pub fn normalize_scalar_keys(keys: &[ScalarAnimationKey]) -> Vec<ScalarAnimationKey> {
    let mut sorted = keys.to_vec();
    // Stable, like `Array.prototype.sort`: keys sharing a time keep their order,
    // which the bisection below relies on.
    sorted.sort_by(|a, b| a.time.as_ticks().cmp(&b.time.as_ticks()));

    (0..sorted.len())
        .map(|index| {
            let key = sorted[index].clone();
            let left_handle = index
                .checked_sub(1)
                .and_then(|previous| sorted.get(previous))
                .and_then(|previous| normalize_left_handle(key.left_handle, previous, &key));
            let right_handle = sorted
                .get(index + 1)
                .and_then(|next| normalize_right_handle(key.right_handle, &key, next));
            ScalarAnimationKey {
                left_handle,
                right_handle,
                ..key
            }
        })
        .collect()
}

pub(super) fn normalize_discrete_keys(
    keys: &[DiscreteAnimationKey],
) -> Vec<DiscreteAnimationKey> {
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| a.time.as_ticks().cmp(&b.time.as_ticks()));
    sorted
}

fn extrapolate_scalar_edge(
    mode: ChannelExtrapolationMode,
    edge: &ScalarAnimationKey,
    neighbour: Option<&ScalarAnimationKey>,
    time: f64,
) -> f64 {
    let (ChannelExtrapolationMode::Linear, Some(neighbour)) = (mode, neighbour) else {
        return edge.value;
    };

    let span = (neighbour.time.as_ticks() - edge.time.as_ticks()) as f64;
    if span == 0.0 {
        return edge.value;
    }

    edge.value + ((time - edge.time.as_ticks() as f64) / span) * (neighbour.value - edge.value)
}

fn scalar_value_at_time(
    keys: &[ScalarAnimationKey],
    extrapolation: Option<ChannelExtrapolation>,
    time: f64,
    fallback: f64,
) -> f64 {
    let keys = normalize_scalar_keys(keys);
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return fallback;
    };

    let first_time = first.time.as_ticks() as f64;
    let last_time = last.time.as_ticks() as f64;

    if time <= first_time {
        if time < first_time {
            return extrapolate_scalar_edge(
                extrapolation.map_or(ChannelExtrapolationMode::Hold, |edges| edges.before),
                first,
                keys.get(1),
                time,
            );
        }
        return first.value;
    }

    if time >= last_time {
        if time > last_time {
            return extrapolate_scalar_edge(
                extrapolation.map_or(ChannelExtrapolationMode::Hold, |edges| edges.after),
                last,
                keys.len().checked_sub(2).and_then(|index| keys.get(index)),
                time,
            );
        }
        return last.value;
    }

    // The keys are sorted and the edges above have established that `time` falls
    // strictly inside their span, so the bracketing pair is found by bisection
    // rather than by walking. The loop keeps `keys[low].time < time <=
    // keys[high].time` and narrows until the two are adjacent, which leaves
    // `high` at the *lowest* index whose time reaches `time`. That matters when
    // two keys share a time: landing on the first of them is what the walk this
    // replaced did.
    let mut low = 0usize;
    let mut high = keys.len() - 1;
    while high - low > 1 {
        let mid = (low + high) / 2;
        if (keys[mid].time.as_ticks() as f64) < time {
            low = mid;
        } else {
            high = mid;
        }
    }

    let left = &keys[low];
    let right = &keys[high];
    if time == right.time.as_ticks() as f64 {
        return right.value;
    }
    if left.segment_to_next == ScalarSegmentType::Step {
        return left.value;
    }

    let span = (right.time.as_ticks() - left.time.as_ticks()) as f64;
    if span == 0.0 {
        return right.value;
    }

    if left.segment_to_next == ScalarSegmentType::Linear {
        let progress = ((time - left.time.as_ticks() as f64) / span).max(0.0).min(1.0);
        return left.value + (right.value - left.value) * progress;
    }

    let right_handle = left.right_handle.unwrap_or_else(|| {
        default_right_handle(DefaultHandleOptions {
            left_key: left.clone(),
            right_key: right.clone(),
        })
    });
    let left_handle = right.left_handle.unwrap_or_else(|| {
        default_left_handle(DefaultHandleOptions {
            left_key: left.clone(),
            right_key: right.clone(),
        })
    });

    bezier_point(BezierPointOptions {
        progress: solve_bezier_progress_for_time(SolveBezierProgressOptions {
            time,
            left_key: left.clone(),
            right_key: right.clone(),
        }),
        p0: left.value,
        p1: left.value + right_handle.dv,
        p2: right.value + left_handle.dv,
        p3: right.value,
    })
}

fn discrete_value_at_time(
    keys: &[DiscreteAnimationKey],
    time: f64,
    fallback: DiscreteValue,
) -> DiscreteValue {
    let keys = normalize_discrete_keys(keys);
    let mut current = fallback;
    for key in keys {
        if time < key.time.as_ticks() as f64 {
            break;
        }
        current = key.value;
    }
    current
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelValueAtTimeOptions {
    #[serde(default)]
    pub channel: Option<AnimationChannel>,
    pub time: f64,
    pub fallback_value: ParamValue,
}

/// The channel's value at `time`, or the fallback when there is nothing to read.
///
/// A scalar channel answers a numeric fallback and a discrete one answers a
/// boolean or string fallback; asked across that divide, the fallback comes back
/// untouched, which is what the TypeScript's overloads encode.
#[export]
pub fn get_channel_value_at_time(
    ChannelValueAtTimeOptions {
        channel,
        time,
        fallback_value,
    }: ChannelValueAtTimeOptions,
) -> ParamValue {
    let Some(channel) = channel else {
        return fallback_value;
    };
    if key_count(&channel) == 0 {
        return fallback_value;
    }

    match (&channel, &fallback_value) {
        (AnimationChannel::Scalar { keys, extrapolation }, ParamValue::Number(fallback)) => {
            ParamValue::Number(scalar_value_at_time(keys, *extrapolation, time, *fallback))
        }
        // A scalar channel cannot answer a discrete question, and vice versa.
        (AnimationChannel::Scalar { .. }, _) => fallback_value,
        (AnimationChannel::Discrete { .. }, ParamValue::Number(_)) => fallback_value,
        (AnimationChannel::Discrete { keys }, ParamValue::Bool(fallback)) => {
            match discrete_value_at_time(keys, time, DiscreteValue::Bool(*fallback)) {
                DiscreteValue::Bool(value) => ParamValue::Bool(value),
                DiscreteValue::Text(value) => ParamValue::Text(value),
            }
        }
        (AnimationChannel::Discrete { keys }, ParamValue::Text(fallback)) => {
            match discrete_value_at_time(keys, time, DiscreteValue::Text(fallback.clone())) {
                DiscreteValue::Bool(value) => ParamValue::Bool(value),
                DiscreteValue::Text(value) => ParamValue::Text(value),
            }
        }
    }
}

fn key_count(channel: &AnimationChannel) -> usize {
    match channel {
        AnimationChannel::Scalar { keys, .. } => keys.len(),
        AnimationChannel::Discrete { keys } => keys.len(),
    }
}

/// How a segment gets from one key to the next, in the vocabulary the keyframe
/// UI uses rather than the spline's.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(serde::Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnimationInterpolation {
    Linear,
    Hold,
    Bezier,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScalarSegmentInterpolationOptions {
    pub segment: ScalarSegmentType,
}

#[export]
pub fn get_scalar_segment_interpolation(
    ScalarSegmentInterpolationOptions { segment }: ScalarSegmentInterpolationOptions,
) -> AnimationInterpolation {
    match segment {
        ScalarSegmentType::Step => AnimationInterpolation::Hold,
        ScalarSegmentType::Bezier => AnimationInterpolation::Bezier,
        ScalarSegmentType::Linear => AnimationInterpolation::Linear,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOptions {
    pub channel: AnimationChannel,
}

/// Whether a channel's values are interpolated or merely held.
///
/// The TypeScript decided this structurally — a channel is scalar if it carries
/// `extrapolation` or any key carries `segmentToNext`. Here the untagged
/// `AnimationChannel` has already made that decision during deserialisation, on
/// the same evidence.
#[export]
pub fn is_scalar_channel(ChannelOptions { channel }: ChannelOptions) -> bool {
    matches!(channel, AnimationChannel::Scalar { .. })
}

/// Sorts the keys and rebuilds each one's handle geometry from its neighbours.
#[export]
pub fn normalize_channel(ChannelOptions { channel }: ChannelOptions) -> AnimationChannel {
    match channel {
        AnimationChannel::Scalar { keys, extrapolation } => AnimationChannel::Scalar {
            keys: normalize_scalar_keys(&keys),
            extrapolation,
        },
        AnimationChannel::Discrete { keys } => AnimationChannel::Discrete {
            keys: normalize_discrete_keys(&keys),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ChannelExtrapolationMode;
    use time::MediaTime;

    fn scalar_key(time: i64, value: f64, segment: ScalarSegmentType) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: format!("k{time}"),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: segment,
            tangent_mode: super::super::bezier::TangentMode::Flat,
        }
    }

    fn channel(keys: Vec<ScalarAnimationKey>) -> AnimationChannel {
        AnimationChannel::Scalar {
            keys,
            extrapolation: None,
        }
    }

    fn read(channel: AnimationChannel, time: f64, fallback: f64) -> f64 {
        match get_channel_value_at_time(ChannelValueAtTimeOptions {
            channel: Some(channel),
            time,
            fallback_value: ParamValue::Number(fallback),
        }) {
            ParamValue::Number(value) => value,
            other => panic!("expected a number, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_or_absent_channel_answers_with_the_fallback() {
        assert_eq!(read(channel(vec![]), 100.0, 7.5), 7.5);
        assert_eq!(
            get_channel_value_at_time(ChannelValueAtTimeOptions {
                channel: None,
                time: 100.0,
                fallback_value: ParamValue::Number(7.5),
            }),
            ParamValue::Number(7.5)
        );
    }

    #[test]
    fn a_linear_segment_reads_halfway_at_halfway() {
        let value = read(
            channel(vec![
                scalar_key(0, 0.0, ScalarSegmentType::Linear),
                scalar_key(1000, 10.0, ScalarSegmentType::Linear),
            ]),
            500.0,
            0.0,
        );
        assert!((value - 5.0).abs() < 1e-12, "got {value}");
    }

    #[test]
    fn a_step_segment_holds_the_left_key() {
        let value = read(
            channel(vec![
                scalar_key(0, 3.0, ScalarSegmentType::Step),
                scalar_key(1000, 10.0, ScalarSegmentType::Linear),
            ]),
            999.0,
            0.0,
        );
        assert_eq!(value, 3.0);
    }

    #[test]
    fn outside_the_span_it_holds_by_default_and_extends_when_told_to() {
        let keys = vec![
            scalar_key(100, 2.0, ScalarSegmentType::Linear),
            scalar_key(200, 4.0, ScalarSegmentType::Linear),
        ];
        // Default is hold, so before the first key the value is the first key's.
        assert_eq!(read(channel(keys.clone()), -500.0, 0.0), 2.0);

        let extended = AnimationChannel::Scalar {
            keys,
            extrapolation: Some(ChannelExtrapolation {
                before: ChannelExtrapolationMode::Linear,
                after: ChannelExtrapolationMode::Linear,
            }),
        };
        // Continuing the 2-per-100 slope backwards from (100, 2) reaches 0 at 0.
        let value = read(extended, 0.0, 0.0);
        assert!((value - 0.0).abs() < 1e-12, "got {value}");
    }

    #[test]
    fn two_keys_sharing_a_time_resolve_to_the_first_of_them() {
        // The bisection's tie-breaking: `high` lands on the lowest index whose
        // time reaches the target, which is what the walk it replaced did.
        let value = read(
            channel(vec![
                scalar_key(0, 0.0, ScalarSegmentType::Linear),
                scalar_key(500, 1.0, ScalarSegmentType::Linear),
                scalar_key(500, 99.0, ScalarSegmentType::Linear),
                scalar_key(1000, 100.0, ScalarSegmentType::Linear),
            ]),
            500.0,
            0.0,
        );
        assert_eq!(value, 1.0);
    }

    #[test]
    fn a_discrete_channel_holds_until_the_next_key() {
        let channel = AnimationChannel::Discrete {
            keys: vec![
                DiscreteAnimationKey {
                    id: "a".to_string(),
                    time: MediaTime::from_ticks(0),
                    value: DiscreteValue::Bool(false),
                },
                DiscreteAnimationKey {
                    id: "b".to_string(),
                    time: MediaTime::from_ticks(1000),
                    value: DiscreteValue::Bool(true),
                },
            ],
        };
        let at = |time| {
            get_channel_value_at_time(ChannelValueAtTimeOptions {
                channel: Some(channel.clone()),
                time,
                fallback_value: ParamValue::Bool(false),
            })
        };
        assert_eq!(at(999.0), ParamValue::Bool(false));
        assert_eq!(at(1000.0), ParamValue::Bool(true));
    }

    #[test]
    fn a_channel_cannot_answer_across_the_scalar_discrete_divide() {
        // Asked for a number, a discrete channel returns the fallback rather
        // than coercing a boolean into one.
        let discrete = AnimationChannel::Discrete {
            keys: vec![DiscreteAnimationKey {
                id: "a".to_string(),
                time: MediaTime::from_ticks(0),
                value: DiscreteValue::Bool(true),
            }],
        };
        assert_eq!(read(discrete, 500.0, 42.0), 42.0);
    }

    #[test]
    fn normalising_sorts_the_keys_and_clamps_the_handles() {
        let mut early = scalar_key(0, 0.0, ScalarSegmentType::Bezier);
        early.right_handle = Some(CurveHandle { dt: 9_999.0, dv: 1.0 });
        let late = scalar_key(300, 5.0, ScalarSegmentType::Bezier);

        let AnimationChannel::Scalar { keys, .. } = normalize_channel(ChannelOptions {
            channel: channel(vec![late.clone(), early]),
        }) else {
            panic!("still scalar");
        };

        assert_eq!(keys[0].time.as_ticks(), 0);
        assert_eq!(keys[1].time.as_ticks(), 300);
        // The handle may not reach past the key it points at.
        assert_eq!(keys[0].right_handle.unwrap().dt, 300.0);
    }

    #[test]
    fn segment_types_map_onto_the_ui_vocabulary() {
        let interpolation = |segment| {
            get_scalar_segment_interpolation(ScalarSegmentInterpolationOptions { segment })
        };
        assert_eq!(
            interpolation(ScalarSegmentType::Step),
            AnimationInterpolation::Hold
        );
        assert_eq!(
            interpolation(ScalarSegmentType::Linear),
            AnimationInterpolation::Linear
        );
        assert_eq!(
            interpolation(ScalarSegmentType::Bezier),
            AnimationInterpolation::Bezier
        );
    }
}
