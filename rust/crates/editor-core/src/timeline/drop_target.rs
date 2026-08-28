//! Where a drag lands: the track row under the pointer, and the time under it.
//!
//! This sits directly on [`resolve_track_placement`], which already answers
//! "which track" once it is told an index. The work here is turning a pointer
//! position into that index — walking the stack of rows, deciding what a
//! pointer parked in the gap between two of them means, and hit-testing a clip
//! when the drag is something that lands *on* a clip rather than beside it.
//!
//! Row geometry is duplicated from `apps/web/src/timeline/components/layout.ts`
//! rather than passed in, because every caller would otherwise have to send the
//! same table across the boundary on every pointer move.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::{MediaTime, TICKS_PER_SECOND};

use crate::math::js_round;
use crate::model::{ElementKind, SceneTracks, Track};
use crate::timeline::placement::{
    ElementType, InsertPosition, PlacementResult, PlacementStrategy, PlacementTimeSpan,
    ResolvePlacementOptions, VerticalDragDirection, resolve_track_placement,
};
use crate::transitions::{TransitionCut, find_transition_cuts};

/// Vertical space between two track rows, in CSS pixels. Mirrors
/// `TIMELINE_TRACK_GAP_PX`; the drop resolver has to know about it because a
/// pointer sitting in the gap is a real, meaningful position.
const TIMELINE_TRACK_GAP_PX: f64 = 6.0;

/// How near the pointer has to be to a join for a transition to land on it.
const TRANSITION_SNAP_PX: f64 = 28.0;

/// Row height in CSS pixels. Mirrors `TIMELINE_TRACK_HEIGHTS_PX`: video rows
/// are tall enough for a thumbnail strip, audio for a waveform, and everything
/// else is a single label line.
fn track_height_px(track: &Track) -> f64 {
    match track {
        Track::Video { .. } => 65.0,
        Track::Audio { .. } => 50.0,
        Track::Text { .. }
        | Track::Graphic { .. }
        | Track::Effect { .. }
        | Track::Adjustment { .. } => 25.0,
    }
}

/// Tracks in the order the timeline draws them: overlays above, the main track,
/// then audio. Drop-target indices are indices into this list.
fn ordered_tracks(tracks: &SceneTracks) -> Vec<&Track> {
    let mut list: Vec<&Track> = tracks.overlay.iter().collect();
    list.push(&tracks.main);
    list.extend(tracks.audio.iter());
    list
}

/// The wire name of an element's type, so `target_element_types` can be matched
/// against the same strings the TypeScript model stores.
fn element_type_name(kind: &ElementKind) -> &'static str {
    match kind {
        ElementKind::Video { .. } => "video",
        ElementKind::Image { .. } => "image",
        ElementKind::Audio { .. } => "audio",
        ElementKind::Text { .. } => "text",
        ElementKind::Sticker { .. } => "sticker",
        ElementKind::Graphic { .. } => "graphic",
        ElementKind::Effect { .. } => "effect",
        ElementKind::Adjustment { .. } => "adjustment",
    }
}

/// The clip a drop names, for drags that land on an element rather than on a
/// stretch of empty track — an effect dropped onto a clip, or a transition
/// dropped onto the cut a clip begins at.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DropTargetElement {
    pub track_id: String,
    pub element_id: String,
}

/// Everything the timeline needs to draw the drop indicator and to commit the
/// drop: which row, whether that row has to be created first, and when.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DropTarget {
    pub track_index: i64,
    pub is_new_track: bool,
    /// Which side of `track_index` a new track goes on. `None` whenever the
    /// drop reuses an existing track.
    pub insert_position: Option<InsertPosition>,
    pub x_position: MediaTime,
    pub target_element: Option<DropTargetElement>,
    /// The join a transition drag has snapped to. Written only by
    /// [`compute_transition_drop_target`], since only a transition lands on a
    /// boundary between two clips rather than inside one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seam_time: Option<MediaTime>,
}

