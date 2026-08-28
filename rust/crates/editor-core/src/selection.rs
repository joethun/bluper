//! Multi-select over an ordered list — `apps/web/src/selection/state.ts`.
//!
//! Every list in the editor that can be multi-selected shares this: the media
//! panel, the timeline's tracks, the mask's path points. The state is the set
//! of selected ids plus an *anchor*, which is the end a shift-click extends
//! from — without one, shift-clicking twice in a row would grow the range from
//! wherever the last click landed instead of from where the selection started.
//!
//! Ids are the caller's own strings and their order is the list's order, so
//! nothing here knows what is being selected.

use std::collections::HashSet;

use bridge::export;
use serde::{Deserialize, Serialize};

/// What is selected, and which end a range extends from.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectionState {
    pub selected_ids: Vec<String>,
    /// Crosses as `undefined`; the façade maps it to the `null` the callers
    /// store, since a list with no anchor is a state they persist.
    pub anchor_id: Option<String>,
}

/// First occurrence wins, so the order the caller built the list in survives.
fn dedupe_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(id.clone())).collect()
}

fn last_id(ids: &[String]) -> Option<String> {
    ids.last().cloned()
}

/// The ids between the anchor and the target, inclusive, in list order.
///
/// An id that is not in the list any more — a clip deleted between the two
/// clicks — collapses the range to the target rather than selecting nothing.
fn range_ids(ordered_ids: &[String], anchor_id: &str, target_id: &str) -> Vec<String> {
    let anchor_index = ordered_ids.iter().position(|id| id == anchor_id);
    let target_index = ordered_ids.iter().position(|id| id == target_id);

    match (anchor_index, target_index) {
        (Some(anchor), Some(target)) => {
            let start = anchor.min(target);
            let end = anchor.max(target);
            ordered_ids[start..=end].to_vec()
        }
        _ => vec![target_id.to_string()],
    }
}

/// Selects exactly these ids. The anchor defaults to the last of them, which
/// is where a click leaves it.
pub fn replace_selection(ids: Vec<String>, anchor_id: Option<String>) -> SelectionState {
    let selected_ids = dedupe_ids(ids);
    let anchor_id = anchor_id.or_else(|| last_id(&selected_ids));

    SelectionState {
        selected_ids,
        anchor_id,
    }
}

pub fn clear_selection() -> SelectionState {
    SelectionState {
        selected_ids: Vec::new(),
        anchor_id: None,
    }
}

/// Drops ids that are no longer in the list.
///
/// Runs whenever the list changes under the selection — an import, an undo, a
/// deleted clip. The `unchanged` flag is what lets the caller hand React the
/// *same* state object back, which is how the store avoids a re-render for a
/// list change that touched nothing selected.
pub fn prune_selection(state: SelectionState, ordered_ids: &[String]) -> PrunedSelection {
    let valid_ids: HashSet<&String> = ordered_ids.iter().collect();
    let selected_ids: Vec<String> = state
        .selected_ids
        .iter()
        .filter(|id| valid_ids.contains(id))
        .cloned()
        .collect();
    let anchor_id = match &state.anchor_id {
        Some(anchor) if valid_ids.contains(anchor) => Some(anchor.clone()),
        _ => last_id(&selected_ids),
    };
    // Length is enough: pruning only ever removes, and it removes in order.
    let unchanged =
        selected_ids.len() == state.selected_ids.len() && anchor_id == state.anchor_id;

    PrunedSelection {
        unchanged,
        state: SelectionState {
            selected_ids,
            anchor_id,
        },
    }
}

pub fn is_selected(state: &SelectionState, id: &str) -> bool {
    state.selected_ids.iter().any(|selected| selected == id)
}

/// Adds an id, or removes it if it was already selected.
///
/// Removing the anchor moves it to whatever is left at the end, so a following
/// shift-click still has somewhere to extend from.
pub fn toggle_selection(state: SelectionState, id: &str) -> SelectionState {
    if is_selected(&state, id) {
        let selected_ids: Vec<String> = state
            .selected_ids
            .iter()
            .filter(|selected| *selected != id)
            .cloned()
            .collect();
        let anchor_id = if state.anchor_id.as_deref() == Some(id) {
            last_id(&selected_ids)
        } else {
            state.anchor_id.clone()
        };
        return replace_selection(selected_ids, anchor_id);
    }

    let mut selected_ids = state.selected_ids;
    selected_ids.push(id.to_string());
    replace_selection(selected_ids, Some(id.to_string()))
}

/// Extends the selection from the anchor to `target_id`.
///
/// The anchor stays where it was, so dragging a shift-click back and forth
/// grows and shrinks one range rather than walking the selection along.
/// `is_additive` keeps whatever was already selected — a ctrl+shift-click
/// picking up a second run.
pub fn select_range(
    state: SelectionState,
    ordered_ids: &[String],
    target_id: &str,
    is_additive: bool,
) -> SelectionState {
    let anchor_id = state
        .anchor_id
        .clone()
        .or_else(|| last_id(&state.selected_ids))
        .unwrap_or_else(|| target_id.to_string());
    let range = range_ids(ordered_ids, &anchor_id, target_id);
    let selected_ids = if is_additive {
        let mut combined = state.selected_ids;
        combined.extend(range);
        dedupe_ids(combined)
    } else {
        range
    };

    replace_selection(selected_ids, Some(anchor_id))
}

