//! Which track something lands on — never when.
//!
//! A track takes an element wherever the caller asked for it, so long as nothing
//! is already there. The main track is no exception: it is free to start with a
//! gap like any other.

use bridge::export;
use serde::{Deserialize, Serialize};
use time::MediaTime;

use crate::model::{ElementKind, SceneTracks, TimelineElement, Track};

pub const MAIN_TRACK_NAME: &str = "Main Track";

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrackType {
    Video,
    Text,
    Audio,
    Graphic,
    Effect,
    Adjustment,
}

impl TrackType {
    pub fn default_name(self) -> &'static str {
        match self {
            TrackType::Video => "Video track",
            TrackType::Text => "Text track",
            TrackType::Audio => "Audio track",
            TrackType::Graphic => "Graphic track",
            TrackType::Effect => "Effect track",
            TrackType::Adjustment => "Adjustment track",
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ElementType {
    Video,
    Image,
    Audio,
    Text,
    Sticker,
    Graphic,
    Effect,
    Adjustment,
}

impl ElementType {
    /// Which kind of track holds this kind of element. Images ride on video
    /// tracks and stickers on graphic ones; everything else pairs by name.
    pub fn track_type(self) -> TrackType {
        match self {
            ElementType::Video | ElementType::Image => TrackType::Video,
            ElementType::Audio => TrackType::Audio,
            ElementType::Text => TrackType::Text,
            ElementType::Sticker | ElementType::Graphic => TrackType::Graphic,
            ElementType::Effect => TrackType::Effect,
            ElementType::Adjustment => TrackType::Adjustment,
        }
    }
}

fn track_type_of(track: &Track) -> TrackType {
    match track {
        Track::Video { .. } => TrackType::Video,
        Track::Text { .. } => TrackType::Text,
        Track::Audio { .. } => TrackType::Audio,
        Track::Graphic { .. } => TrackType::Graphic,
        Track::Effect { .. } => TrackType::Effect,
        Track::Adjustment { .. } => TrackType::Adjustment,
    }
}

fn element_type_of(kind: &ElementKind) -> ElementType {
    match kind {
        ElementKind::Video { .. } => ElementType::Video,
        ElementKind::Image { .. } => ElementType::Image,
        ElementKind::Audio { .. } => ElementType::Audio,
        ElementKind::Text { .. } => ElementType::Text,
        ElementKind::Sticker { .. } => ElementType::Sticker,
        ElementKind::Graphic { .. } => ElementType::Graphic,
        ElementKind::Effect { .. } => ElementType::Effect,
        ElementKind::Adjustment { .. } => ElementType::Adjustment,
    }
}

/// Tracks in the order the timeline shows them: overlays above, the main track,
/// then audio below. Placement indices are indices into this list, not into any
/// one of the three collections.
fn ordered(tracks: &SceneTracks) -> Vec<&Track> {
    let mut list: Vec<&Track> = tracks.overlay.iter().collect();
    list.push(&tracks.main);
    list.extend(tracks.audio.iter());
    list
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlacementTimeSpan {
    pub start_time: MediaTime,
    pub duration: MediaTime,
    /// An element already on the track that should not count as an obstacle —
    /// the one being moved, when a move is being tested against its own track.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_element_id: Option<String>,
}

fn spans_fit(track: &Track, spans: &[PlacementTimeSpan]) -> bool {
    spans_fit_elements(track.elements(), spans)
}

/// The same check against a bare element list, for callers holding the elements
/// that will *stay* on a track rather than the track itself — a group move tests
/// its members against everything except the members themselves.
pub(super) fn spans_fit_elements(
    elements: &[TimelineElement],
    spans: &[PlacementTimeSpan],
) -> bool {
    spans.iter().all(|span| {
        let start = span.start_time.as_ticks();
        let end = start + span.duration.as_ticks();
        !elements.iter().any(|element| {
            if span
                .exclude_element_id
                .as_deref()
                .is_some_and(|id| id == element.id)
            {
                return false;
            }
            let element_start = element.start_time.as_ticks();
            let element_end = element_start + element.duration.as_ticks();
            // Half-open: touching at an edge is not overlapping.
            start < element_end && end > element_start
        })
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InsertPosition {
    Above,
    Below,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VerticalDragDirection {
    Up,
    Down,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NewTrackPosition {
    Highest,
    Default,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PlacementStrategy {
    /// This track or nothing.
    Explicit { track_id: String },
    /// The topmost compatible track with room; a new one if none has any.
    FirstAvailable,
    /// Near where the pointer is, making a track if that spot is taken.
    PreferIndex {
        track_index: i64,
        hover_direction: InsertPosition,
        #[serde(default)]
        vertical_drag_direction: Option<VerticalDragDirection>,
        #[serde(default)]
        create_new_track_only: Option<bool>,
    },
    /// Immediately above where it came from — how a lifted clip finds a home.
    AboveSource { source_track_index: i64 },
    AlwaysNew { position: NewTrackPosition },
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PlacementResult {
    ExistingTrack {
        track_id: String,
        track_index: i64,
        track_type: TrackType,
    },
    NewTrack {
        insert_index: i64,
        insert_position: Option<InsertPosition>,
        track_type: TrackType,
    },
}

/// Where a brand-new track of this type goes when nobody said where.
///
/// Effects sit at the very top so they cover everything beneath; audio goes
/// below the main track; everything else lands just above it.
fn default_insert_index(tracks: &SceneTracks, track_type: TrackType) -> i64 {
    let overlay = tracks.overlay.len() as i64;
    match track_type {
        TrackType::Audio => overlay + 1 + tracks.audio.len() as i64,
        TrackType::Effect => 0,
        _ => overlay,
    }
}

/// The highest position this type may occupy.
fn highest_insert_index(tracks: &SceneTracks, track_type: TrackType) -> i64 {
    match track_type {
        TrackType::Audio => tracks.overlay.len() as i64 + 1,
        _ => 0,
    }
}

struct PreferredPlacement {
    insert_index: i64,
    insert_position: Option<InsertPosition>,
    /// True when the asked-for spot was on the wrong side of the main track and
    /// had to be moved. The caller uses this to prefer staying put over
    /// spawning a track somewhere the user did not point at.
    was_redirected: bool,
}

/// A new track near `preferred_index`, kept on the correct side of the main
/// track: audio below it, everything else above.
fn preferred_new_track(
    tracks: &SceneTracks,
    track_type: TrackType,
    preferred_index: i64,
    direction: InsertPosition,
) -> PreferredPlacement {
    let track_count = tracks.overlay.len() as i64 + 1 + tracks.audio.len() as i64;
    let main_index = tracks.overlay.len() as i64;
    let safe_index = preferred_index.max(0).min(track_count - 1);

    if track_type == TrackType::Audio {
        if safe_index <= main_index {
            return PreferredPlacement {
                insert_index: main_index + 1,
                insert_position: Some(InsertPosition::Below),
                was_redirected: true,
            };
        }
        return PreferredPlacement {
            insert_index: match direction {
                InsertPosition::Above => safe_index,
                InsertPosition::Below => safe_index + 1,
            },
            insert_position: Some(direction),
            was_redirected: false,
        };
    }

    let insert_index = match direction {
        InsertPosition::Above => safe_index,
        InsertPosition::Below => safe_index + 1,
    };
    if insert_index > main_index {
        return PreferredPlacement {
            insert_index: main_index,
            insert_position: Some(InsertPosition::Above),
            was_redirected: true,
        };
    }

    PreferredPlacement {
        insert_index,
        insert_position: Some(direction),
        was_redirected: false,
    }
}

fn first_available(
    tracks: &[&Track],
    track_type: TrackType,
    spans: &[PlacementTimeSpan],
) -> Option<usize> {
    tracks
        .iter()
        .position(|track| track_type_of(track) == track_type && spans_fit(track, spans))
}

fn existing(track: &Track, index: usize) -> PlacementResult {
    PlacementResult::ExistingTrack {
        track_id: track.id().to_string(),
        track_index: index as i64,
        track_type: track_type_of(track),
    }
}

/// A drag that is still moving overrides where the pointer happens to hover:
/// the direction of travel is the better guess at intent.
fn insert_direction(
    hover: InsertPosition,
    dragging: Option<VerticalDragDirection>,
) -> InsertPosition {
    match dragging {
        Some(VerticalDragDirection::Up) => InsertPosition::Above,
        Some(VerticalDragDirection::Down) => InsertPosition::Below,
        None => hover,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePlacementOptions {
    pub tracks: SceneTracks,
    pub time_spans: Vec<PlacementTimeSpan>,
    pub strategy: PlacementStrategy,
    /// Either the element type being placed or the track type wanted directly.
    #[serde(default)]
    pub element_type: Option<ElementType>,
    #[serde(default)]
    pub track_type: Option<TrackType>,
    #[serde(default)]
    pub source_track_id: Option<String>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlacement {
    /// `None` when the strategy named a track that does not exist or cannot
    /// hold this element.
    pub placement: Option<PlacementResult>,
}

#[export]
pub fn resolve_track_placement(
    ResolvePlacementOptions {
        tracks,
        time_spans,
        strategy,
        element_type,
        track_type,
        source_track_id,
    }: ResolvePlacementOptions,
) -> ResolvedPlacement {
    let Some(wanted) = track_type.or_else(|| element_type.map(ElementType::track_type)) else {
        return ResolvedPlacement { placement: None };
    };
    let list = ordered(&tracks);
    let always_new = |position: NewTrackPosition| PlacementResult::NewTrack {
        insert_index: match position {
            NewTrackPosition::Highest => highest_insert_index(&tracks, wanted),
            NewTrackPosition::Default => default_insert_index(&tracks, wanted),
        },
        insert_position: None,
        track_type: wanted,
    };

    let placement = match strategy {
        PlacementStrategy::Explicit { track_id } => list
            .iter()
            .position(|track| track.id() == track_id)
            .filter(|index| track_type_of(list[*index]) == wanted)
            .map(|index| existing(list[index], index)),

        PlacementStrategy::FirstAvailable => Some(
            first_available(&list, wanted, &time_spans)
                .map(|index| existing(list[index], index))
                .unwrap_or_else(|| always_new(NewTrackPosition::Highest)),
        ),

        PlacementStrategy::PreferIndex {
            track_index,
            hover_direction,
            vertical_drag_direction,
            create_new_track_only,
        } => {
            let preferred = usize::try_from(track_index)
                .ok()
                .and_then(|index| list.get(index).map(|track| (index, *track)));
            let compatible = preferred
                .is_some_and(|(_, track)| track_type_of(track) == wanted);

            let can_reuse = create_new_track_only != Some(true)
                && compatible
                && preferred.is_some_and(|(_, track)| spans_fit(track, &time_spans));
            if can_reuse {
                let (index, track) = preferred.expect("checked");
                Some(existing(track, index))
            } else {
                let placement = preferred_new_track(
                    &tracks,
                    wanted,
                    track_index,
                    insert_direction(
                        hover_direction,
                        // A pointer over an incompatible track says nothing
                        // useful about intent, so the drag direction is only
                        // consulted then.
                        if compatible {
                            None
                        } else {
                            vertical_drag_direction
                        },
                    ),
                );

                // Rather than open a track on the far side of the timeline from
                // where the user pointed, stay on the track it came from.
                let stayed = placement
                    .was_redirected
                    .then(|| source_track_id.as_deref())
                    .flatten()
                    .and_then(|source| {
                        list.iter().position(|track| {
                            track.id() == source && track_type_of(track) == wanted
                        })
                    })
                    .map(|index| existing(list[index], index));

                Some(stayed.unwrap_or(PlacementResult::NewTrack {
                    insert_index: placement.insert_index,
                    insert_position: placement.insert_position,
                    track_type: wanted,
                }))
            }
        }

        PlacementStrategy::AboveSource { source_track_index } => {
            let above = usize::try_from(source_track_index - 1)
                .ok()
                .and_then(|index| list.get(index).map(|track| (index, *track)))
                .filter(|(_, track)| {
                    track_type_of(track) == wanted && spans_fit(track, &time_spans)
                });

            Some(match above {
                Some((index, track)) => existing(track, index),
                None => first_available(&list, wanted, &time_spans)
                    .map(|index| existing(list[index], index))
                    .unwrap_or_else(|| always_new(NewTrackPosition::Highest)),
            })
        }

        PlacementStrategy::AlwaysNew { position } => Some(always_new(position)),
    };

    ResolvedPlacement { placement }
}

fn empty_track(id: String, track_type: TrackType, name: Option<String>) -> Track {
    let name = name.unwrap_or_else(|| track_type.default_name().to_string());
    match track_type {
        TrackType::Video => Track::Video {
            id,
            name,
            elements: vec![],
            muted: false,
            hidden: false,
        },
        TrackType::Text => Track::Text {
            id,
            name,
            elements: vec![],
            hidden: false,
        },
        TrackType::Audio => Track::Audio {
            id,
            name,
            elements: vec![],
            muted: false,
        },
        TrackType::Graphic => Track::Graphic {
            id,
            name,
            elements: vec![],
            hidden: false,
        },
        TrackType::Effect => Track::Effect {
            id,
            name,
            elements: vec![],
            hidden: false,
        },
        TrackType::Adjustment => Track::Adjustment {
            id,
            name,
            elements: vec![],
            hidden: false,
        },
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildEmptyTrackOptions {
    pub id: String,
    #[serde(rename = "type")]
    pub track_type: TrackType,
    #[serde(default)]
    pub name: Option<String>,
}

#[export]
pub fn build_empty_track(
    BuildEmptyTrackOptions {
        id,
        track_type,
        name,
    }: BuildEmptyTrackOptions,
) -> Track {
    empty_track(id, track_type, name)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlacementOptions {
    pub tracks: SceneTracks,
    pub placement_result: PlacementResult,
    pub elements: Vec<TimelineElement>,
    /// The caller may pin the new track's position — used when several
    /// placements in one gesture have to land in a known order.
    #[serde(default)]
    pub new_track_insert_index_override: Option<i64>,
    /// Id for a track this may have to create.
    pub new_track_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedPlacement {
    pub updated_tracks: Option<SceneTracks>,
    pub target_track_id: Option<String>,
}

/// Put the elements where placement said, creating the track if that is what it
/// said. `updatedTracks` is absent when the named track has gone missing since
/// the placement was resolved.
#[export]
pub fn apply_placement(
    ApplyPlacementOptions {
        tracks,
        placement_result,
        elements,
        new_track_insert_index_override,
        new_track_id,
    }: ApplyPlacementOptions,
) -> AppliedPlacement {
    match placement_result {
        PlacementResult::ExistingTrack { track_index, .. } => {
            let Ok(index) = usize::try_from(track_index) else {
                return AppliedPlacement {
                    updated_tracks: None,
                    target_track_id: None,
                };
            };
            let Some(target_id) = ordered(&tracks)
                .get(index)
                .map(|track| track.id().to_string())
            else {
                return AppliedPlacement {
                    updated_tracks: None,
                    target_track_id: None,
                };
            };

            let append = |track: &Track| -> Track {
                if track.id() != target_id {
                    return track.clone();
                }
                let mut next = track.elements().to_vec();
                next.extend(elements.iter().cloned());
                track.with_elements(next)
            };

            AppliedPlacement {
                updated_tracks: Some(SceneTracks {
                    overlay: tracks.overlay.iter().map(append).collect(),
                    main: append(&tracks.main),
                    audio: tracks.audio.iter().map(append).collect(),
                }),
                target_track_id: Some(target_id),
            }
        }

        PlacementResult::NewTrack {
            insert_index,
            track_type,
            ..
        } => {
            let insert_index = new_track_insert_index_override.unwrap_or(insert_index);
            let track = empty_track(new_track_id.clone(), track_type, None)
                .with_elements(elements);
            let mut next = tracks.clone();

            if track_type == TrackType::Audio {
                // Audio indices are timeline-wide, so shift into the audio
                // collection's own coordinates before inserting.
                let local = (insert_index - tracks.overlay.len() as i64 - 1)
                    .max(0)
                    .min(tracks.audio.len() as i64) as usize;
                next.audio.insert(local, track);
            } else {
                let local = insert_index.max(0).min(tracks.overlay.len() as i64) as usize;
                next.overlay.insert(local, track);
            }

            AppliedPlacement {
                updated_tracks: Some(next),
                target_track_id: Some(new_track_id),
            }
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MakeRoomOptions {
    pub tracks: SceneTracks,
    pub track_id: String,
    pub element: TimelineElement,
}

/// Slides the clips after `element` along, far enough that a clip which has just
/// grown does not sit on top of its neighbour.
///
/// A speed change is the case that needs this: it derives a new length from the
/// material the clip holds, so slowing a clip down makes it longer without
/// anyone having dragged an edge. Resizing has a neighbour to stop against, but
/// a speed has to be honoured — the clip is as long as its own footage says, so
/// the timeline is what gives way.
///
/// Only the overlap is taken up, never the whole growth: clips further down the
/// track keep the spacing they were given. A clip that *shrinks* leaves a gap
/// rather than dragging its neighbours back — closing gaps is ripple editing's
/// job, and that is a setting the user turns on.
#[export]
pub fn shift_elements_clear_of_element(
    MakeRoomOptions {
        tracks,
        track_id,
        element,
    }: MakeRoomOptions,
) -> SceneTracks {
    let element_end = element.start_time.as_ticks() + element.duration.as_ticks();

    let update = |track: &Track| -> Track {
        if track.id() != track_id {
            return track.clone();
        }

        let first_following = track
            .elements()
            .iter()
            .filter(|candidate| {
                candidate.id != element.id
                    && candidate.start_time.as_ticks() > element.start_time.as_ticks()
            })
            .map(|candidate| candidate.start_time.as_ticks())
            .min();

        let Some(first_following) = first_following.filter(|start| *start < element_end) else {
            return track.clone();
        };

        let shift = element_end - first_following;
        let elements = track
            .elements()
            .iter()
            .map(|candidate| {
                if candidate.id != element.id
                    && candidate.start_time.as_ticks() >= first_following
                {
                    let mut moved = candidate.clone();
                    moved.start_time =
                        MediaTime::from_ticks(candidate.start_time.as_ticks() + shift);
                    moved
                } else {
                    candidate.clone()
                }
            })
            .collect();
        track.with_elements(elements)
    };

    SceneTracks {
        overlay: tracks.overlay.iter().map(update).collect(),
        main: update(&tracks.main),
        audio: tracks.audio.iter().map(update).collect(),
    }
}

/// Whether this element may sit on this track at all.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityOptions {
    pub element_type: ElementType,
    pub track_type: TrackType,
}

#[export]
pub fn can_element_go_on_track(
    CompatibilityOptions {
        element_type,
        track_type,
    }: CompatibilityOptions,
) -> bool {
    element_type.track_type() == track_type
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementTypeOptions {
    pub element_type: ElementType,
}

#[export]
pub fn get_track_type_for_element_type(
    ElementTypeOptions { element_type }: ElementTypeOptions,
) -> TrackType {
    element_type.track_type()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityVerdict {
    pub is_valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// The same check as [`can_element_go_on_track`], but carrying the sentence a
/// caller can show when it fails.
#[export]
pub fn validate_element_track_compatibility(
    CompatibilityOptions {
        element_type,
        track_type,
    }: CompatibilityOptions,
) -> CompatibilityVerdict {
    if element_type.track_type() == track_type {
        return CompatibilityVerdict {
            is_valid: true,
            error_message: None,
        };
    }
    CompatibilityVerdict {
        is_valid: false,
        error_message: Some(format!(
            "{} elements cannot be placed on {} tracks",
            serde_json::to_value(element_type)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default(),
            serde_json::to_value(track_type)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default(),
        )),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InsertIndexOptions {
    pub tracks: SceneTracks,
    pub track_type: TrackType,
}

#[export]
pub fn get_default_insert_index_for_track(
    InsertIndexOptions { tracks, track_type }: InsertIndexOptions,
) -> f64 {
    default_insert_index(&tracks, track_type) as f64
}

#[export]
pub fn get_highest_insert_index_for_track(
    InsertIndexOptions { tracks, track_type }: InsertIndexOptions,
) -> f64 {
    highest_insert_index(&tracks, track_type) as f64
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CanPlaceOptions {
    pub track: Track,
    pub time_spans: Vec<PlacementTimeSpan>,
}

/// Whether every one of these spans is free on this track.
#[export]
pub fn can_place_time_spans_on_track(
    CanPlaceOptions { track, time_spans }: CanPlaceOptions,
) -> bool {
    spans_fit(&track, &time_spans)
}

/// The element type of an actual element, for callers holding one rather than a
/// type name.
pub fn element_type(element: &TimelineElement) -> ElementType {
    element_type_of(&element.kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn element(id: &str, start: i64, duration: i64) -> TimelineElement {
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
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
        }
    }

    fn video(id: &str, elements: Vec<TimelineElement>) -> Track {
        Track::Video {
            id: id.to_string(),
            name: id.to_string(),
            elements,
            muted: false,
            hidden: false,
        }
    }

    fn text(id: &str, elements: Vec<TimelineElement>) -> Track {
        Track::Text {
            id: id.to_string(),
            name: id.to_string(),
            elements,
            hidden: false,
        }
    }

    fn audio(id: &str) -> Track {
        Track::Audio {
            id: id.to_string(),
            name: id.to_string(),
            elements: vec![],
            muted: false,
        }
    }

    fn scene(overlay: Vec<Track>, audio_tracks: Vec<Track>) -> SceneTracks {
        SceneTracks {
            overlay,
            main: video("main", vec![]),
            audio: audio_tracks,
        }
    }

    fn span(start: i64, duration: i64) -> PlacementTimeSpan {
        PlacementTimeSpan {
            start_time: MediaTime::from_ticks(start),
            duration: MediaTime::from_ticks(duration),
            exclude_element_id: None,
        }
    }

    fn resolve(
        tracks: SceneTracks,
        strategy: PlacementStrategy,
        spans: Vec<PlacementTimeSpan>,
        element: ElementType,
    ) -> Option<PlacementResult> {
        resolve_track_placement(ResolvePlacementOptions {
            tracks,
            time_spans: spans,
            strategy,
            element_type: Some(element),
            track_type: None,
            source_track_id: None,
        })
        .placement
    }

    #[test]
    fn element_types_pair_with_the_right_track() {
        assert_eq!(ElementType::Image.track_type(), TrackType::Video);
        assert_eq!(ElementType::Sticker.track_type(), TrackType::Graphic);
        assert_eq!(ElementType::Audio.track_type(), TrackType::Audio);
        assert!(!can_element_go_on_track(CompatibilityOptions {
            element_type: ElementType::Audio,
            track_type: TrackType::Video,
        }));
    }

    #[test]
    fn an_explicit_track_of_the_wrong_type_is_refused() {
        let tracks = scene(vec![text("t1", vec![])], vec![]);
        assert!(
            resolve(
                tracks.clone(),
                PlacementStrategy::Explicit {
                    track_id: "t1".to_string()
                },
                vec![span(0, 100)],
                ElementType::Video,
            )
            .is_none()
        );
        // ...and one that does not exist at all.
        assert!(
            resolve(
                tracks,
                PlacementStrategy::Explicit {
                    track_id: "nope".to_string()
                },
                vec![span(0, 100)],
                ElementType::Text,
            )
            .is_none()
        );
    }

    #[test]
    fn an_explicit_track_takes_the_element_even_where_it_overlaps() {
        // Placement answers *which* track, not whether the time is free — an
        // explicit request is honoured and the caller deals with the overlap.
        let tracks = scene(vec![text("t1", vec![element("a", 0, 1000)])], vec![]);
        let result = resolve(
            tracks,
            PlacementStrategy::Explicit {
                track_id: "t1".to_string(),
            },
            vec![span(0, 1000)],
            ElementType::Text,
        );
        assert!(matches!(
            result,
            Some(PlacementResult::ExistingTrack { .. })
        ));
    }

    #[test]
    fn first_available_skips_an_occupied_track_and_takes_the_next() {
        let tracks = scene(
            vec![
                text("t1", vec![element("a", 0, 1000)]),
                text("t2", vec![]),
            ],
            vec![],
        );
        let result = resolve(
            tracks,
            PlacementStrategy::FirstAvailable,
            vec![span(0, 1000)],
            ElementType::Text,
        );
        assert_eq!(
            result,
            Some(PlacementResult::ExistingTrack {
                track_id: "t2".to_string(),
                track_index: 1,
                track_type: TrackType::Text,
            })
        );
    }

    #[test]
    fn touching_at_an_edge_is_not_an_overlap() {
        // A clip ending exactly where the next starts fits: the span is
        // half-open, so back-to-back clips are legal.
        let tracks = scene(vec![text("t1", vec![element("a", 0, 1000)])], vec![]);
        let result = resolve(
            tracks,
            PlacementStrategy::FirstAvailable,
            vec![span(1000, 500)],
            ElementType::Text,
        );
        assert!(matches!(
            result,
            Some(PlacementResult::ExistingTrack { track_index: 0, .. })
        ));
    }

    #[test]
    fn an_excluded_element_is_not_its_own_obstacle() {
        // Moving a clip within its own track must not collide with where it
        // currently is.
        let tracks = scene(vec![text("t1", vec![element("a", 0, 1000)])], vec![]);
        let mut span = span(0, 1000);
        span.exclude_element_id = Some("a".to_string());
        let result = resolve(
            tracks,
            PlacementStrategy::FirstAvailable,
            vec![span],
            ElementType::Text,
        );
        assert!(matches!(
            result,
            Some(PlacementResult::ExistingTrack { track_index: 0, .. })
        ));
    }

    #[test]
    fn first_available_makes_a_track_when_none_has_room() {
        let tracks = scene(vec![text("t1", vec![element("a", 0, 1000)])], vec![]);
        let result = resolve(
            tracks,
            PlacementStrategy::FirstAvailable,
            vec![span(0, 1000)],
            ElementType::Text,
        );
        assert_eq!(
            result,
            Some(PlacementResult::NewTrack {
                insert_index: 0,
                insert_position: None,
                track_type: TrackType::Text,
            })
        );
    }

    #[test]
    fn effects_open_at_the_top_and_audio_below_the_main_track() {
        let tracks = scene(vec![text("t1", vec![]), text("t2", vec![])], vec![audio("a1")]);
        assert_eq!(default_insert_index(&tracks, TrackType::Effect), 0);
        // Two overlays, then main, then the existing audio track.
        assert_eq!(default_insert_index(&tracks, TrackType::Audio), 4);
        // Everything else lands just above the main track.
        assert_eq!(default_insert_index(&tracks, TrackType::Text), 2);
    }

    #[test]
    fn an_audio_track_asked_for_above_the_main_track_is_pushed_below_it() {
        let tracks = scene(vec![text("t1", vec![])], vec![]);
        // Index 0 is an overlay — the wrong side of the main track for audio.
        let placement = preferred_new_track(&tracks, TrackType::Audio, 0, InsertPosition::Above);
        assert!(placement.was_redirected);
        assert_eq!(placement.insert_index, 2);
        assert_eq!(placement.insert_position, Some(InsertPosition::Below));
    }

    #[test]
    fn a_visual_track_asked_for_below_the_main_track_is_pulled_above_it() {
        let tracks = scene(vec![text("t1", vec![])], vec![audio("a1")]);
        // Index 2 is the audio region; a text track cannot live there.
        let placement = preferred_new_track(&tracks, TrackType::Text, 2, InsertPosition::Below);
        assert!(placement.was_redirected);
        assert_eq!(placement.insert_index, 1);
        assert_eq!(placement.insert_position, Some(InsertPosition::Above));
    }

    #[test]
    fn a_redirected_placement_prefers_staying_on_the_source_track() {
        // Rather than open a track on the far side of the timeline from where
        // the user pointed, the clip stays where it came from.
        let tracks = scene(vec![text("t1", vec![])], vec![audio("a1")]);
        let result = resolve_track_placement(ResolvePlacementOptions {
            tracks,
            time_spans: vec![span(0, 100)],
            strategy: PlacementStrategy::PreferIndex {
                track_index: 2,
                hover_direction: InsertPosition::Below,
                vertical_drag_direction: None,
                create_new_track_only: None,
            },
            element_type: Some(ElementType::Text),
            track_type: None,
            source_track_id: Some("t1".to_string()),
        })
        .placement;
        assert_eq!(
            result,
            Some(PlacementResult::ExistingTrack {
                track_id: "t1".to_string(),
                track_index: 0,
                track_type: TrackType::Text,
            })
        );
    }

    #[test]
    fn create_new_track_only_declines_a_perfectly_good_existing_track() {
        let tracks = scene(vec![text("t1", vec![])], vec![]);
        let result = resolve(
            tracks,
            PlacementStrategy::PreferIndex {
                track_index: 0,
                hover_direction: InsertPosition::Above,
                vertical_drag_direction: None,
                create_new_track_only: Some(true),
            },
            vec![span(0, 100)],
            ElementType::Text,
        );
        assert!(matches!(result, Some(PlacementResult::NewTrack { .. })));
    }

    #[test]
    fn a_drag_direction_overrides_the_hover_only_on_an_incompatible_track() {
        let tracks = scene(vec![text("t1", vec![]), text("t2", vec![])], vec![]);
        // Hovering a compatible track that has room: it is simply reused, and
        // the drag direction never comes into it.
        let reused = resolve(
            tracks.clone(),
            PlacementStrategy::PreferIndex {
                track_index: 1,
                hover_direction: InsertPosition::Below,
                vertical_drag_direction: Some(VerticalDragDirection::Up),
                create_new_track_only: None,
            },
            vec![span(0, 100)],
            ElementType::Text,
        );
        assert!(matches!(
            reused,
            Some(PlacementResult::ExistingTrack { track_index: 1, .. })
        ));

        // Hovering an incompatible track: the drag direction decides the side.
        let audio_scene = scene(vec![text("t1", vec![])], vec![audio("a1")]);
        let made = resolve(
            audio_scene,
            PlacementStrategy::PreferIndex {
                track_index: 0,
                hover_direction: InsertPosition::Below,
                vertical_drag_direction: Some(VerticalDragDirection::Up),
                create_new_track_only: None,
            },
            vec![span(0, 100)],
            ElementType::Audio,
        );
        assert!(matches!(made, Some(PlacementResult::NewTrack { .. })));
    }

    #[test]
    fn above_source_takes_the_track_overhead_when_it_fits() {
        let tracks = scene(
            vec![text("t0", vec![]), text("t1", vec![])],
            vec![],
        );
        let result = resolve(
            tracks,
            PlacementStrategy::AboveSource {
                source_track_index: 1,
            },
            vec![span(0, 100)],
            ElementType::Text,
        );
        assert!(matches!(
            result,
            Some(PlacementResult::ExistingTrack { track_index: 0, .. })
        ));
    }

    #[test]
    fn above_source_falls_back_when_there_is_nothing_overhead() {
        let tracks = scene(vec![text("t0", vec![element("a", 0, 1000)])], vec![]);
        let result = resolve(
            tracks,
            PlacementStrategy::AboveSource {
                source_track_index: 0,
            },
            vec![span(0, 1000)],
            ElementType::Text,
        );
        // Nothing above index 0, and the only track is occupied.
        assert!(matches!(result, Some(PlacementResult::NewTrack { .. })));
    }

    #[test]
    fn applying_to_an_existing_track_appends_and_leaves_the_others_alone() {
        let tracks = scene(vec![text("t1", vec![element("a", 0, 100)])], vec![]);
        let applied = apply_placement(ApplyPlacementOptions {
            tracks,
            placement_result: PlacementResult::ExistingTrack {
                track_id: "t1".to_string(),
                track_index: 0,
                track_type: TrackType::Text,
            },
            elements: vec![element("b", 200, 100)],
            new_track_insert_index_override: None,
            new_track_id: "unused".to_string(),
        });
        let updated = applied.updated_tracks.expect("applied");
        assert_eq!(updated.overlay[0].elements().len(), 2);
        assert_eq!(applied.target_track_id.as_deref(), Some("t1"));
        assert!(updated.main.elements().is_empty());
    }

    #[test]
    fn applying_to_a_missing_track_yields_nothing_rather_than_guessing() {
        let tracks = scene(vec![], vec![]);
        let applied = apply_placement(ApplyPlacementOptions {
            tracks,
            placement_result: PlacementResult::ExistingTrack {
                track_id: "gone".to_string(),
                track_index: 99,
                track_type: TrackType::Text,
            },
            elements: vec![element("b", 0, 100)],
            new_track_insert_index_override: None,
            new_track_id: "unused".to_string(),
        });
        assert!(applied.updated_tracks.is_none());
    }

    #[test]
    fn a_new_audio_track_lands_in_the_audio_collections_own_coordinates() {
        // Placement indices are timeline-wide; the audio vector is not.
        let tracks = scene(vec![text("t1", vec![])], vec![audio("a1")]);
        let applied = apply_placement(ApplyPlacementOptions {
            tracks,
            placement_result: PlacementResult::NewTrack {
                insert_index: 2,
                insert_position: Some(InsertPosition::Below),
                track_type: TrackType::Audio,
            },
            elements: vec![element("b", 0, 100)],
            new_track_insert_index_override: None,
            new_track_id: "new-audio".to_string(),
        });
        let updated = applied.updated_tracks.expect("applied");
        assert_eq!(updated.audio.len(), 2);
        assert_eq!(updated.audio[0].id(), "new-audio");
        assert_eq!(updated.overlay.len(), 1);
    }

    #[test]
    fn a_new_track_gets_the_default_name_for_its_type() {
        let track = build_empty_track(BuildEmptyTrackOptions {
            id: "t".to_string(),
            track_type: TrackType::Graphic,
            name: None,
        });
        let Track::Graphic { name, .. } = &track else {
            panic!("graphic track")
        };
        assert_eq!(name, "Graphic track");
    }

    #[test]
    fn making_room_only_takes_up_the_overlap() {
        // `a` grew to 1200 and now runs into `b` at 1000. `b` moves by the 200
        // of overlap, not by the whole growth, and `c` keeps its spacing.
        let tracks = SceneTracks {
            overlay: vec![],
            main: video(
                "main",
                vec![
                    element("a", 0, 1200),
                    element("b", 1000, 200),
                    element("c", 2000, 200),
                ],
            ),
            audio: vec![],
        };
        let updated = shift_elements_clear_of_element(MakeRoomOptions {
            tracks,
            track_id: "main".to_string(),
            element: element("a", 0, 1200),
        });
        let starts: Vec<i64> = updated
            .main
            .elements()
            .iter()
            .map(|element| element.start_time.as_ticks())
            .collect();
        assert_eq!(starts, vec![0, 1200, 2200]);
    }

    #[test]
    fn making_room_does_nothing_when_there_is_already_space() {
        let tracks = SceneTracks {
            overlay: vec![],
            main: video("main", vec![element("a", 0, 500), element("b", 1000, 200)]),
            audio: vec![],
        };
        let updated = shift_elements_clear_of_element(MakeRoomOptions {
            tracks: tracks.clone(),
            track_id: "main".to_string(),
            element: element("a", 0, 500),
        });
        assert_eq!(updated, tracks);
    }

    #[test]
    fn a_shrinking_clip_leaves_a_gap_rather_than_pulling_neighbours_back() {
        // Closing gaps is ripple editing's job, and that is opt-in.
        let tracks = SceneTracks {
            overlay: vec![],
            main: video("main", vec![element("a", 0, 200), element("b", 1000, 200)]),
            audio: vec![],
        };
        let updated = shift_elements_clear_of_element(MakeRoomOptions {
            tracks: tracks.clone(),
            track_id: "main".to_string(),
            element: element("a", 0, 200),
        });
        assert_eq!(updated, tracks);
    }
}