/// A drop target the pointer may not have found at all.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeDropTarget {
    pub target: Option<DropTarget>,
}

/// The last resort when placement refuses outright: a brand new track at the
/// top. A drag always has to resolve to *something*, because the pointer is
/// still down and the indicator still has to go somewhere.
fn fallback_new_track(x_position: MediaTime) -> DropTarget {
    DropTarget {
        track_index: 0,
        is_new_track: true,
        insert_position: None,
        x_position,
        target_element: None,
        seam_time: None,
    }
}

struct TrackAtY {
    track_index: usize,
    /// Offset from the top of that row, which decides above-versus-below.
    relative_y: f64,
}

/// Which row a vertical pointer position is over.
///
/// The gap between two rows only resolves to a track while a vertical drag is
/// in progress: without a direction there is no way to say which of the two
/// neighbours the user meant, and guessing would make the indicator flicker as
/// the pointer crossed six pixels of nothing.
fn track_at_y(
    tracks: &[&Track],
    mouse_y: f64,
    vertical_drag_direction: Option<VerticalDragDirection>,
) -> Option<TrackAtY> {
    let mut cumulative_height = 0.0;

    for (index, track) in tracks.iter().enumerate() {
        let track_height = track_height_px(track);
        let track_top = cumulative_height;
        let track_bottom = track_top + track_height;

        if mouse_y >= track_top && mouse_y < track_bottom {
            return Some(TrackAtY {
                track_index: index,
                relative_y: mouse_y - track_top,
            });
        }

        if index + 1 < tracks.len() && vertical_drag_direction.is_some() {
            let gap_top = track_bottom;
            let gap_bottom = gap_top + TIMELINE_TRACK_GAP_PX;
            if mouse_y >= gap_top && mouse_y < gap_bottom {
                let dragging_up = vertical_drag_direction == Some(VerticalDragDirection::Up);
                return Some(TrackAtY {
                    track_index: if dragging_up { index } else { index + 1 },
                    // Aim at the far edge of whichever row was chosen, so the
                    // above/below test downstream agrees with the direction.
                    relative_y: if dragging_up { track_height - 1.0 } else { 0.0 },
                });
            }
        }

        cumulative_height += track_height + TIMELINE_TRACK_GAP_PX;
    }

    None
}

/// Timeline time at a horizontal pixel offset, unclamped.
fn time_at_x(mouse_x: f64, pixels_per_second: f64, zoom_level: f64) -> MediaTime {
    let ticks = js_round((mouse_x / (pixels_per_second * zoom_level)) * TICKS_PER_SECOND as f64);
    MediaTime::from_ticks(ticks as i64)
}

/// The first clip on `track` of one of `target_element_types` that covers the
/// pointer. Half-open, so the pointer exactly on a clip's end belongs to the
/// next clip rather than to both.
fn element_at_position(
    track: &Track,
    mouse_x: f64,
    target_element_types: &[String],
    pixels_per_second: f64,
    zoom_level: f64,
) -> Option<DropTargetElement> {
    let time = time_at_x(mouse_x, pixels_per_second, zoom_level);

    track
        .elements()
        .iter()
        .find(|element| {
            let name = element_type_name(&element.kind);
            target_element_types.iter().any(|wanted| wanted == name)
                && element.start_time.as_ticks() <= time.as_ticks()
                && time.as_ticks()
                    < element.start_time.as_ticks() + element.duration.as_ticks()
        })
        .map(|element| DropTargetElement {
            track_id: track.id().to_string(),
            element_id: element.id.clone(),
        })
}

/// One-span placement query, which is the only shape a drop ever needs: a drag
/// carries a single clip's worth of time.
fn resolve(
    tracks: &SceneTracks,
    element_type: ElementType,
    x_position: MediaTime,
    element_duration: MediaTime,
    exclude_element_id: Option<String>,
    strategy: PlacementStrategy,
    source_track_id: Option<String>,
) -> Option<PlacementResult> {
    resolve_track_placement(ResolvePlacementOptions {
        tracks: tracks.clone(),
        time_spans: vec![PlacementTimeSpan {
            start_time: x_position,
            duration: element_duration,
            exclude_element_id,
        }],
        strategy,
        element_type: Some(element_type),
        track_type: None,
        source_track_id,
    })
    .placement
}