/// The selection a drag-box leaves behind.
///
/// The box is re-evaluated against the *initial* selection on every pointer
/// move, not against the last one, so shrinking the box gives back what it no
/// longer covers.
pub fn apply_box_selection(
    intersected_ids: Vec<String>,
    initial_selected_ids: Vec<String>,
    initial_anchor_id: Option<String>,
    is_additive: bool,
) -> SelectionState {
    let last_intersected = last_id(&intersected_ids);
    let (selected_ids, anchor_id) = if is_additive {
        let mut combined = initial_selected_ids;
        combined.extend(intersected_ids);
        (
            dedupe_ids(combined),
            initial_anchor_id.or(last_intersected),
        )
    } else {
        (intersected_ids, last_intersected)
    };

    replace_selection(selected_ids, anchor_id)
}

// Bridge surface.

/// A pruned selection, and whether anything actually moved.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrunedSelection {
    pub state: SelectionState,
    pub unchanged: bool,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSelectionOptions {
    pub ids: Vec<String>,
    #[serde(default)]
    pub anchor_id: Option<String>,
}

#[export]
pub fn replace_selection_state(
    ReplaceSelectionOptions { ids, anchor_id }: ReplaceSelectionOptions,
) -> SelectionState {
    replace_selection(ids, anchor_id)
}

