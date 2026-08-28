//! Groups: elements that move and die together.
//!
//! Membership is a shared id on each element rather than a container object,
//! which keeps a group free of any position in the track order and lets an
//! element leave one simply by losing the id.

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::{SceneTracks, Track};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ElementRef {
    pub track_id: String,
    pub element_id: String,
}

fn all_tracks(tracks: &SceneTracks) -> Vec<&Track> {
    let mut list: Vec<&Track> = tracks.overlay.iter().collect();
    list.push(&tracks.main);
    list.extend(tracks.audio.iter());
    list
}

fn group_id_of(tracks: &SceneTracks, target: &ElementRef) -> Option<String> {
    all_tracks(tracks)
        .into_iter()
        .find(|track| track.id() == target.track_id)?
        .elements()
        .iter()
        .find(|element| element.id == target.element_id)?
        .group_id
        .clone()
}

/// Every element carrying `group_id`, wherever it sits.
fn members(tracks: &SceneTracks, group_id: &str) -> Vec<ElementRef> {
    all_tracks(tracks)
        .into_iter()
        .flat_map(|track| {
            track
                .elements()
                .iter()
                .filter(|element| element.group_id.as_deref() == Some(group_id))
                .map(|element| ElementRef {
                    track_id: track.id().to_string(),
                    element_id: element.id.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn dedupe(refs: Vec<ElementRef>) -> Vec<ElementRef> {
    let mut seen: Vec<ElementRef> = Vec::with_capacity(refs.len());
    for reference in refs {
        if !seen.contains(&reference) {
            seen.push(reference);
        }
    }
    seen
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExpandToGroupsOptions {
    pub tracks: SceneTracks,
    pub elements: Vec<ElementRef>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElementRefs {
    pub elements: Vec<ElementRef>,
}

/// Pulls in the rest of every group the given elements belong to.
///
/// Applied wherever a selection is set, so picking up one member of a group
/// always picks up the whole of it — the property that makes a group behave as
/// one object for dragging, deleting and every other selection-driven edit.
#[export]
pub fn expand_to_groups(
    ExpandToGroupsOptions { tracks, elements }: ExpandToGroupsOptions,
) -> ElementRefs {
    let group_ids = dedupe_strings(
        elements
            .iter()
            .filter_map(|reference| group_id_of(&tracks, reference))
            .collect(),
    );
    if group_ids.is_empty() {
        return ElementRefs { elements };
    }

    let mut expanded = elements;
    for group_id in group_ids {
        expanded.extend(members(&tracks, &group_id));
    }
    ElementRefs {
        elements: dedupe(expanded),
    }
}

fn dedupe_strings(values: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWithGroupsOptions {
    pub tracks: SceneTracks,
    pub elements: Vec<ElementRef>,
    pub remove: Vec<ElementRef>,
}

/// Drops the given elements *and* the rest of their groups.
///
/// The inverse of [`expand_to_groups`] for the deselect path: removing one
/// member alone would be undone by the next expansion, so the whole group leaves
/// together.
#[export]
pub fn remove_with_groups(
    RemoveWithGroupsOptions {
        tracks,
        elements,
        remove,
    }: RemoveWithGroupsOptions,
) -> ElementRefs {
    let doomed = expand_to_groups(ExpandToGroupsOptions {
        tracks,
        elements: remove,
    })
    .elements;

    ElementRefs {
        elements: elements
            .into_iter()
            .filter(|reference| !doomed.contains(reference))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ElementKind, TimelineElement};
    use std::collections::HashMap;

    fn element(id: &str, group: Option<&str>) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: time::MediaTime::from_ticks(100),
            start_time: time::MediaTime::ZERO,
            trim_start: time::MediaTime::ZERO,
            trim_end: time::MediaTime::ZERO,
            source_duration: None,
            animations: None,
            params: HashMap::new(),
            group_id: group.map(str::to_string),
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
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

    /// A shot, its title and the sting under it — one group across three tracks.
    fn scene() -> SceneTracks {
        SceneTracks {
            overlay: vec![
                text("t1", vec![element("title", Some("g1"))]),
                text("t2", vec![element("loose", None)]),
            ],
            main: Track::Video {
                id: "main".to_string(),
                name: "Main".to_string(),
                elements: vec![element("shot", Some("g1"))],
                muted: false,
                hidden: false,
            },
            audio: vec![Track::Audio {
                id: "a1".to_string(),
                name: "Audio".to_string(),
                elements: vec![element("sting", Some("g1"))],
                muted: false,
            }],
        }
    }

    fn reference(track: &str, element: &str) -> ElementRef {
        ElementRef {
            track_id: track.to_string(),
            element_id: element.to_string(),
        }
    }

    #[test]
    fn selecting_one_member_selects_the_whole_group_across_tracks() {
        let expanded = expand_to_groups(ExpandToGroupsOptions {
            tracks: scene(),
            elements: vec![reference("t1", "title")],
        })
        .elements;
        assert_eq!(expanded.len(), 3);
        assert!(expanded.contains(&reference("main", "shot")));
        assert!(expanded.contains(&reference("a1", "sting")));
    }

    #[test]
    fn an_ungrouped_element_expands_to_only_itself() {
        let expanded = expand_to_groups(ExpandToGroupsOptions {
            tracks: scene(),
            elements: vec![reference("t2", "loose")],
        })
        .elements;
        assert_eq!(expanded, vec![reference("t2", "loose")]);
    }

    #[test]
    fn expanding_does_not_duplicate_a_member_already_selected() {
        let expanded = expand_to_groups(ExpandToGroupsOptions {
            tracks: scene(),
            elements: vec![reference("t1", "title"), reference("main", "shot")],
        })
        .elements;
        assert_eq!(expanded.len(), 3);
    }

    #[test]
    fn an_unknown_reference_is_ignored_rather_than_failing() {
        let expanded = expand_to_groups(ExpandToGroupsOptions {
            tracks: scene(),
            elements: vec![reference("nope", "gone")],
        })
        .elements;
        assert_eq!(expanded, vec![reference("nope", "gone")]);
    }

    #[test]
    fn removing_one_member_removes_the_whole_group() {
        // Otherwise the next expansion would put it straight back.
        let remaining = remove_with_groups(RemoveWithGroupsOptions {
            tracks: scene(),
            elements: vec![
                reference("t1", "title"),
                reference("main", "shot"),
                reference("a1", "sting"),
                reference("t2", "loose"),
            ],
            remove: vec![reference("main", "shot")],
        })
        .elements;
        assert_eq!(remaining, vec![reference("t2", "loose")]);
    }
}
