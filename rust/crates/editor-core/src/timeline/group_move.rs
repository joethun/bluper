//! Moving a selection of clips as one block.
//!
//! The anchor is the clip under the cursor; every other member keeps its offset
//! from it, in time and in track order. A move either lands on tracks that
//! already exist — in which case each member has to find a compatible, unused
//! track in the same direction it started — or creates a block of new tracks,
//! which is only allowed when the whole selection is on one side of the audio
//! divide.
//!
//! Nothing here mutates the scene. Every function answers with a plan, or with
//! `None` when the move is not possible; that is what lets the drag preview show
//! the same verdict the drop will reach.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use time::MediaTime;

use super::placement::{
    ElementType, ElementTypeOptions, PlacementTimeSpan, TrackType, element_type,
    get_track_type_for_element_type, spans_fit_elements,
};
use crate::model::{SceneTracks, TimelineElement, Track};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GroupTrackSection {
    Overlay,
    Main,
    Audio,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub track_id: String,
    pub element_id: String,
    pub element_type: ElementType,
    pub duration: MediaTime,
    /// Signed offset from the anchor's start, so a member ahead of the anchor
    /// carries a negative one.
    pub time_offset: MediaTime,
    pub track_section: GroupTrackSection,
    pub section_index: i32,
    pub display_index: i32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoveGroup {
    pub anchor: GroupMember,
    pub members: Vec<GroupMember>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTrackCreation {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: TrackType,
    pub index: i32,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedElementMove {
    pub source_track_id: String,
    pub target_track_id: String,
    pub element_id: String,
    pub new_start_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MovedElementRef {
    pub track_id: String,
    pub element_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMoveResult {
    pub moves: Vec<PlannedElementMove>,
    pub create_tracks: Vec<PlannedTrackCreation>,
    pub target_selection: Vec<MovedElementRef>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackPlacement {
    pub track_id: String,
    pub track_type: TrackType,
    pub section: GroupTrackSection,
    pub section_index: i32,
    pub display_index: i32,
}

fn track_type_of(track: &Track) -> TrackType {
    match track {
        Track::Video { .. } => TrackType::Video,
        Track::Text { .. } => TrackType::Text,
        Track::Audio { .. } => TrackType::Audio,
        Track::Effect { .. } => TrackType::Effect,
        Track::Adjustment { .. } => TrackType::Adjustment,
        Track::Graphic { .. } => TrackType::Graphic,
    }
}

/// Tracks in the order the timeline draws them: overlays top-down, then main,
/// then audio. A member's `display_index` is an index into this.
pub fn display_tracks(tracks: &SceneTracks) -> Vec<&Track> {
    let mut ordered: Vec<&Track> = tracks.overlay.iter().collect();
    ordered.push(&tracks.main);
    ordered.extend(tracks.audio.iter());
    ordered
}

pub fn track_placement_by_id(tracks: &SceneTracks, track_id: &str) -> Option<TrackPlacement> {
    if tracks.main.id() == track_id {
        return Some(TrackPlacement {
            track_id: track_id.to_string(),
            track_type: track_type_of(&tracks.main),
            section: GroupTrackSection::Main,
            // The main track has no index within a list of its own; -1 says so
            // rather than colliding with the first overlay.
            section_index: -1,
            display_index: tracks.overlay.len() as i32,
        });
    }

    if let Some(index) = tracks
        .overlay
        .iter()
        .position(|track| track.id() == track_id)
    {
        return Some(TrackPlacement {
            track_id: track_id.to_string(),
            track_type: track_type_of(&tracks.overlay[index]),
            section: GroupTrackSection::Overlay,
            section_index: index as i32,
            display_index: index as i32,
        });
    }

    if let Some(index) = tracks.audio.iter().position(|track| track.id() == track_id) {
        return Some(TrackPlacement {
            track_id: track_id.to_string(),
            track_type: track_type_of(&tracks.audio[index]),
            section: GroupTrackSection::Audio,
            section_index: index as i32,
            display_index: (tracks.overlay.len() + 1 + index) as i32,
        });
    }

    None
}

pub fn track_placement_by_display_index(
    tracks: &SceneTracks,
    display_index: i32,
) -> Option<TrackPlacement> {
    let ordered = display_tracks(tracks);
    let track = usize::try_from(display_index)
        .ok()
        .and_then(|index| ordered.get(index))?;
    track_placement_by_id(tracks, track.id())
}

fn find_track<'tracks>(tracks: &'tracks SceneTracks, track_id: &str) -> Option<&'tracks Track> {
    display_tracks(tracks)
        .into_iter()
        .find(|track| track.id() == track_id)
}

/// Read the selection into a group: the anchor, and every other selected element
/// with its offset recorded. Elements that no longer exist are dropped rather
/// than failing the whole gesture.
pub fn build_move_group(
    tracks: &SceneTracks,
    anchor_track_id: &str,
    anchor_element_id: &str,
    selected_elements: &[(String, String)],
) -> Option<MoveGroup> {
    let anchor_track = find_track(tracks, anchor_track_id)?;
    let anchor_element = anchor_track
        .elements()
        .iter()
        .find(|element| element.id == anchor_element_id)?;
    track_placement_by_id(tracks, anchor_track_id)?;

    // The anchor goes first so that it wins the de-duplication: a selection that
    // also lists the anchor must not record it twice, and the copy that survives
    // has to be the one whose track the drag started on.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut ordered_refs: Vec<(&str, &str)> = Vec::new();
    for (track_id, element_id) in std::iter::once((anchor_track_id, anchor_element_id)).chain(
        selected_elements
            .iter()
            .map(|(track_id, element_id)| (track_id.as_str(), element_id.as_str())),
    ) {
        if seen.insert(element_id) {
            ordered_refs.push((track_id, element_id));
        }
    }

    let mut members = Vec::new();
    for (track_id, element_id) in ordered_refs {
        let Some(track) = find_track(tracks, track_id) else {
            continue;
        };
        let Some(element) = track
            .elements()
            .iter()
            .find(|candidate| candidate.id == element_id)
        else {
            continue;
        };
        let Some(placement) = track_placement_by_id(tracks, track_id) else {
            continue;
        };

        members.push(GroupMember {
            track_id: track.id().to_string(),
            element_id: element.id.clone(),
            element_type: element_type(element),
            duration: element.duration,
            time_offset: element.start_time - anchor_element.start_time,
            track_section: placement.section,
            section_index: placement.section_index,
            display_index: placement.display_index,
        });
    }

    if members.is_empty() {
        return None;
    }

    let anchor = members
        .iter()
        .find(|member| member.track_id == anchor_track_id && member.element_id == anchor_element_id)?
        .clone();

    Some(MoveGroup { anchor, members })
}

/// Where the group can start without pushing any of its members before zero.
///
/// That is the whole clamp. No track pins its earliest element to the start of
/// the timeline — the main track used to, which meant the first clip on it could
/// not be moved at all, and a project could never open on a gap.
fn clamp_anchor_start_time(group: &MoveGroup, anchor_start_time: MediaTime) -> MediaTime {
    let minimum = group
        .members
        .iter()
        .filter(|member| member.time_offset < MediaTime::ZERO)
        .fold(MediaTime::ZERO, |minimum, member| {
            minimum.max(MediaTime::ZERO - member.time_offset)
        });

    if anchor_start_time < minimum {
        minimum
    } else {
        anchor_start_time
    }
}

fn sorted_members(group: &MoveGroup) -> Vec<&GroupMember> {
    let mut members: Vec<&GroupMember> = group.members.iter().collect();
    members.sort_by_key(|member| member.display_index);
    members
}

fn anchor_member_index(group: &MoveGroup, members: &[&GroupMember]) -> Option<usize> {
    members
        .iter()
        .position(|member| member.element_id == group.anchor.element_id)
}

fn required_track_type(member: &GroupMember) -> TrackType {
    get_track_type_for_element_type(ElementTypeOptions {
        element_type: member.element_type,
    })
}

/// Walk outward from the anchor's target looking for a track of the right type
/// that no other member has claimed. Direction matters: a member that started
/// above the anchor has to end up above it, or the selection would turn inside
/// out as it crossed a track it cannot use.
fn find_compatible_track_placement(
    tracks: &SceneTracks,
    required: TrackType,
    start_display_index: i32,
    step: i32,
    used_track_ids: &HashSet<String>,
) -> Option<TrackPlacement> {
    let display_count = (tracks.overlay.len() + 1 + tracks.audio.len()) as i32;
    let mut display_index = start_display_index;
    while display_index >= 0 && display_index < display_count {
        if let Some(placement) = track_placement_by_display_index(tracks, display_index) {
            if placement.track_type == required && !used_track_ids.contains(&placement.track_id) {
                return Some(placement);
            }
        }
        display_index += step;
    }
    None
}

fn existing_track_ids_by_element_id(
    group: &MoveGroup,
    tracks: &SceneTracks,
    anchor_target_display_index: i32,
) -> Option<HashMap<String, String>> {
    let members = sorted_members(group);
    let anchor_index = anchor_member_index(group, &members)?;

    let mut target_track_ids: HashMap<String, String> = HashMap::new();
    let mut used_track_ids: HashSet<String> = HashSet::new();
    let anchor_placement =
        track_placement_by_display_index(tracks, anchor_target_display_index)?;

    target_track_ids.insert(
        group.anchor.element_id.clone(),
        anchor_placement.track_id.clone(),
    );
    used_track_ids.insert(anchor_placement.track_id);

    let mut upper_boundary = anchor_target_display_index;
    for member in members[..anchor_index].iter().rev() {
        let placement = find_compatible_track_placement(
            tracks,
            required_track_type(member),
            upper_boundary - 1,
            -1,
            &used_track_ids,
        )?;
        target_track_ids.insert(member.element_id.clone(), placement.track_id.clone());
        used_track_ids.insert(placement.track_id);
        upper_boundary = placement.display_index;
    }

    let mut lower_boundary = anchor_target_display_index;
    for member in &members[anchor_index + 1..] {
        let placement = find_compatible_track_placement(
            tracks,
            required_track_type(member),
            lower_boundary + 1,
            1,
            &used_track_ids,
        )?;
        target_track_ids.insert(member.element_id.clone(), placement.track_id.clone());
        used_track_ids.insert(placement.track_id);
        lower_boundary = placement.display_index;
    }

    Some(target_track_ids)
}

fn has_overlapping_time_spans(time_spans: &[PlacementTimeSpan]) -> bool {
    let mut sorted: Vec<&PlacementTimeSpan> = time_spans.iter().collect();
    sorted.sort_by_key(|span| span.start_time);
    sorted.windows(2).any(|pair| {
        pair[0].start_time + pair[0].duration > pair[1].start_time
    })
}

/// Whether every planned move fits: the moving elements must not collide with
/// each other, nor with what stays behind on the track they land on.
fn can_apply_moves_to_existing_tracks(
    tracks: &SceneTracks,
    moves: &[PlannedElementMove],
) -> bool {
    let moving_element_ids: HashSet<&str> = moves
        .iter()
        .map(|planned| planned.element_id.as_str())
        .collect();
    let ordered = display_tracks(tracks);
    let mut source_durations: HashMap<&str, MediaTime> = HashMap::new();
    for track in &ordered {
        for element in track.elements() {
            source_durations.insert(element.id.as_str(), element.duration);
        }
    }

    let mut moves_by_target: Vec<(&str, Vec<&PlannedElementMove>)> = Vec::new();
    for planned in moves {
        match moves_by_target
            .iter_mut()
            .find(|(track_id, _)| *track_id == planned.target_track_id.as_str())
        {
            Some((_, grouped)) => grouped.push(planned),
            None => moves_by_target.push((planned.target_track_id.as_str(), vec![planned])),
        }
    }

    for (target_track_id, target_moves) in moves_by_target {
        let Some(placement) = track_placement_by_id(tracks, target_track_id) else {
            return false;
        };
        let Some(target_track) = usize::try_from(placement.display_index)
            .ok()
            .and_then(|index| ordered.get(index))
        else {
            return false;
        };

        let time_spans: Vec<PlacementTimeSpan> = target_moves
            .iter()
            .map(|planned| PlacementTimeSpan {
                start_time: planned.new_start_time,
                duration: source_durations
                    .get(planned.element_id.as_str())
                    .copied()
                    .unwrap_or(MediaTime::ZERO),
                exclude_element_id: None,
            })
            .collect();
        if has_overlapping_time_spans(&time_spans) {
            return false;
        }

        let staying: Vec<TimelineElement> = target_track
            .elements()
            .iter()
            .filter(|element| !moving_element_ids.contains(element.id.as_str()))
            .cloned()
            .collect();
        if !spans_fit_elements(&staying, &time_spans) {
            return false;
        }
    }

    true
}

fn resolve_existing_track_move(
    group: &MoveGroup,
    tracks: &SceneTracks,
    anchor_start_time: MediaTime,
    anchor_target_track_id: &str,
) -> Option<GroupMoveResult> {
    let anchor_target = track_placement_by_id(tracks, anchor_target_track_id)?;
    let target_track_ids =
        existing_track_ids_by_element_id(group, tracks, anchor_target.display_index)?;
    let clamped_anchor_start_time = clamp_anchor_start_time(group, anchor_start_time);

    let moves: Vec<PlannedElementMove> = group
        .members
        .iter()
        .map(|member| PlannedElementMove {
            source_track_id: member.track_id.clone(),
            target_track_id: target_track_ids
                .get(&member.element_id)
                .cloned()
                .unwrap_or_else(|| member.track_id.clone()),
            element_id: member.element_id.clone(),
            new_start_time: clamped_anchor_start_time + member.time_offset,
        })
        .collect();

    if !can_apply_moves_to_existing_tracks(tracks, &moves) {
        return None;
    }

    Some(GroupMoveResult {
        target_selection: moves
            .iter()
            .map(|planned| MovedElementRef {
                track_id: planned.target_track_id.clone(),
                element_id: planned.element_id.clone(),
            })
            .collect(),
        moves,
        create_tracks: Vec::new(),
    })
}

/// New audio tracks can only go below the main track, and only among the audio
/// tracks that already exist.
fn clamp_audio_insert_index(tracks: &SceneTracks, insert_index: i32) -> i32 {
    let minimum = tracks.overlay.len() as i32 + 1;
    insert_index
        .min(minimum + tracks.audio.len() as i32)
        .max(minimum)
}

fn resolve_new_track_move(
    group: &MoveGroup,
    tracks: &SceneTracks,
    anchor_start_time: MediaTime,
    anchor_insert_index: i32,
    new_track_ids: &[String],
) -> Option<GroupMoveResult> {
    let members = sorted_members(group);
    let anchor_index = anchor_member_index(group, &members)?;
    if new_track_ids.len() < members.len() {
        return None;
    }

    // A selection straddling the audio divide would need new tracks both above
    // and below the main track, which is not one block.
    let has_audio_member = members
        .iter()
        .any(|member| member.track_section == GroupTrackSection::Audio);
    let has_non_audio_member = members
        .iter()
        .any(|member| member.track_section != GroupTrackSection::Audio);
    if has_audio_member && has_non_audio_member {
        return None;
    }

    let clamped_anchor_start_time = clamp_anchor_start_time(group, anchor_start_time);
    let block_start_index = if has_audio_member {
        clamp_audio_insert_index(tracks, anchor_insert_index - anchor_index as i32)
    } else {
        (anchor_insert_index - anchor_index as i32)
            .min(tracks.overlay.len() as i32)
            .max(0)
    };

    let create_tracks: Vec<PlannedTrackCreation> = members
        .iter()
        .enumerate()
        .map(|(member_index, member)| PlannedTrackCreation {
            id: new_track_ids[member_index].clone(),
            kind: required_track_type(member),
            index: block_start_index + member_index as i32,
        })
        .collect();
    let moves: Vec<PlannedElementMove> = members
        .iter()
        .enumerate()
        .map(|(member_index, member)| PlannedElementMove {
            source_track_id: member.track_id.clone(),
            target_track_id: new_track_ids[member_index].clone(),
            element_id: member.element_id.clone(),
            new_start_time: clamped_anchor_start_time + member.time_offset,
        })
        .collect();

    Some(GroupMoveResult {
        target_selection: moves
            .iter()
            .map(|planned| MovedElementRef {
                track_id: planned.target_track_id.clone(),
                element_id: planned.element_id.clone(),
            })
            .collect(),
        moves,
        create_tracks,
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GroupMoveTarget {
    ExistingTrack {
        anchor_target_track_id: String,
    },
    NewTracks {
        anchor_insert_index: i32,
        new_track_ids: Vec<String>,
    },
}

pub fn resolve_group_move(
    group: &MoveGroup,
    tracks: &SceneTracks,
    anchor_start_time: MediaTime,
    target: &GroupMoveTarget,
) -> Option<GroupMoveResult> {
    match target {
        GroupMoveTarget::NewTracks {
            anchor_insert_index,
            new_track_ids,
        } => resolve_new_track_move(
            group,
            tracks,
            anchor_start_time,
            *anchor_insert_index,
            new_track_ids,
        ),
        GroupMoveTarget::ExistingTrack {
            anchor_target_track_id,
        } => resolve_existing_track_move(group, tracks, anchor_start_time, anchor_target_track_id),
    }
}

/// The anchor start time that puts whichever group edge is closest to a
/// candidate onto it. Every member's start *and* end is a candidate edge, so a
/// clip at the back of the selection can be what snaps.
pub fn resolve_group_move_snap(
    group: &MoveGroup,
    anchor_start_time: MediaTime,
    snap_points: &[super::snapping::SnapPoint],
    zoom_level: f64,
) -> (MediaTime, Option<super::snapping::SnapPoint>) {
    let max_snap_distance = super::snapping::timeline_snap_threshold_in_ticks(zoom_level, 10.0);

    let mut closest_distance = f64::INFINITY;
    let mut snapped_anchor_start_time = anchor_start_time;
    let mut snap_point = None;

    for member in &group.members {
        let member_start_time = anchor_start_time + member.time_offset;

        let start_snap = super::snapping::resolve_timeline_snap(
            member_start_time,
            snap_points,
            max_snap_distance,
        );
        if start_snap.snap_point.is_some() && start_snap.snap_distance < closest_distance {
            closest_distance = start_snap.snap_distance;
            snapped_anchor_start_time = start_snap.snapped_time - member.time_offset;
            snap_point = start_snap.snap_point;
        }

        let end_snap = super::snapping::resolve_timeline_snap(
            member_start_time + member.duration,
            snap_points,
            max_snap_distance,
        );
        if end_snap.snap_point.is_some() && end_snap.snap_distance < closest_distance {
            closest_distance = end_snap.snap_distance;
            snapped_anchor_start_time = end_snap.snapped_time - member.duration - member.time_offset;
            snap_point = end_snap.snap_point;
        }
    }

    (snapped_anchor_start_time, snap_point)
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementRefInput {
    pub track_id: String,
    pub element_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildMoveGroupOptions {
    pub anchor_ref: ElementRefInput,
    pub selected_elements: Vec<ElementRefInput>,
    pub tracks: SceneTracks,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeMoveGroup {
    pub group: Option<MoveGroup>,
}

#[bridge::export]
pub fn build_move_group_value(
    BuildMoveGroupOptions {
        anchor_ref,
        selected_elements,
        tracks,
    }: BuildMoveGroupOptions,
) -> MaybeMoveGroup {
    let selected: Vec<(String, String)> = selected_elements
        .into_iter()
        .map(|element_ref| (element_ref.track_id, element_ref.element_id))
        .collect();
    MaybeMoveGroup {
        group: build_move_group(
            &tracks,
            &anchor_ref.track_id,
            &anchor_ref.element_id,
            &selected,
        ),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveGroupMoveOptions {
    pub group: MoveGroup,
    pub tracks: SceneTracks,
    pub anchor_start_time: MediaTime,
    pub target: GroupMoveTarget,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeGroupMoveResult {
    pub result: Option<GroupMoveResult>,
}

#[bridge::export]
pub fn resolve_group_move_value(
    ResolveGroupMoveOptions {
        group,
        tracks,
        anchor_start_time,
        target,
    }: ResolveGroupMoveOptions,
) -> MaybeGroupMoveResult {
    MaybeGroupMoveResult {
        result: resolve_group_move(&group, &tracks, anchor_start_time, &target),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GroupMoveSnapPointsOptions {
    pub group: MoveGroup,
    pub tracks: SceneTracks,
    pub playhead_time: MediaTime,
}

#[bridge::export]
pub fn build_group_move_snap_points(
    GroupMoveSnapPointsOptions {
        group,
        tracks,
        playhead_time,
    }: GroupMoveSnapPointsOptions,
) -> super::snapping::SnapPoints {
    let excluded: HashSet<String> = group
        .members
        .iter()
        .map(|member| member.element_id.clone())
        .collect();
    super::snapping::SnapPoints {
        snap_points: super::snapping::element_gesture_snap_points(
            &tracks,
            playhead_time,
            &excluded,
        ),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveGroupMoveSnapOptions {
    pub group: MoveGroup,
    pub anchor_start_time: MediaTime,
    pub snap_points: Vec<super::snapping::SnapPoint>,
    pub zoom_level: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupMoveSnap {
    pub snapped_anchor_start_time: MediaTime,
    pub snap_point: Option<super::snapping::SnapPoint>,
}

#[bridge::export]
pub fn resolve_group_move_snap_value(
    ResolveGroupMoveSnapOptions {
        group,
        anchor_start_time,
        snap_points,
        zoom_level,
    }: ResolveGroupMoveSnapOptions,
) -> GroupMoveSnap {
    let (snapped_anchor_start_time, snap_point) =
        resolve_group_move_snap(&group, anchor_start_time, &snap_points, zoom_level);
    GroupMoveSnap {
        snapped_anchor_start_time,
        snap_point,
    }
}