/// A resolved new-track placement rendered as a drop target, or the fallback
/// when placement answered with anything else.
fn new_track_target(placement: Option<PlacementResult>, x_position: MediaTime) -> DropTarget {
    match placement {
        Some(PlacementResult::NewTrack {
            insert_index,
            insert_position,
            ..
        }) => DropTarget {
            track_index: insert_index,
            is_new_track: true,
            insert_position,
            x_position,
            target_element: None,
            seam_time: None,
        },
        _ => fallback_new_track(x_position),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropTargetTransitionOptions {
    pub mouse_x: f64,
    pub mouse_y: f64,
    pub tracks: SceneTracks,
    pub pixels_per_second: f64,
    pub zoom_level: f64,
}

/// Resolves the join a transition drag is over. A transition belongs to a cut
/// rather than to a clip, so the drag snaps to the nearest boundary between two
/// adjacent clips instead of hit-testing whichever clip is under the pointer —
/// dropping in the middle of a clip means nothing.
#[export]
pub fn compute_transition_drop_target(
    DropTargetTransitionOptions {
        mouse_x,
        mouse_y,
        tracks,
        pixels_per_second,
        zoom_level,
    }: DropTargetTransitionOptions,
) -> MaybeDropTarget {
    let list = ordered_tracks(&tracks);
    let Some(at_y) = track_at_y(&list, mouse_y, None) else {
        return MaybeDropTarget { target: None };
    };
    let Some(track) = list.get(at_y.track_index) else {
        return MaybeDropTarget { target: None };
    };

    let pixels_per_tick = (pixels_per_second * zoom_level) / TICKS_PER_SECOND as f64;
    if pixels_per_tick <= 0.0 {
        return MaybeDropTarget { target: None };
    }

    let cuts = find_transition_cuts(track);
    let mut nearest: Option<(&TransitionCut, f64)> = None;
    for cut in &cuts {
        let distance_px = (cut.time.as_ticks() as f64 * pixels_per_tick - mouse_x).abs();
        // Strictly nearer, so the earliest cut wins a tie.
        if nearest.is_none_or(|(_, best)| distance_px < best) {
            nearest = Some((cut, distance_px));
        }
    }

    let Some((cut, distance_px)) = nearest else {
        return MaybeDropTarget { target: None };
    };
    if distance_px > TRANSITION_SNAP_PX {
        return MaybeDropTarget { target: None };
    }

    MaybeDropTarget {
        target: Some(DropTarget {
            track_index: at_y.track_index as i64,
            is_new_track: false,
            insert_position: None,
            // The transition is stored on the later clip, so that is what the
            // drop names; the seam rides along for the indicator.
            x_position: cut.time,
            target_element: Some(DropTargetElement {
                track_id: cut.track_id.clone(),
                element_id: cut.incoming_id.clone(),
            }),
            seam_time: Some(cut.time),
        }),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropTargetOptions {
    pub element_type: ElementType,
    pub mouse_x: f64,
    pub mouse_y: f64,
    pub tracks: SceneTracks,
    pub playhead_time: MediaTime,
    /// A drop from outside the timeline — the media panel, or the OS — which
    /// lands at the playhead rather than under the pointer.
    pub is_external_drop: bool,
    pub element_duration: MediaTime,
    pub pixels_per_second: f64,
    pub zoom_level: f64,
    #[serde(default)]
    pub vertical_drag_direction: Option<VerticalDragDirection>,
    /// A caller-decided time that wins over both the pointer and the playhead —
    /// a snapped drag has already worked out where the clip goes.
    #[serde(default)]
    pub start_time_override: Option<MediaTime>,
    #[serde(default)]
    pub exclude_element_id: Option<String>,
    /// Element types this drag lands *on* rather than beside. Empty or absent
    /// means the drag targets track space.
    #[serde(default)]
    pub target_element_types: Option<Vec<String>>,
    #[serde(default)]
    pub source_track_id: Option<String>,
}

/// Resolves a drag to the row and time it would land at.
///
/// Always answers: the pointer is still down, so the indicator has to be
/// somewhere even when nothing will accept the element.
#[export]
pub fn compute_drop_target(
    DropTargetOptions {
        element_type,
        mouse_x,
        mouse_y,
        tracks,
        playhead_time,
        is_external_drop,
        element_duration,
        pixels_per_second,
        zoom_level,
        vertical_drag_direction,
        start_time_override,
        exclude_element_id,
        target_element_types,
        source_track_id,
    }: DropTargetOptions,
) -> DropTarget {
    let list = ordered_tracks(&tracks);
    let x_position = match start_time_override {
        Some(time) => time,
        None if is_external_drop => playhead_time,
        None => {
            let seconds = (mouse_x / (pixels_per_second * zoom_level)).max(0.0);
            MediaTime::from_ticks(js_round(seconds * TICKS_PER_SECOND as f64) as i64)
        }
    };

    if list.is_empty() {
        // Unreachable through a well-formed `SceneTracks`, which always carries
        // a main track; kept because the drop resolver must never depend on
        // that invariant holding at the boundary. `create_new_track_only` stops
        // placement from inventing a reuse when there is nothing to reuse.
        return new_track_target(
            resolve(
                &tracks,
                element_type,
                x_position,
                element_duration,
                exclude_element_id,
                PlacementStrategy::PreferIndex {
                    track_index: 0,
                    hover_direction: InsertPosition::Below,
                    vertical_drag_direction: None,
                    create_new_track_only: Some(true),
                },
                source_track_id,
            ),
            x_position,
        );
    }

    let Some(TrackAtY {
        track_index,
        relative_y,
    }) = track_at_y(&list, mouse_y, vertical_drag_direction)
    else {
        // Off the top or off the bottom of the stack: a new track at whichever
        // end the pointer left by.
        let is_above_all_tracks = mouse_y < 0.0;
        return new_track_target(
            resolve(
                &tracks,
                element_type,
                x_position,
                element_duration,
                exclude_element_id,
                PlacementStrategy::PreferIndex {
                    track_index: if is_above_all_tracks {
                        0
                    } else {
                        list.len() as i64 - 1
                    },
                    hover_direction: if is_above_all_tracks {
                        InsertPosition::Above
                    } else {
                        InsertPosition::Below
                    },
                    vertical_drag_direction: None,
                    create_new_track_only: Some(true),
                },
                source_track_id,
            ),
            x_position,
        );
    };

    let track = list[track_index];

    if let Some(types) = target_element_types.as_deref().filter(|t| !t.is_empty()) {
        if let Some(target_element) =
            element_at_position(track, mouse_x, types, pixels_per_second, zoom_level)
        {
            return DropTarget {
                track_index: track_index as i64,
                is_new_track: false,
                insert_position: None,
                x_position,
                target_element: Some(target_element),
                seam_time: None,
            };
        }
    }

    let track_height = track_height_px(track);
    let placement = resolve(
        &tracks,
        element_type,
        x_position,
        element_duration,
        exclude_element_id,
        PlacementStrategy::PreferIndex {
            track_index: track_index as i64,
            // The upper half of a row asks for a track above it, the lower half
            // for one below.
            hover_direction: if relative_y < track_height / 2.0 {
                InsertPosition::Above
            } else {
                InsertPosition::Below
            },
            vertical_drag_direction,
            create_new_track_only: None,
        },
        source_track_id,
    );

    match placement {
        None => fallback_new_track(x_position),
        Some(PlacementResult::ExistingTrack { track_index, .. }) => DropTarget {
            track_index,
            is_new_track: false,
            insert_position: None,
            x_position,
            target_element: None,
            seam_time: None,
        },
        Some(PlacementResult::NewTrack {
            insert_index,
            insert_position,
            ..
        }) => DropTarget {
            track_index: insert_index,
            is_new_track: true,
            insert_position,
            x_position,
            target_element: None,
            seam_time: None,
        },
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DropTargetLineOptions {
    pub drop_target: DropTarget,
    /// The same ordered list the drop target's index refers to.
    pub tracks: Vec<Track>,
}

/// Top edge, in CSS pixels, of the line drawn where a new track would appear.
///
/// An index one past the last track is legal and lands below everything, which
/// is how "append at the bottom" draws.
#[export]
pub fn get_drop_line_y(DropTargetLineOptions { drop_target, tracks }: DropTargetLineOptions) -> f64 {
    let safe_track_index = drop_target.track_index.max(0).min(tracks.len() as i64) as usize;

    // `fold` from `0.0` rather than `.sum()`: Rust's `Sum for f64` folds from
    // `-0.0`, so an empty run answers `-0.0` where the TypeScript's `let y = 0`
    // answers `+0`. A drop above the first track is exactly that empty run, and
    // it is the common case.
    tracks
        .iter()
        .take(safe_track_index)
        .map(|track| track_height_px(track) + TIMELINE_TRACK_GAP_PX)
        .fold(0.0, |total, height| total + height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ElementKind, TimelineElement};
    use std::collections::HashMap;

    fn element(id: &str, start: i64, duration: i64, kind: ElementKind) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: MediaTime::from_ticks(duration),
            start_time: MediaTime::from_ticks(start),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            animations: None,
            params: HashMap::new(),
            group_id: None,
            kind,
        }
    }

    fn video_element(id: &str, start: i64, duration: i64) -> TimelineElement {
        element(
            id,
            start,
            duration,
            ElementKind::Video {
                media_id: "media".to_string(),
                is_source_audio_enabled: None,
                hidden: None,
                retime: None,
                freeze: None,
                effects: None,
                masks: None,
                transition_in: None,
                fade: None,
            },
        )
    }

    fn text_element(id: &str, start: i64, duration: i64) -> TimelineElement {
        element(
            id,
            start,
            duration,
            ElementKind::Text {
                hidden: None,
                fade: None,
            },
        )
    }

    fn video_track(id: &str, elements: Vec<TimelineElement>) -> Track {
        Track::Video {
            id: id.to_string(),
            name: id.to_string(),
            elements,
            muted: false,
            hidden: false,
        }
    }

    fn text_track(id: &str, elements: Vec<TimelineElement>) -> Track {
        Track::Text {
            id: id.to_string(),
            name: id.to_string(),
            elements,
            hidden: false,
        }
    }

    fn audio_track(id: &str) -> Track {
        Track::Audio {
            id: id.to_string(),
            name: id.to_string(),
            elements: vec![],
            muted: false,
        }
    }

    fn scene(overlay: Vec<Track>, main: Track, audio: Vec<Track>) -> SceneTracks {
        SceneTracks {
            overlay,
            main,
            audio,
        }
    }

    /// 50 px/s at zoom 1 is the timeline's base, so one second is 50 px and one
    /// tick is 50/120000 px.
    const PIXELS_PER_SECOND: f64 = 50.0;

    fn options(tracks: SceneTracks, mouse_x: f64, mouse_y: f64) -> DropTargetOptions {
        DropTargetOptions {
            element_type: ElementType::Video,
            mouse_x,
            mouse_y,
            tracks,
            playhead_time: MediaTime::ZERO,
            is_external_drop: false,
            element_duration: MediaTime::from_ticks(TICKS_PER_SECOND),
            pixels_per_second: PIXELS_PER_SECOND,
            zoom_level: 1.0,
            vertical_drag_direction: None,
            start_time_override: None,
            exclude_element_id: None,
            target_element_types: None,
            source_track_id: None,
        }
    }

    #[test]
    fn a_drop_on_empty_track_space_reuses_that_track() {
        // One overlay video track (65 px) above the main video track.
        let tracks = scene(
            vec![video_track("overlay", vec![])],
            video_track("main", vec![]),
            vec![],
        );
        // 10 px in, 20 px down: inside the overlay row, upper half.
        let target = compute_drop_target(options(tracks, 10.0, 20.0));

        assert_eq!(target.track_index, 0);
        assert!(!target.is_new_track);
        assert_eq!(target.insert_position, None);
        assert_eq!(target.target_element, None);
        // 10 px at 50 px/s is 0.2 s.
        assert_eq!(target.x_position, MediaTime::from_ticks(24_000));
    }

    #[test]
    fn a_drop_over_an_occupied_region_opens_a_new_track() {
        // The overlay track is busy for its first two seconds, and the drag
        // carries a one-second clip starting at zero.
        let tracks = scene(
            vec![video_track(
                "overlay",
                vec![video_element("busy", 0, 2 * TICKS_PER_SECOND)],
            )],
            video_track("main", vec![]),
            vec![],
        );
        let target = compute_drop_target(options(tracks, 10.0, 20.0));

        assert!(target.is_new_track);
        assert_eq!(target.insert_position, Some(InsertPosition::Above));
        assert_eq!(target.track_index, 0);
    }

    #[test]
    fn an_occupied_region_is_free_again_once_the_dragged_clip_is_excluded() {
        let tracks = scene(
            vec![video_track(
                "overlay",
                vec![video_element("busy", 0, 2 * TICKS_PER_SECOND)],
            )],
            video_track("main", vec![]),
            vec![],
        );
        let mut params = options(tracks, 10.0, 20.0);
        params.exclude_element_id = Some("busy".to_string());
        let target = compute_drop_target(params);

        assert!(!target.is_new_track);
        assert_eq!(target.track_index, 0);
    }

    #[test]
    fn the_gap_between_two_tracks_resolves_only_while_dragging_vertically() {
        let tracks = scene(
            vec![video_track("overlay", vec![])],
            video_track("main", vec![]),
            vec![],
        );
        // The gap runs from 65 px to 71 px.
        let in_the_gap = 67.0;

        // With no drag direction the pointer is over nothing, which sends the
        // drop off the bottom of the stack.
        let no_direction = compute_drop_target(options(tracks.clone(), 10.0, in_the_gap));
        assert!(no_direction.is_new_track);

        let mut upward = options(tracks.clone(), 10.0, in_the_gap);
        upward.vertical_drag_direction = Some(VerticalDragDirection::Up);
        let upward = compute_drop_target(upward);
        assert_eq!(upward.track_index, 0);
        assert!(!upward.is_new_track);

        let mut downward = options(tracks, 10.0, in_the_gap);
        downward.vertical_drag_direction = Some(VerticalDragDirection::Down);
        let downward = compute_drop_target(downward);
        assert_eq!(downward.track_index, 1);
        assert!(!downward.is_new_track);
    }

    #[test]
    fn a_pointer_above_every_track_asks_for_a_track_at_the_top() {
        let tracks = scene(vec![], video_track("main", vec![]), vec![]);
        let target = compute_drop_target(options(tracks, 10.0, -20.0));

        assert!(target.is_new_track);
        assert_eq!(target.insert_position, Some(InsertPosition::Above));
        assert_eq!(target.track_index, 0);
    }

    #[test]
    fn an_element_type_the_track_cannot_hold_never_reuses_it() {
        // A text element dragged over a video row: the row is empty, but the
        // types do not pair, so the answer has to be a new track.
        let tracks = scene(
            vec![video_track("overlay", vec![])],
            video_track("main", vec![]),
            vec![],
        );
        let mut params = options(tracks, 10.0, 20.0);
        params.element_type = ElementType::Text;
        let target = compute_drop_target(params);

        assert!(target.is_new_track);
    }

    #[test]
    fn audio_never_lands_on_a_video_row_even_when_the_pointer_is_over_one() {
        let tracks = scene(
            vec![],
            video_track("main", vec![]),
            vec![audio_track("audio")],
        );
        // The pointer is over the main video row, but audio may only live below
        // it, so the drop is redirected to a new track on the far side.
        let mut params = options(tracks, 10.0, 10.0);
        params.element_type = ElementType::Audio;
        let target = compute_drop_target(params);

        assert!(target.is_new_track);
        assert_eq!(target.track_index, 1);
        assert_eq!(target.insert_position, Some(InsertPosition::Below));
    }

    #[test]
    fn a_drag_that_targets_clips_names_the_clip_under_the_pointer() {
        let tracks = scene(
            vec![video_track(
                "overlay",
                vec![
                    video_element("first", 0, TICKS_PER_SECOND),
                    video_element("second", TICKS_PER_SECOND, TICKS_PER_SECOND),
                ],
            )],
            video_track("main", vec![]),
            vec![],
        );
        // 60 px is 1.2 s, inside "second".
        let mut params = options(tracks.clone(), 60.0, 20.0);
        params.element_type = ElementType::Effect;
        params.target_element_types = Some(vec!["video".to_string()]);
        let target = compute_drop_target(params);

        assert_eq!(
            target.target_element,
            Some(DropTargetElement {
                track_id: "overlay".to_string(),
                element_id: "second".to_string(),
            })
        );
        assert!(!target.is_new_track);

        // The same pointer, but nothing on the track is of a wanted type.
        let mut wrong_type = options(tracks, 60.0, 20.0);
        wrong_type.element_type = ElementType::Effect;
        wrong_type.target_element_types = Some(vec!["text".to_string()]);
        assert_eq!(compute_drop_target(wrong_type).target_element, None);
    }

    #[test]
    fn a_text_drag_over_a_text_row_reuses_it() {
        let tracks = scene(
            vec![text_track("titles", vec![text_element("t1", 0, 1_000)])],
            video_track("main", vec![]),
            vec![],
        );
        let mut params = options(tracks, 400.0, 10.0);
        params.element_type = ElementType::Text;
        let target = compute_drop_target(params);

        assert!(!target.is_new_track);
        assert_eq!(target.track_index, 0);
    }

    fn paired_video_track(id: &str) -> Track {
        // Two abutting one-second video clips share a cut at t = 1 s.
        video_track(
            id,
            vec![
                video_element("a", 0, TICKS_PER_SECOND),
                video_element("b", TICKS_PER_SECOND, TICKS_PER_SECOND),
            ],
        )
    }

    #[test]
    fn a_transition_drop_snaps_to_the_cut_it_is_near() {
        let tracks = scene(vec![paired_video_track("overlay")], video_track("main", vec![]), vec![]);
        // The cut sits at 1 s, which is 50 px at the base scale.
        let target = compute_transition_drop_target(DropTargetTransitionOptions {
            mouse_x: 60.0,
            mouse_y: 20.0,
            tracks,
            pixels_per_second: PIXELS_PER_SECOND,
            zoom_level: 1.0,
        })
        .target
        .expect("within the snap radius");

        assert_eq!(target.x_position, MediaTime::from_ticks(TICKS_PER_SECOND));
        assert_eq!(target.seam_time, Some(MediaTime::from_ticks(TICKS_PER_SECOND)));
        assert_eq!(
            target.target_element,
            Some(DropTargetElement {
                track_id: "overlay".to_string(),
                element_id: "b".to_string(),
            })
        );
        assert!(!target.is_new_track);
    }

    #[test]
    fn a_transition_drop_away_from_every_cut_resolves_to_nothing() {
        let tracks = scene(vec![paired_video_track("overlay")], video_track("main", vec![]), vec![]);
        // 200 px is 150 px past the only cut, well outside the 28 px radius.
        let far = compute_transition_drop_target(DropTargetTransitionOptions {
            mouse_x: 200.0,
            mouse_y: 20.0,
            tracks: tracks.clone(),
            pixels_per_second: PIXELS_PER_SECOND,
            zoom_level: 1.0,
        });
        assert_eq!(far.target, None);

        // A track with no cuts at all, and a pointer off the stack entirely.
        let empty = compute_transition_drop_target(DropTargetTransitionOptions {
            mouse_x: 50.0,
            mouse_y: 5_000.0,
            tracks,
            pixels_per_second: PIXELS_PER_SECOND,
            zoom_level: 1.0,
        });
        assert_eq!(empty.target, None);
    }

    #[test]
    fn a_transition_drop_needs_a_positive_scale() {
        let tracks = scene(vec![paired_video_track("overlay")], video_track("main", vec![]), vec![]);
        let target = compute_transition_drop_target(DropTargetTransitionOptions {
            mouse_x: 50.0,
            mouse_y: 20.0,
            tracks,
            pixels_per_second: 0.0,
            zoom_level: 1.0,
        });

        assert_eq!(target.target, None);
    }

    #[test]
    fn a_drop_above_the_first_row_sits_at_positive_zero() {
        // Not merely `== 0.0`: `-0.0` compares equal to `0.0` and would slip
        // through. The TypeScript answers `+0` here, and the parity harness
        // compares zeroes with `Object.is`, so the sign is the whole assertion.
        let line_y = get_drop_line_y(DropTargetLineOptions {
            drop_target: DropTarget {
                track_index: 0,
                is_new_track: true,
                insert_position: None,
                x_position: MediaTime::ZERO,
                target_element: None,
                seam_time: None,
            },
            tracks: vec![video_track("v", vec![])],
        });
        assert!(line_y.is_sign_positive(), "expected +0, got {line_y}");
    }

    #[test]
    fn the_drop_line_sits_at_the_top_of_the_named_row() {
        let tracks = vec![
            video_track("v", vec![]),
            text_track("t", vec![]),
            video_track("main", vec![]),
        ];
        let line = |index: i64| {
            get_drop_line_y(DropTargetLineOptions {
                drop_target: DropTarget {
                    track_index: index,
                    is_new_track: true,
                    insert_position: None,
                    x_position: MediaTime::ZERO,
                    target_element: None,
                    seam_time: None,
                },
                tracks: tracks.clone(),
            })
        };

        assert_eq!(line(0), 0.0);
        assert_eq!(line(1), 65.0 + TIMELINE_TRACK_GAP_PX);
        // One past the last track is the "append below everything" position.
        assert_eq!(
            line(3),
            65.0 + TIMELINE_TRACK_GAP_PX + 25.0 + TIMELINE_TRACK_GAP_PX + 65.0
                + TIMELINE_TRACK_GAP_PX
        );
        // Out of range in either direction clamps rather than panicking.
        assert_eq!(line(-4), 0.0);
        assert_eq!(line(99), line(3));
    }

    #[test]
    fn an_external_drop_lands_at_the_playhead_and_an_override_beats_both() {
        let tracks = scene(
            vec![video_track("overlay", vec![])],
            video_track("main", vec![]),
            vec![],
        );

        let mut external = options(tracks.clone(), 500.0, 20.0);
        external.is_external_drop = true;
        external.playhead_time = MediaTime::from_ticks(7_000);
        assert_eq!(
            compute_drop_target(external).x_position,
            MediaTime::from_ticks(7_000)
        );

        let mut overridden = options(tracks, 500.0, 20.0);
        overridden.is_external_drop = true;
        overridden.playhead_time = MediaTime::from_ticks(7_000);
        overridden.start_time_override = Some(MediaTime::from_ticks(11));
        assert_eq!(
            compute_drop_target(overridden).x_position,
            MediaTime::from_ticks(11)
        );
    }

    #[test]
    fn a_pointer_left_of_zero_clamps_the_drop_time() {
        let tracks = scene(
            vec![video_track("overlay", vec![])],
            video_track("main", vec![]),
            vec![],
        );
        assert_eq!(
            compute_drop_target(options(tracks, -200.0, 20.0)).x_position,
            MediaTime::ZERO
        );
    }
}
