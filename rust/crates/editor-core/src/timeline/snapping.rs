//! Where a dragged edge wants to land.
//!
//! A gesture collects candidate times once — every other element's edges, the
//! playhead, every other element's keyframes — and then resolves against that
//! list on each mousemove. Collecting walks every track, element and keyframe in
//! the scene, and none of those can change mid-gesture, so the split matters:
//! building on every move is what made dragging a clip in a long project stutter.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use time::{MediaTime, TICKS_PER_SECOND};

use crate::animation::is_animation_path;
use crate::model::{AnimationChannel, Bookmark, ChannelData, ElementAnimations, SceneTracks};

/// Pixels per second at zoom 1. The snap threshold is a distance on screen, so
/// it has to come back through the zoom to be a number of ticks.
pub const BASE_TIMELINE_PIXELS_PER_SECOND: f64 = 50.0;

const DEFAULT_TIMELINE_SNAP_THRESHOLD_PX: f64 = 10.0;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SnapPointType {
    ElementStart,
    ElementEnd,
    Playhead,
    Bookmark,
    Keyframe,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapPoint {
    pub time: MediaTime,
    #[serde(rename = "type")]
    pub kind: SnapPointType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapResult {
    pub snapped_time: MediaTime,
    pub snap_point: Option<SnapPoint>,
    /// `Infinity` when nothing was in range, which is what the comparison in
    /// `resolve_group_move_snap` relies on to reject a member.
    pub snap_distance: f64,
}

/// How far a drag can be from a candidate and still snap to it, in ticks.
pub fn timeline_snap_threshold_in_ticks(zoom_level: f64, snap_threshold_px: f64) -> f64 {
    let pixels_per_second = BASE_TIMELINE_PIXELS_PER_SECOND * zoom_level;
    (snap_threshold_px / pixels_per_second) * TICKS_PER_SECOND as f64
}

/// The nearest candidate within `max_snap_distance`, or the time unchanged.
/// Ties go to the earlier candidate in the list, so the order the sources are
/// collected in is part of the behaviour.
pub fn resolve_timeline_snap(
    target_time: MediaTime,
    snap_points: &[SnapPoint],
    max_snap_distance: f64,
) -> SnapResult {
    let mut closest: Option<&SnapPoint> = None;
    let mut closest_distance = f64::INFINITY;

    for snap_point in snap_points {
        let distance = (target_time.as_ticks() - snap_point.time.as_ticks()).abs() as f64;
        if distance <= max_snap_distance && distance < closest_distance {
            closest_distance = distance;
            closest = Some(snap_point);
        }
    }

    SnapResult {
        snapped_time: closest.map_or(target_time, |snap_point| snap_point.time),
        snap_point: closest.cloned(),
        snap_distance: closest_distance,
    }
}

fn display_tracks(tracks: &SceneTracks) -> Vec<&crate::model::Track> {
    let mut ordered: Vec<&crate::model::Track> = tracks.overlay.iter().collect();
    ordered.push(&tracks.main);
    ordered.extend(tracks.audio.iter());
    ordered
}

fn channel_key_times(channel: &AnimationChannel, times: &mut Vec<MediaTime>) {
    match channel {
        AnimationChannel::Scalar { keys, .. } => {
            times.extend(keys.iter().map(|key| key.time));
        }
        AnimationChannel::Discrete { keys } => {
            times.extend(keys.iter().map(|key| key.time));
        }
    }
}

/// Every keyframe time an element carries, in the order the stored paths sort
/// in. The JavaScript walked an object's insertion order; sorting instead makes
/// the snap point list — and therefore which candidate wins a tie — the same on
/// every run.
pub fn element_keyframe_times(animations: Option<&ElementAnimations>) -> Vec<MediaTime> {
    let Some(animations) = animations else {
        return Vec::new();
    };

    let mut paths: Vec<&String> = animations
        .keys()
        .filter(|path| is_animation_path(path))
        .collect();
    paths.sort();

    let mut times = Vec::new();
    for path in paths {
        match &animations[path] {
            ChannelData::Channel(channel) => channel_key_times(channel, &mut times),
            ChannelData::Composite(components) => {
                let mut component_keys: Vec<&String> = components.keys().collect();
                component_keys.sort();
                for component_key in component_keys {
                    channel_key_times(&components[component_key], &mut times);
                }
            }
        }
    }
    times
}

/// Both edges of every element, minus the ones being dragged.
pub fn element_edge_snap_points(
    tracks: &SceneTracks,
    exclude_element_ids: &HashSet<String>,
) -> Vec<SnapPoint> {
    let mut snap_points = Vec::new();
    for track in display_tracks(tracks) {
        for element in track.elements() {
            if exclude_element_ids.contains(&element.id) {
                continue;
            }
            snap_points.push(SnapPoint {
                time: element.start_time,
                kind: SnapPointType::ElementStart,
                element_id: Some(element.id.clone()),
                track_id: Some(track.id().to_string()),
            });
            snap_points.push(SnapPoint {
                time: element.start_time + element.duration,
                kind: SnapPointType::ElementEnd,
                element_id: Some(element.id.clone()),
                track_id: Some(track.id().to_string()),
            });
        }
    }
    snap_points
}

pub fn playhead_snap_points(playhead_time: MediaTime) -> Vec<SnapPoint> {
    vec![SnapPoint {
        time: playhead_time,
        kind: SnapPointType::Playhead,
        element_id: None,
        track_id: None,
    }]
}

/// Keyframe times are stored relative to the element, so each one is offset by
/// where the element sits on the timeline.
pub fn animation_keyframe_snap_points(
    tracks: &SceneTracks,
    exclude_element_ids: &HashSet<String>,
) -> Vec<SnapPoint> {
    let mut snap_points = Vec::new();
    for track in display_tracks(tracks) {
        for element in track.elements() {
            if exclude_element_ids.contains(&element.id) {
                continue;
            }
            for keyframe_time in element_keyframe_times(element.animations.as_ref()) {
                snap_points.push(SnapPoint {
                    time: element.start_time + keyframe_time,
                    kind: SnapPointType::Keyframe,
                    element_id: Some(element.id.clone()),
                    track_id: Some(track.id().to_string()),
                });
            }
        }
    }
    snap_points
}

/// A bookmark the drag is not itself moving.
pub fn bookmark_snap_points(
    bookmarks: &[Bookmark],
    exclude_bookmark_time: Option<MediaTime>,
) -> Vec<SnapPoint> {
    bookmarks
        .iter()
        .filter(|bookmark| exclude_bookmark_time != Some(bookmark.time))
        .map(|bookmark| SnapPoint {
            time: bookmark.time,
            kind: SnapPointType::Bookmark,
            element_id: None,
            track_id: None,
        })
        .collect()
}

/// Everything a gesture can snap to, in the order that decides ties: element
/// edges, then the playhead, then bookmarks, then keyframes. A gesture that one
/// of these should not pull on simply leaves it out — the playhead is not a
/// candidate while the playhead itself is being dragged, and bookmarks are not
/// candidates for a clip.
pub fn build_timeline_snap_points(
    tracks: &SceneTracks,
    playhead_time: Option<MediaTime>,
    bookmarks: Option<&[Bookmark]>,
    exclude_bookmark_time: Option<MediaTime>,
    exclude_element_ids: &HashSet<String>,
) -> Vec<SnapPoint> {
    let mut snap_points = element_edge_snap_points(tracks, exclude_element_ids);
    if let Some(playhead_time) = playhead_time {
        snap_points.extend(playhead_snap_points(playhead_time));
    }
    if let Some(bookmarks) = bookmarks {
        snap_points.extend(bookmark_snap_points(bookmarks, exclude_bookmark_time));
    }
    snap_points.extend(animation_keyframe_snap_points(tracks, exclude_element_ids));
    snap_points
}

/// The set a drag or resize of elements uses: edges, the playhead, keyframes.
pub fn element_gesture_snap_points(
    tracks: &SceneTracks,
    playhead_time: MediaTime,
    exclude_element_ids: &HashSet<String>,
) -> Vec<SnapPoint> {
    build_timeline_snap_points(
        tracks,
        Some(playhead_time),
        None,
        None,
        exclude_element_ids,
    )
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapThresholdOptions {
    pub zoom_level: f64,
    #[serde(default)]
    pub snap_threshold_px: Option<f64>,
}

#[bridge::export]
pub fn get_timeline_snap_threshold_in_ticks(
    SnapThresholdOptions {
        zoom_level,
        snap_threshold_px,
    }: SnapThresholdOptions,
) -> f64 {
    timeline_snap_threshold_in_ticks(
        zoom_level,
        snap_threshold_px.unwrap_or(DEFAULT_TIMELINE_SNAP_THRESHOLD_PX),
    )
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSnapOptions {
    pub target_time: MediaTime,
    pub snap_points: Vec<SnapPoint>,
    pub max_snap_distance: f64,
}

#[bridge::export]
pub fn resolve_timeline_snap_value(
    ResolveSnapOptions {
        target_time,
        snap_points,
        max_snap_distance,
    }: ResolveSnapOptions,
) -> SnapResult {
    resolve_timeline_snap(target_time, &snap_points, max_snap_distance)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GestureSnapPointsOptions {
    pub tracks: SceneTracks,
    pub playhead_time: MediaTime,
    #[serde(default)]
    pub exclude_element_ids: Vec<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSnapPointsOptions {
    pub tracks: SceneTracks,
    /// Omitted while the playhead itself is what is being dragged.
    #[serde(default)]
    pub playhead_time: Option<MediaTime>,
    /// Omitted by gestures that bookmarks should not pull on.
    #[serde(default)]
    pub bookmarks: Option<Vec<Bookmark>>,
    #[serde(default)]
    pub exclude_bookmark_time: Option<MediaTime>,
    #[serde(default)]
    pub exclude_element_ids: Vec<String>,
}

#[bridge::export]
pub fn build_timeline_snap_points_value(
    TimelineSnapPointsOptions {
        tracks,
        playhead_time,
        bookmarks,
        exclude_bookmark_time,
        exclude_element_ids,
    }: TimelineSnapPointsOptions,
) -> SnapPoints {
    SnapPoints {
        snap_points: build_timeline_snap_points(
            &tracks,
            playhead_time,
            bookmarks.as_deref(),
            exclude_bookmark_time,
            &exclude_element_ids.into_iter().collect(),
        ),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapPoints {
    pub snap_points: Vec<SnapPoint>,
}

#[bridge::export]
pub fn build_element_gesture_snap_points(
    GestureSnapPointsOptions {
        tracks,
        playhead_time,
        exclude_element_ids,
    }: GestureSnapPointsOptions,
) -> SnapPoints {
    SnapPoints {
        snap_points: element_gesture_snap_points(
            &tracks,
            playhead_time,
            &exclude_element_ids.into_iter().collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(ticks: i64, kind: SnapPointType) -> SnapPoint {
        SnapPoint {
            time: MediaTime::from_ticks(ticks),
            kind,
            element_id: None,
            track_id: None,
        }
    }

    #[test]
    fn takes_the_nearest_candidate_in_range() {
        let points = vec![
            point(1_000, SnapPointType::ElementStart),
            point(1_200, SnapPointType::Playhead),
        ];
        let result = resolve_timeline_snap(MediaTime::from_ticks(1_150), &points, 100.0);
        assert_eq!(result.snapped_time, MediaTime::from_ticks(1_200));
        assert_eq!(result.snap_distance, 50.0);
    }

    #[test]
    fn leaves_the_time_alone_when_nothing_is_in_range() {
        let points = vec![point(1_000, SnapPointType::ElementStart)];
        let result = resolve_timeline_snap(MediaTime::from_ticks(5_000), &points, 100.0);
        assert_eq!(result.snapped_time, MediaTime::from_ticks(5_000));
        assert_eq!(result.snap_point, None);
        assert!(result.snap_distance.is_infinite());
    }

    #[test]
    fn a_tie_goes_to_the_earlier_candidate() {
        let points = vec![
            point(1_000, SnapPointType::ElementStart),
            point(1_000, SnapPointType::Playhead),
        ];
        let result = resolve_timeline_snap(MediaTime::from_ticks(1_000), &points, 100.0);
        assert_eq!(
            result.snap_point.map(|snap_point| snap_point.kind),
            Some(SnapPointType::ElementStart)
        );
    }

    #[test]
    fn the_threshold_shrinks_in_ticks_as_the_zoom_grows() {
        // 10px at zoom 1 is a fifth of a second.
        assert_eq!(
            timeline_snap_threshold_in_ticks(1.0, 10.0),
            TICKS_PER_SECOND as f64 / 5.0
        );
        assert_eq!(
            timeline_snap_threshold_in_ticks(10.0, 10.0),
            TICKS_PER_SECOND as f64 / 50.0
        );
    }
}