#[export]
pub fn clear_selection_state() -> SelectionState {
    clear_selection()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PruneSelectionOptions {
    pub state: SelectionState,
    pub ordered_ids: Vec<String>,
}

#[export]
pub fn prune_selection_state(
    PruneSelectionOptions { state, ordered_ids }: PruneSelectionOptions,
) -> PrunedSelection {
    prune_selection(state, &ordered_ids)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelectionIdOptions {
    pub state: SelectionState,
    pub id: String,
}

#[export]
pub fn is_selection_id_selected(SelectionIdOptions { state, id }: SelectionIdOptions) -> bool {
    is_selected(&state, &id)
}

#[export]
pub fn toggle_selection_state(SelectionIdOptions { state, id }: SelectionIdOptions) -> SelectionState {
    toggle_selection(state, &id)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SelectRangeOptions {
    pub state: SelectionState,
    pub ordered_ids: Vec<String>,
    pub target_id: String,
    pub is_additive: bool,
}

#[export]
pub fn select_range_state(
    SelectRangeOptions {
        state,
        ordered_ids,
        target_id,
        is_additive,
    }: SelectRangeOptions,
) -> SelectionState {
    select_range(state, &ordered_ids, &target_id, is_additive)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBoxSelectionOptions {
    pub intersected_ids: Vec<String>,
    pub initial_selected_ids: Vec<String>,
    #[serde(default)]
    pub initial_anchor_id: Option<String>,
    pub is_additive: bool,
}

#[export]
pub fn apply_box_selection_state(
    ApplyBoxSelectionOptions {
        intersected_ids,
        initial_selected_ids,
        initial_anchor_id,
        is_additive,
    }: ApplyBoxSelectionOptions,
) -> SelectionState {
    apply_box_selection(
        intersected_ids,
        initial_selected_ids,
        initial_anchor_id,
        is_additive,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn state(selected: &[&str], anchor: Option<&str>) -> SelectionState {
        SelectionState {
            selected_ids: ids(selected),
            anchor_id: anchor.map(|value| value.to_string()),
        }
    }

    #[test]
    fn replacing_keeps_the_first_of_each_duplicate() {
        let replaced = replace_selection(ids(&["a", "b", "a", "c", "b"]), None);
        assert_eq!(replaced.selected_ids, ids(&["a", "b", "c"]));
    }

    #[test]
    fn the_anchor_defaults_to_the_last_selected_id() {
        assert_eq!(
            replace_selection(ids(&["a", "b"]), None).anchor_id,
            Some("b".to_string()),
        );
        assert_eq!(replace_selection(Vec::new(), None).anchor_id, None);
    }

    #[test]
    fn an_explicit_anchor_survives_replacement() {
        // Shift-clicking sets the anchor to the far end of the range, not to
        // the id that was clicked last.
        let replaced = replace_selection(ids(&["a", "b", "c"]), Some("a".to_string()));
        assert_eq!(replaced.anchor_id, Some("a".to_string()));
    }

    #[test]
    fn clearing_leaves_nothing_to_extend_from() {
        assert_eq!(clear_selection(), SelectionState::default());
    }

    #[test]
    fn pruning_drops_ids_the_list_no_longer_has() {
        let pruned = prune_selection(state(&["a", "b", "c"], Some("b")), &ids(&["a", "c"]));
        assert!(!pruned.unchanged);
        assert_eq!(pruned.state.selected_ids, ids(&["a", "c"]));
        // The anchor went with `b`, so it falls back to the end of what is left.
        assert_eq!(pruned.state.anchor_id, Some("c".to_string()));
    }

    #[test]
    fn pruning_a_selection_nothing_touched_reports_it_unchanged() {
        // This is what lets the caller hand React the same object back rather
        // than re-rendering every row because an unrelated id appeared.
        let pruned = prune_selection(state(&["a", "b"], Some("a")), &ids(&["a", "b", "c"]));
        assert!(pruned.unchanged);
        assert_eq!(pruned.state, state(&["a", "b"], Some("a")));
    }

    #[test]
    fn pruning_keeps_an_anchor_that_is_still_in_the_list() {
        let pruned = prune_selection(state(&["a", "b"], Some("a")), &ids(&["a"]));
        assert_eq!(pruned.state.anchor_id, Some("a".to_string()));
    }

    #[test]
    fn toggling_an_unselected_id_adds_it_and_anchors_there() {
        let toggled = toggle_selection(state(&["a"], Some("a")), "b");
        assert_eq!(toggled.selected_ids, ids(&["a", "b"]));
        assert_eq!(toggled.anchor_id, Some("b".to_string()));
    }

    #[test]
    fn toggling_a_selected_id_removes_it() {
        let toggled = toggle_selection(state(&["a", "b", "c"], Some("a")), "b");
        assert_eq!(toggled.selected_ids, ids(&["a", "c"]));
        // The anchor was not the removed id, so it stays put.
        assert_eq!(toggled.anchor_id, Some("a".to_string()));
    }

    #[test]
    fn removing_the_anchor_moves_it_to_the_end_of_what_is_left() {
        let toggled = toggle_selection(state(&["a", "b", "c"], Some("b")), "b");
        assert_eq!(toggled.anchor_id, Some("c".to_string()));
    }

    #[test]
    fn a_range_covers_both_ends_in_list_order() {
        let ordered = ids(&["a", "b", "c", "d"]);
        let ranged = select_range(state(&["b"], Some("b")), &ordered, "d", false);
        assert_eq!(ranged.selected_ids, ids(&["b", "c", "d"]));
        // The anchor does not move, so dragging the range back shrinks it.
        assert_eq!(ranged.anchor_id, Some("b".to_string()));
    }

    #[test]
    fn a_range_runs_backwards_just_as_well() {
        let ordered = ids(&["a", "b", "c", "d"]);
        let ranged = select_range(state(&["d"], Some("d")), &ordered, "b", false);
        assert_eq!(ranged.selected_ids, ids(&["b", "c", "d"]));
        assert_eq!(ranged.anchor_id, Some("d".to_string()));
    }

    #[test]
    fn an_additive_range_keeps_what_was_already_selected() {
        let ordered = ids(&["a", "b", "c", "d", "e"]);
        let ranged = select_range(state(&["a"], Some("d")), &ordered, "e", true);
        assert_eq!(ranged.selected_ids, ids(&["a", "d", "e"]));
    }

    #[test]
    fn a_range_from_a_missing_anchor_selects_only_the_target() {
        // The anchored clip was deleted between the two clicks.
        let ordered = ids(&["a", "b", "c"]);
        let ranged = select_range(state(&["gone"], Some("gone")), &ordered, "b", false);
        assert_eq!(ranged.selected_ids, ids(&["b"]));
    }

    #[test]
    fn a_range_with_no_anchor_at_all_starts_from_the_target() {
        let ordered = ids(&["a", "b", "c"]);
        let ranged = select_range(SelectionState::default(), &ordered, "b", false);
        assert_eq!(ranged.selected_ids, ids(&["b"]));
        assert_eq!(ranged.anchor_id, Some("b".to_string()));
    }

    #[test]
    fn a_drag_box_replaces_the_selection_it_started_from() {
        let boxed = apply_box_selection(
            ids(&["c", "d"]),
            ids(&["a", "b"]),
            Some("a".to_string()),
            false,
        );
        assert_eq!(boxed.selected_ids, ids(&["c", "d"]));
        assert_eq!(boxed.anchor_id, Some("d".to_string()));
    }

    #[test]
    fn an_additive_drag_box_adds_to_it_and_keeps_the_anchor() {
        let boxed = apply_box_selection(
            ids(&["b", "c"]),
            ids(&["a", "b"]),
            Some("a".to_string()),
            true,
        );
        assert_eq!(boxed.selected_ids, ids(&["a", "b", "c"]));
        assert_eq!(boxed.anchor_id, Some("a".to_string()));
    }

    #[test]
    fn a_drag_box_over_nothing_empties_the_selection() {
        let boxed = apply_box_selection(Vec::new(), ids(&["a"]), Some("a".to_string()), false);
        assert_eq!(boxed.selected_ids, Vec::<String>::new());
        assert_eq!(boxed.anchor_id, None);
    }
}
