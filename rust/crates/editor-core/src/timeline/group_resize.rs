//! Dragging the edge of one clip, or of several at once.
//!
//! A group resize is a single delta applied to every member, not a per-member
//! drag: the block keeps its shape. So the delta is first narrowed to what
//! *every* member allows — a member that has run out of source, or that would
//! collide with its neighbour, is what stops the whole gesture — and only then
//! turned into patches.

use serde::{Deserialize, Serialize};

use time::{FrameRate, MediaTime, TICKS_PER_SECOND};

use crate::model::RetimeConfig;
use crate::retime::{
    SourceSpanAtClipTimeOptions, TimelineDurationOptions, get_source_span_at_clip_time,
    get_timeline_duration_for_source_span,
};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResizeSide {
    Left,
    Right,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupResizeMember {
    pub track_id: String,
    pub element_id: String,
    pub start_time: MediaTime,
    pub duration: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    #[serde(default)]
    pub source_duration: Option<MediaTime>,
    #[serde(default)]
    pub retime: Option<RetimeConfig>,
    /// A held still. It shows one frame, so there is no source to run out of and
    /// no trim to walk — only the neighbours limit how far it can stretch.
    #[serde(default)]
    pub is_frozen: Option<bool>,
    /// Where the previous clip ends, or `None` when nothing is in the way.
    pub left_neighbor_bound: Option<MediaTime>,
    pub right_neighbor_bound: Option<MediaTime>,
}

impl GroupResizeMember {
    fn frozen(&self) -> bool {
        self.is_frozen.unwrap_or(false)
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupResizePatch {
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    pub start_time: MediaTime,
    pub duration: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupResizeUpdate {
    pub track_id: String,
    pub element_id: String,
    pub patch: GroupResizePatch,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupResizeResult {
    pub delta_time: MediaTime,
    pub updates: Vec<GroupResizeUpdate>,
}

/// The bounds can cross when stored data already breaks them — a clip whose
/// neighbour starts before the clip's own minimum length leaves no delta that
/// satisfies both. The JavaScript tested `min` first and then `max`, so the
/// ceiling wins for a positive drag — though the re-clamp after frame snapping
/// then answers the floor. `i64::clamp` would panic on crossed bounds, so the
/// comparison is written out rather than delegated.
fn clamp_between(time: MediaTime, min: MediaTime, max: MediaTime) -> MediaTime {
    if time < min {
        return min;
    }
    if time > max {
        return max;
    }
    time
}

fn round_media_time(ticks: f64) -> MediaTime {
    MediaTime::from_ticks(crate::math::js_round(ticks) as i64)
}

/// How much source a clip walks through in `clip_delta` of timeline. Without a
/// speed change the two are the same number.
fn source_delta_for_clip_delta(member: &GroupResizeMember, clip_delta: MediaTime) -> MediaTime {
    if member.retime.is_none() {
        return clip_delta;
    }

    let ticks = clip_delta.as_ticks() as f64;
    let source_delta = if ticks >= 0.0 {
        get_source_span_at_clip_time(SourceSpanAtClipTimeOptions {
            clip_time: ticks,
            clip_duration: None,
            retime: member.retime.clone(),
        })
    } else {
        -get_source_span_at_clip_time(SourceSpanAtClipTimeOptions {
            clip_time: ticks.abs(),
            clip_duration: None,
            retime: member.retime.clone(),
        })
    };
    round_media_time(source_delta)
}

fn visible_source_span_for_duration(
    member: &GroupResizeMember,
    duration: MediaTime,
) -> MediaTime {
    if member.retime.is_none() {
        return duration;
    }

    round_media_time(get_source_span_at_clip_time(SourceSpanAtClipTimeOptions {
        clip_time: duration.as_ticks() as f64,
        clip_duration: None,
        retime: member.retime.clone(),
    }))
}

fn duration_for_visible_source_span(
    member: &GroupResizeMember,
    source_span: MediaTime,
) -> MediaTime {
    if member.retime.is_none() {
        return source_span;
    }

    round_media_time(get_timeline_duration_for_source_span(
        TimelineDurationOptions {
            source_span: source_span.as_ticks() as f64,
            retime: member.retime.clone(),
        },
    ))
}

/// How much source the clip has in total. When it was not recorded, it is
/// whatever the clip currently shows plus what is trimmed off either end.
fn source_duration(member: &GroupResizeMember) -> MediaTime {
    match member.source_duration {
        Some(duration) => duration,
        None => {
            member.trim_start
                + visible_source_span_for_duration(member, member.duration)
                + member.trim_end
        }
    }
}

/// The most negative delta this member allows. Dragging the right edge can only
/// shrink the clip to one frame; dragging the left edge is limited by the
/// previous clip, and by how much source is left above the current trim.
fn minimum_allowed_delta_time(
    member: &GroupResizeMember,
    side: ResizeSide,
    min_duration: MediaTime,
) -> MediaTime {
    if side == ResizeSide::Right {
        return min_duration - member.duration;
    }

    let left_neighbor_floor = match member.left_neighbor_bound {
        Some(bound) => bound - member.start_time,
        None => MediaTime::ZERO - member.start_time,
    };
    if member.frozen() || member.source_duration.is_none() {
        return left_neighbor_floor;
    }

    let maximum_source_extension = duration_for_visible_source_span(
        member,
        visible_source_span_for_duration(member, member.duration) + member.trim_start,
    ) - member.duration;
    left_neighbor_floor.max(MediaTime::ZERO - maximum_source_extension)
}

/// The most positive delta this member allows, or `None` when nothing limits it.
fn maximum_allowed_delta_time(
    member: &GroupResizeMember,
    side: ResizeSide,
    min_duration: MediaTime,
) -> Option<MediaTime> {
    if side == ResizeSide::Left {
        return Some(member.duration - min_duration);
    }

    let right_neighbor_ceiling = member
        .right_neighbor_bound
        .map(|bound| bound - (member.start_time + member.duration));
    if member.frozen() || member.source_duration.is_none() {
        return right_neighbor_ceiling;
    }

    let maximum_visible_source_span = source_duration(member) - member.trim_start;
    let maximum_duration = duration_for_visible_source_span(member, maximum_visible_source_span);
    let source_duration_ceiling = maximum_duration - member.duration;
    Some(match right_neighbor_ceiling {
        Some(ceiling) => ceiling.min(source_duration_ceiling),
        None => source_duration_ceiling,
    })
}

fn build_resize_update(
    member: &GroupResizeMember,
    side: ResizeSide,
    delta_time: MediaTime,
) -> GroupResizeUpdate {
    // Dragging a still's edge changes how long the frame is held, never which
    // frame it is, so its trims stay exactly where the freeze put them.
    let source_delta = if member.frozen() {
        MediaTime::ZERO
    } else {
        source_delta_for_clip_delta(member, delta_time)
    };

    let patch = match side {
        ResizeSide::Left => GroupResizePatch {
            trim_start: MediaTime::ZERO.max(member.trim_start + source_delta),
            trim_end: member.trim_end,
            start_time: member.start_time + delta_time,
            duration: member.duration - delta_time,
        },
        ResizeSide::Right => GroupResizePatch {
            trim_start: member.trim_start,
            trim_end: MediaTime::ZERO.max(member.trim_end - source_delta),
            start_time: member.start_time,
            duration: member.duration + delta_time,
        },
    };

    GroupResizeUpdate {
        track_id: member.track_id.clone(),
        element_id: member.element_id.clone(),
        patch,
    }
}

pub fn compute_group_resize(
    members: &[GroupResizeMember],
    side: ResizeSide,
    delta_time: MediaTime,
    fps: FrameRate,
) -> GroupResizeResult {
    if members.is_empty() {
        return GroupResizeResult {
            delta_time: MediaTime::ZERO,
            updates: Vec::new(),
        };
    }

    // One frame is the shortest a clip may be.
    let min_duration = round_media_time(
        (TICKS_PER_SECOND as f64 * f64::from(fps.denominator)) / f64::from(fps.numerator),
    );

    let mut minimum_delta_time = minimum_allowed_delta_time(&members[0], side, min_duration);
    let mut maximum_delta_time = maximum_allowed_delta_time(&members[0], side, min_duration);

    for member in &members[1..] {
        minimum_delta_time =
            minimum_delta_time.max(minimum_allowed_delta_time(member, side, min_duration));
        if let Some(member_maximum) = maximum_allowed_delta_time(member, side, min_duration) {
            maximum_delta_time = Some(match maximum_delta_time {
                Some(current) => current.min(member_maximum),
                None => member_maximum,
            });
        }
    }

    let clamped_delta_time = match maximum_delta_time {
        Some(maximum) => clamp_between(delta_time, minimum_delta_time, maximum),
        None => minimum_delta_time.max(delta_time),
    };

    // Snap the drag delta to a frame exactly once, then derive every patch field
    // from that single snapped value. This keeps the invariant
    // `trimStart + duration*rate + trimEnd == sourceDuration` exact: the same
    // delta is added on one side of the element and removed from the other, so
    // the rounding cancels by construction. Per-field rounding cannot preserve
    // this, because the individual rounds do not compose when `sourceDuration`
    // is not frame-aligned.
    let snapped_delta_time = clamped_delta_time.round_to_frame(fps).unwrap_or(clamped_delta_time);

    // Re-clamp after rounding. Bounds derived from other elements are
    // frame-aligned, so this is normally a no-op; at the source-extent limit the
    // bound may not be, and honouring the bound takes precedence over frame
    // alignment — you cannot extend past real content.
    let final_delta_time = match maximum_delta_time {
        Some(maximum) => clamp_between(snapped_delta_time, minimum_delta_time, maximum),
        None => minimum_delta_time.max(snapped_delta_time),
    };

    GroupResizeResult {
        delta_time: final_delta_time,
        updates: members
            .iter()
            .map(|member| build_resize_update(member, side, final_delta_time))
            .collect(),
    }
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComputeGroupResizeOptions {
    pub members: Vec<GroupResizeMember>,
    pub side: ResizeSide,
    pub delta_time: MediaTime,
    pub fps: FrameRate,
}

#[bridge::export]
pub fn compute_group_resize_value(
    ComputeGroupResizeOptions {
        members,
        side,
        delta_time,
        fps,
    }: ComputeGroupResizeOptions,
) -> GroupResizeResult {
    compute_group_resize(&members, side, delta_time, fps)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(start: i64, duration: i64) -> GroupResizeMember {
        GroupResizeMember {
            track_id: "track-1".to_string(),
            element_id: "element-1".to_string(),
            start_time: MediaTime::from_ticks(start),
            duration: MediaTime::from_ticks(duration),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            retime: None,
            is_frozen: None,
            left_neighbor_bound: None,
            right_neighbor_bound: None,
        }
    }

    const FPS_30: FrameRate = FrameRate::FPS_30;

    #[test]
    fn an_empty_selection_resizes_by_nothing() {
        let result = compute_group_resize(&[], ResizeSide::Right, MediaTime::from_ticks(4_000), FPS_30);
        assert_eq!(result.delta_time, MediaTime::ZERO);
        assert!(result.updates.is_empty());
    }

    #[test]
    fn a_right_drag_lengthens_the_clip_and_leaves_its_start_alone() {
        let members = vec![member(0, 120_000)];
        let result =
            compute_group_resize(&members, ResizeSide::Right, MediaTime::from_ticks(4_000), FPS_30);
        assert_eq!(result.delta_time, MediaTime::from_ticks(4_000));
        assert_eq!(result.updates[0].patch.start_time, MediaTime::ZERO);
        assert_eq!(
            result.updates[0].patch.duration,
            MediaTime::from_ticks(124_000)
        );
    }

    #[test]
    fn a_left_drag_moves_the_start_and_shortens_the_clip_by_the_same_amount() {
        let members = vec![member(120_000, 120_000)];
        let result =
            compute_group_resize(&members, ResizeSide::Left, MediaTime::from_ticks(4_000), FPS_30);
        let patch = &result.updates[0].patch;
        assert_eq!(patch.start_time, MediaTime::from_ticks(124_000));
        assert_eq!(patch.duration, MediaTime::from_ticks(116_000));
        assert_eq!(patch.start_time + patch.duration, MediaTime::from_ticks(240_000));
    }

    #[test]
    fn a_clip_cannot_be_dragged_shorter_than_one_frame() {
        let members = vec![member(0, 8_000)];
        let result = compute_group_resize(
            &members,
            ResizeSide::Right,
            MediaTime::from_ticks(-100_000),
            FPS_30,
        );
        // 30fps is 4,000 ticks a frame.
        assert_eq!(result.updates[0].patch.duration, MediaTime::from_ticks(4_000));
    }

    #[test]
    fn a_left_drag_stops_at_zero_when_nothing_precedes_the_clip() {
        let members = vec![member(4_000, 120_000)];
        let result = compute_group_resize(
            &members,
            ResizeSide::Left,
            MediaTime::from_ticks(-100_000),
            FPS_30,
        );
        assert_eq!(result.updates[0].patch.start_time, MediaTime::ZERO);
    }

    #[test]
    fn a_neighbour_stops_the_drag_for_the_whole_group() {
        let mut blocked = member(120_000, 120_000);
        blocked.element_id = "element-2".to_string();
        blocked.right_neighbor_bound = Some(MediaTime::from_ticks(244_000));
        let members = vec![member(0, 120_000), blocked];

        let result =
            compute_group_resize(&members, ResizeSide::Right, MediaTime::from_ticks(40_000), FPS_30);
        assert_eq!(result.delta_time, MediaTime::from_ticks(4_000));
        assert_eq!(
            result.updates[0].patch.duration,
            MediaTime::from_ticks(124_000)
        );
    }

    #[test]
    fn the_delta_lands_on_a_frame_boundary() {
        let members = vec![member(0, 120_000)];
        let result =
            compute_group_resize(&members, ResizeSide::Right, MediaTime::from_ticks(4_100), FPS_30);
        assert_eq!(result.delta_time, MediaTime::from_ticks(4_000));
    }

    #[test]
    fn a_still_keeps_its_trims_however_far_it_is_stretched() {
        let mut frozen = member(0, 120_000);
        frozen.is_frozen = Some(true);
        frozen.trim_start = MediaTime::from_ticks(60_000);
        frozen.trim_end = MediaTime::from_ticks(12_000);
        frozen.source_duration = Some(MediaTime::from_ticks(240_000));

        let result = compute_group_resize(
            &[frozen],
            ResizeSide::Right,
            MediaTime::from_ticks(400_000),
            FPS_30,
        );
        let patch = &result.updates[0].patch;
        assert_eq!(patch.trim_start, MediaTime::from_ticks(60_000));
        assert_eq!(patch.trim_end, MediaTime::from_ticks(12_000));
        assert_eq!(patch.duration, MediaTime::from_ticks(520_000));
    }

    #[test]
    fn crossed_bounds_resolve_instead_of_panicking() {
        // Two frames long with its neighbour already at its own start: it may
        // not shrink below one frame, and may not grow at all, so the floor
        // (-4,000) sits above the ceiling (-8,000). The first clamp answers the
        // ceiling and the re-clamp after frame snapping answers the floor, so
        // the minimum length is what survives.
        let mut overlapping = member(0, 8_000);
        overlapping.right_neighbor_bound = Some(MediaTime::ZERO);
        let result = compute_group_resize(
            &[overlapping],
            ResizeSide::Right,
            MediaTime::from_ticks(4_000),
            FPS_30,
        );
        assert_eq!(result.delta_time, MediaTime::from_ticks(-4_000));
        assert_eq!(result.updates[0].patch.duration, MediaTime::from_ticks(4_000));
    }

    #[test]
    fn a_neighbour_behind_the_clip_edge_pulls_the_drag_back() {
        let mut blocked = member(0, 120_000);
        blocked.right_neighbor_bound = Some(MediaTime::from_ticks(40_000));
        let result = compute_group_resize(
            &[blocked],
            ResizeSide::Right,
            MediaTime::from_ticks(4_000),
            FPS_30,
        );
        assert_eq!(result.delta_time, MediaTime::from_ticks(-80_000));
    }

    #[test]
    fn a_clip_cannot_be_stretched_past_the_source_it_has() {
        let mut limited = member(0, 120_000);
        limited.source_duration = Some(MediaTime::from_ticks(240_000));
        let result = compute_group_resize(
            &[limited],
            ResizeSide::Right,
            MediaTime::from_ticks(400_000),
            FPS_30,
        );
        assert_eq!(result.updates[0].patch.duration, MediaTime::from_ticks(240_000));
        assert_eq!(result.updates[0].patch.trim_end, MediaTime::ZERO);
    }
}
