//! The curve editor's session state: whether the current keyframe selection is
//! editable as a curve, and what a curve drag turns into.
//!
//! This is the panel's "can I edit this, and if not why not" question, plus the
//! two writes it produces. The TypeScript it replaces already sat on Rust —
//! `getEditableScalarChannels`, `getScalarKeyframeContext`,
//! `getNormalizedCubicBezierForScalarSegment`, `updateScalarKeyframeCurve` were
//! all wasm calls — so resolving one selection crossed the boundary once per
//! property per component per candidate key. Calling them in-process here
//! collapses that to a single crossing, which is the whole reason this module
//! exists rather than staying where it was.
//!
//! Everything here runs on a click or a drag tick, never per frame, so the
//! selection and the element it names can cross whole.
//!
//! **Why the answer is an enum.** "Not editable" is an ordinary outcome, not an
//! error: eleven of the twelve reasons are things a user does on purpose
//! (selecting two keyframes that are not adjacent, landing on a hold segment,
//! picking two properties with no component in common). The panel shows a
//! different sentence for each, so the reason is a variant rather than a
//! message string — adding one here regenerates the TypeScript union and breaks
//! the exhaustive switch, which is the reminder to write the sentence.

use std::collections::HashMap;

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::model::{
    AnimationChannel, ChannelData, ElementAnimations, SceneTracks, TimelineElement, Track,
};
use crate::params::ChannelEasingMode;

use super::bezier::{CurveHandle, ScalarAnimationKey, ScalarSegmentType};
use super::curve_bridge::{
    NormalizedCubicBezierOptions, get_curve_handles_for_normalized_cubic_bezier,
    get_normalized_cubic_bezier_for_scalar_segment,
};
use super::graph_channels::{
    ScalarGraphKeyframeContext, get_editable_scalar_channels_inner,
    get_scalar_keyframe_context_inner,
};
use super::keyframes::{
    MaybeAnimations, ScalarCurveKeyframePatch, UpdateCurveOptions, update_scalar_keyframe_curve,
};

/// `cubic-bezier(0, 0, 1, 1)` — the straight line a `linear` segment draws.
/// Used unconditionally for a linear segment rather than derived from the keys,
/// so a linear segment still has a curve to show even when its two keys sit at
/// the same time.
const GRAPH_LINEAR_CURVE: [f64; 4] = [0.0, 0.0, 1.0, 1.0];

/// A value span at or below this counts as flat, so it cannot be the graph's
/// Y-axis scale — dividing by it would blow the curve up to nothing useful.
/// `getReferenceSpanValue` walks outwards looking for a span that clears it.
const FLAT_VALUE_EPSILON: f64 = 1e-6;

/// How far a control point may sit from the straight line and still be *stored*
/// as `linear` rather than as a bezier with handles. Dragging a handle back to
/// the diagonal should leave the segment linear again, not a bezier that merely
/// looks linear, because the two are told apart everywhere else by their type.
const LINEAR_CURVE_EPSILON: f64 = 1e-6;

/// Why the current selection has no editable curve. Each variant maps to one
/// sentence in the panel; the TypeScript renders them as a string union, which
/// is why the names are spelled out rather than abbreviated.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GraphEditorUnavailableReason {
    /// Nothing is selected at all.
    NoKeyframeSelected,
    /// More than two keyframes on one property: a curve has exactly two ends.
    MultipleKeyframesSelected,
    SelectedKeyframesSpanMultipleElements,
    /// Two keyframes on one property that are not neighbours, so there is no
    /// single segment between them.
    SelectedKeyframesAreNotAdjacent,
    /// Several properties are selected but no component key is editable on all
    /// of them — a colour and a scale, say.
    SelectedPropertiesHaveNoSharedComponent,
    SelectedElementMissing,
    SelectedElementHasNoAnimations,
    SelectedKeyframeHasNoScalarChannel,
    SelectedKeyframeMissingOnChannel,
    /// The last key on a channel: there is no segment leaving it to shape.
    SelectedKeyframeHasNoNextSegment,
    /// A `step` segment holds its value, so an easing curve would do nothing.
    SelectedSegmentIsHold,
    /// Both keys sit at the same time, so the segment has no horizontal extent
    /// to normalise against.
    SelectedSegmentIsFlat,
}

/// One entry in the component picker above the curve — `X`/`Y` for a position,
/// a single `Curve` for a colour.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorComponentOption {
    pub key: String,
    pub label: String,
}

/// One property's editable segment, resolved for the active component key.
///
/// `allContexts` is what makes a colour behave: under shared easing the
/// picker shows one `Curve` entry, but a write has to touch every component,
/// so the option carries all of them and `context` is only the representative
/// the curve is read from.
///
/// `cubicBezier` is a four-element `[x1, y1, x2, y2]` rather than a named
/// struct because the TypeScript curve editor works in that tuple; the façade
/// casts it back.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorResolvedSegment {
    pub property_path: String,
    pub keyframe_id: String,
    pub context: ScalarGraphKeyframeContext,
    pub all_contexts: Vec<ScalarGraphKeyframeContext>,
    pub cubic_bezier: Vec<f64>,
    pub reference_span_value: f64,
}

/// The panel's whole state, discriminated on `status`.
///
/// `componentOptions` and `activeComponentKey` are on both variants because
/// the picker stays on screen while the segment underneath it is unusable —
/// switching component is often how the user gets *out* of an unavailable
/// state, so the reason has to arrive alongside the keys they can switch to.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GraphEditorSelectionState {
    Unavailable {
        component_options: Vec<GraphEditorComponentOption>,
        active_component_key: Option<String>,
        message: String,
        reason: GraphEditorUnavailableReason,
    },
    Ready {
        component_options: Vec<GraphEditorComponentOption>,
        active_component_key: Option<String>,
        message: String,
        track_id: String,
        element_id: String,
        element: TimelineElement,
        segments: Vec<GraphEditorResolvedSegment>,
        /// The first segment's curve — what the editor draws when several
        /// properties are being shaped together.
        cubic_bezier: Vec<f64>,
    },
}

/// A keyframe the timeline has selected, as the panel names it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object)
)]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorSelectedKeyframe {
    pub track_id: String,
    pub element_id: String,
    pub property_path: String,
    pub keyframe_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorSelectionOptions {
    pub tracks: SceneTracks,
    pub selected_keyframes: Vec<GraphEditorSelectedKeyframe>,
    /// The component the panel was last showing. Tried first, and kept if it
    /// still resolves, so switching selection does not throw the user back to
    /// `X` every time.
    #[serde(default)]
    pub preferred_component_key: Option<String>,
}

/// The change one key takes. Every field is optional and absence means "leave
/// this alone", so a write can touch a key's outgoing handle without disturbing
/// its incoming one.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorKeyframeCurvePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_to_next: Option<ScalarSegmentType>,
    /// Absent leaves the handle alone; `null` clears it. Clearing is what makes
    /// a segment linear again rather than a bezier that happens to be straight.
    #[serde(skip_serializing_if = "Option::is_none", with = "serialize_double_option")]
    pub right_handle: Option<Option<CurveHandle>>,
    #[serde(skip_serializing_if = "Option::is_none", with = "serialize_double_option")]
    pub left_handle: Option<Option<CurveHandle>>,
}

/// `Some(None)` has to reach JavaScript as an explicit `null`, because the
/// patch reader tells "clear this handle" from "leave it alone" by presence.
/// `skip_serializing_if` removes the outer `None` before this runs, so the only
/// value that gets here without an inner payload is a deliberate clear.
mod serialize_double_option {
    use serde::{Serialize, Serializer};

    pub fn serialize<S, T>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
        T: Serialize,
    {
        match value {
            Some(Some(inner)) => serializer.serialize_some(inner),
            _ => serializer.serialize_none(),
        }
    }
}

impl GraphEditorKeyframeCurvePatch {
    /// The same change in the shape `update_scalar_keyframe_curve` takes.
    /// Tangent mode is never part of a curve-editor write: dragging a control
    /// point sets the handles directly, and re-deriving a tangent from them
    /// would fight the drag.
    fn to_scalar_patch(self) -> ScalarCurveKeyframePatch {
        ScalarCurveKeyframePatch {
            left_handle: self.left_handle,
            right_handle: self.right_handle,
            segment_to_next: self.segment_to_next,
            tangent_mode: None,
        }
    }
}

/// One write the curve editor produces: a key id and the change to make to it.
///
/// Reshaping a segment always touches *two* keys — the outgoing handle of the
/// left one and the incoming handle of the right one — which is why the builder
/// returns a list rather than a single patch.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorCurvePatch {
    pub keyframe_id: String,
    pub patch: GraphEditorKeyframeCurvePatch,
}

/// The patch list, named so it does not cross as a bare sequence.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(
    feature = "wasm",
    tsify(into_wasm_abi, hashmap_as_object, missing_as_null)
)]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorCurvePatchList {
    pub patches: Vec<GraphEditorCurvePatch>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorCurvePatchOptions {
    pub context: ScalarGraphKeyframeContext,
    pub cubic_bezier: Vec<f64>,
    pub reference_span_value: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphEditorCurvePreviewOptions {
    #[serde(default)]
    pub animations: Option<ElementAnimations>,
    pub context: ScalarGraphKeyframeContext,
    pub cubic_bezier: Vec<f64>,
    pub reference_span_value: f64,
}

// --- Internal working shapes ---------------------------------------------------

/// A reason plus the sentence the panel shows for it. Carried together because
/// every early return produces both, and splitting them invites a reason
/// gaining a variant without gaining a sentence.
struct Unavailable {
    reason: GraphEditorUnavailableReason,
    message: &'static str,
}

/// One component key the selection could be edited under, with the contexts a
/// write to it would touch.
struct GraphEditorPropertyOption {
    key: String,
    label: String,
    context: ScalarGraphKeyframeContext,
    all_contexts: Vec<ScalarGraphKeyframeContext>,
}

/// One property of the selection, once its keyframes have been ordered and its
/// editable components found.
struct GraphEditorPropertySelection {
    property_path: String,
    keyframe_id: String,
    /// The right-hand key, when the user selected a pair. The segment resolver
    /// insists the left key's successor *is* this one, which is what rejects a
    /// non-adjacent pair.
    secondary_keyframe_id: Option<String>,
    options: Vec<GraphEditorPropertyOption>,
}

/// The selected keyframes of one property of one element, in selection order.
struct PropertyGroup<'a> {
    track_id: &'a str,
    element_id: &'a str,
    property_path: &'a str,
    keyframes: Vec<&'a GraphEditorSelectedKeyframe>,
}

// --- Helpers -------------------------------------------------------------------

fn unavailable(reason: GraphEditorUnavailableReason, message: &str) -> GraphEditorSelectionState {
    GraphEditorSelectionState::Unavailable {
        component_options: Vec::new(),
        active_component_key: None,
        message: message.to_string(),
        reason,
    }
}

/// The element a selected keyframe names, and the track it sits on.
///
/// A track id that matches but has no such element answers "missing" rather
/// than continuing the search: two tracks cannot share an id, so a second match
/// would be a corrupt document, not a fallback.
fn find_element_by_keyframe<'a>(
    tracks: &'a SceneTracks,
    keyframe: &GraphEditorSelectedKeyframe,
) -> Option<(&'a TimelineElement, &'a str)> {
    let ordered: Vec<&Track> = tracks
        .overlay
        .iter()
        .chain(std::iter::once(&tracks.main))
        .chain(tracks.audio.iter())
        .collect();

    for track in ordered {
        if track.id() != keyframe.track_id {
            continue;
        }
        let element = track
            .elements()
            .iter()
            .find(|element| element.id == keyframe.element_id)?;
        return Some((element, track.id()));
    }

    None
}

/// Every leaf channel under a property path, composites expanded.
///
/// Component keys are visited in sorted order, where the TypeScript walked the
/// object's insertion order. The two agree for the only case that can see the
/// difference — a keyframe id shared across a composite's components, which the
/// editor only writes with a shared time.
fn channels_from_data(data: &ChannelData) -> Vec<&AnimationChannel> {
    match data {
        ChannelData::Channel(channel) => vec![channel],
        ChannelData::Composite(components) => {
            let mut keys: Vec<&String> = components.keys().collect();
            keys.sort();
            keys.into_iter()
                .filter_map(|key| components.get(key))
                .collect()
        }
    }
}

/// When a key with this id lives on any scalar channel of the path. Used only
/// to order a selected pair, so the first match is enough.
fn find_keyframe_time(
    animations: &ElementAnimations,
    property_path: &str,
    keyframe_id: &str,
) -> Option<i64> {
    let data = animations.get(property_path)?;
    for channel in channels_from_data(data) {
        let AnimationChannel::Scalar { keys, .. } = channel else {
            continue;
        };
        if let Some(key) = keys.iter().find(|key| key.id == keyframe_id) {
            return Some(key.time.as_ticks());
        }
    }
    None
}

/// Selected keyframes bucketed by (track, element, property), in the order the
/// properties were first seen so the first group stays the primary one.
fn group_selected_keyframes_by_property(
    selected_keyframes: &[GraphEditorSelectedKeyframe],
) -> Vec<PropertyGroup<'_>> {
    let mut index_by_key: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<PropertyGroup> = Vec::new();

    for keyframe in selected_keyframes {
        let group_key = format!(
            "{}:{}:{}",
            keyframe.track_id, keyframe.element_id, keyframe.property_path
        );
        if let Some(index) = index_by_key.get(&group_key) {
            groups[*index].keyframes.push(keyframe);
            continue;
        }
        index_by_key.insert(group_key, groups.len());
        groups.push(PropertyGroup {
            track_id: &keyframe.track_id,
            element_id: &keyframe.element_id,
            property_path: &keyframe.property_path,
            keyframes: vec![keyframe],
        });
    }

    groups
}

fn component_label(component_key: &str) -> String {
    if component_key == "value" {
        return "Value".to_string();
    }
    component_key.to_uppercase()
}

/// The absolute value span of the nearest non-flat adjacent segment, used as
/// the Y-axis scale when editing a flat segment. Without it a flat segment has
/// no vertical extent and the curve collapses to a line the user cannot grab.
///
/// Searches leftwards first, then rightwards from the segment itself, and falls
/// back to `1.0` when every surrounding segment is flat too.
fn reference_span_value(context: &ScalarGraphKeyframeContext) -> f64 {
    let mut sorted: Vec<&ScalarAnimationKey> = context.channel.keys.iter().collect();
    sorted.sort_by_key(|key| key.time.as_ticks());

    let left_index = sorted.iter().position(|key| key.id == context.keyframe.id);
    let right_index = context
        .next_key
        .as_ref()
        .and_then(|next| sorted.iter().position(|key| key.id == next.id));

    if let Some(left_index) = left_index {
        for index in (0..left_index).rev() {
            let span = (sorted[index + 1].value - sorted[index].value).abs();
            if span > FLAT_VALUE_EPSILON {
                return span;
            }
        }
    }

    if let Some(right_index) = right_index {
        for index in right_index..sorted.len().saturating_sub(1) {
            let span = (sorted[index + 1].value - sorted[index].value).abs();
            if span > FLAT_VALUE_EPSILON {
                return span;
            }
        }
    }

    1.0
}

/// Whether a curve is the straight diagonal to within
/// [`LINEAR_CURVE_EPSILON`]. A curve that is not four numbers is a caller bug
/// and is not linear.
fn is_linear_curve(cubic_bezier: &[f64]) -> bool {
    let Ok([x1, y1, x2, y2]) = <[f64; 4]>::try_from(cubic_bezier) else {
        return false;
    };
    x1.abs() <= LINEAR_CURVE_EPSILON
        && y1.abs() <= LINEAR_CURVE_EPSILON
        && (x2 - 1.0).abs() <= LINEAR_CURVE_EPSILON
        && (y2 - 1.0).abs() <= LINEAR_CURVE_EPSILON
}

/// Order one property's selected keyframes and find the components its curve
/// could be edited under.
fn resolve_property_selection(
    element: &TimelineElement,
    group: &PropertyGroup<'_>,
) -> Result<GraphEditorPropertySelection, Unavailable> {
    if group.keyframes.len() > 2 {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::MultipleKeyframesSelected,
            message: "Select at most two adjacent keyframes per property.",
        });
    }

    let Some(animations) = element.animations.as_ref() else {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedElementHasNoAnimations,
            message: "The selected keyframe has no editable graph.",
        });
    };

    let scalar_result = get_editable_scalar_channels_inner(Some(animations), group.property_path)
        .filter(|result| !result.channels.is_empty());
    let Some(scalar_result) = scalar_result else {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedKeyframeHasNoScalarChannel,
            message: "The selected keyframe has no editable graph channel.",
        });
    };

    // The timeline hands over a selection, not an ordering, so a pair may
    // arrive right-then-left. The segment always belongs to the earlier key.
    let primary_keyframe_id = group.keyframes[0].keyframe_id.clone();
    let mut resolved_keyframe_id = primary_keyframe_id.clone();
    let mut secondary_keyframe_id = group
        .keyframes
        .get(1)
        .filter(|_| group.keyframes.len() == 2)
        .map(|keyframe| keyframe.keyframe_id.clone());

    if let Some(secondary) = secondary_keyframe_id.clone() {
        let primary_time = find_keyframe_time(animations, group.property_path, &primary_keyframe_id);
        let secondary_time = find_keyframe_time(animations, group.property_path, &secondary);
        if let Some(secondary_time) = secondary_time
            && primary_time.is_none_or(|primary_time| secondary_time < primary_time)
        {
            resolved_keyframe_id = secondary;
            secondary_keyframe_id = Some(primary_keyframe_id);
        }
    }

    let contexts: Vec<(String, ScalarGraphKeyframeContext)> = scalar_result
        .channels
        .iter()
        .filter_map(|channel| {
            get_scalar_keyframe_context_inner(
                Some(animations),
                group.property_path,
                &channel.component_key,
                &resolved_keyframe_id,
            )
            .map(|context| (channel.component_key.clone(), context))
        })
        .collect();

    if contexts.is_empty() {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedKeyframeMissingOnChannel,
            message: "The selected keyframe is not editable as a graph segment.",
        });
    }

    // For shared-easing bindings (a colour) all components always carry the
    // same curve. Collapsing them to one "value" option makes the key
    // compatible with a single-component scalar binding such as opacity, which
    // is what lets a colour and an opacity be shaped in the same gesture.
    let options = if scalar_result.easing_mode == ChannelEasingMode::Shared {
        vec![GraphEditorPropertyOption {
            key: "value".to_string(),
            label: "Curve".to_string(),
            context: contexts[0].1.clone(),
            all_contexts: contexts
                .iter()
                .map(|(_, context)| context.clone())
                .collect(),
        }]
    } else {
        contexts
            .into_iter()
            .map(|(component_key, context)| GraphEditorPropertyOption {
                key: component_key.clone(),
                label: component_label(&component_key),
                all_contexts: vec![context.clone()],
                context,
            })
            .collect()
    };

    Ok(GraphEditorPropertySelection {
        property_path: group.property_path.to_string(),
        keyframe_id: resolved_keyframe_id,
        secondary_keyframe_id,
        options,
    })
}

/// The segment one property would expose under a given component key.
fn resolve_segment_for_option(
    property_selection: &GraphEditorPropertySelection,
    component_key: &str,
) -> Result<GraphEditorResolvedSegment, Unavailable> {
    let Some(option) = property_selection
        .options
        .iter()
        .find(|option| option.key == component_key)
    else {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedPropertiesHaveNoSharedComponent,
            message: "Selected properties do not share a graph-editable channel.",
        });
    };

    let Some(next_key) = option.context.next_key.as_ref() else {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedKeyframeHasNoNextSegment,
            message: "Select a keyframe that has an outgoing segment.",
        });
    };

    if let Some(secondary) = property_selection.secondary_keyframe_id.as_ref()
        && &next_key.id != secondary
    {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedKeyframesAreNotAdjacent,
            message: "Selected keyframes must be adjacent on each property.",
        });
    }

    if option.context.keyframe.segment_to_next == ScalarSegmentType::Step {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedSegmentIsHold,
            message: "Hold segments have a fixed value - easing has no effect here.",
        });
    }

    let reference_span_value = reference_span_value(&option.context);
    let cubic_bezier = if option.context.keyframe.segment_to_next == ScalarSegmentType::Linear {
        Some(GRAPH_LINEAR_CURVE.to_vec())
    } else {
        get_normalized_cubic_bezier_for_scalar_segment(NormalizedCubicBezierOptions {
            left_key: option.context.keyframe.clone(),
            right_key: next_key.clone(),
            reference_span_value: Some(reference_span_value),
        })
        .map(|curve| vec![curve.x1, curve.y1, curve.x2, curve.y2])
    };

    let Some(cubic_bezier) = cubic_bezier else {
        return Err(Unavailable {
            reason: GraphEditorUnavailableReason::SelectedSegmentIsFlat,
            message: "Cannot edit a segment where both keyframes are at the same time.",
        });
    };

    Ok(GraphEditorResolvedSegment {
        property_path: property_selection.property_path.clone(),
        keyframe_id: property_selection.keyframe_id.clone(),
        context: option.context.clone(),
        all_contexts: option.all_contexts.clone(),
        cubic_bezier,
        reference_span_value,
    })
}

// --- Public surface ------------------------------------------------------------

/// Resolve what the curve editor should show for the current keyframe
/// selection.
pub fn resolve_graph_editor_selection_state_inner(
    tracks: &SceneTracks,
    selected_keyframes: &[GraphEditorSelectedKeyframe],
    preferred_component_key: Option<&str>,
) -> GraphEditorSelectionState {
    if selected_keyframes.is_empty() {
        return unavailable(
            GraphEditorUnavailableReason::NoKeyframeSelected,
            "Select a keyframe to edit its curve.",
        );
    }

    let groups = group_selected_keyframes_by_property(selected_keyframes);
    let Some(primary_keyframe) = groups.first().and_then(|group| group.keyframes.first()) else {
        return unavailable(
            GraphEditorUnavailableReason::NoKeyframeSelected,
            "Select a keyframe to edit its curve.",
        );
    };

    let Some((element, track_id)) = find_element_by_keyframe(tracks, primary_keyframe) else {
        return unavailable(
            GraphEditorUnavailableReason::SelectedElementMissing,
            "The selected keyframe could not be resolved.",
        );
    };

    let spans_multiple_elements = groups
        .iter()
        .any(|group| group.track_id != track_id || group.element_id != element.id);
    if spans_multiple_elements {
        return unavailable(
            GraphEditorUnavailableReason::SelectedKeyframesSpanMultipleElements,
            "Selected keyframes must be on the same element.",
        );
    }

    let mut resolved_property_selections: Vec<GraphEditorPropertySelection> = Vec::new();
    for group in &groups {
        match resolve_property_selection(element, group) {
            Ok(selection) => resolved_property_selections.push(selection),
            Err(reason) => return unavailable(reason.reason, reason.message),
        }
    }

    // A component key is offered only if every selected property has it.
    let component_options: Vec<GraphEditorComponentOption> = resolved_property_selections
        .first()
        .map(|first| {
            first
                .options
                .iter()
                .filter(|candidate| {
                    resolved_property_selections.iter().all(|selection| {
                        selection
                            .options
                            .iter()
                            .any(|option| option.key == candidate.key)
                    })
                })
                .map(|option| GraphEditorComponentOption {
                    key: option.key.clone(),
                    label: option.label.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    if component_options.is_empty() {
        return unavailable(
            GraphEditorUnavailableReason::SelectedPropertiesHaveNoSharedComponent,
            "Selected properties do not share a graph-editable channel.",
        );
    }

    // Try each component option in preference order (preferred first, then the
    // rest) and stop at the first key where every property resolves to a valid
    // segment. This single pass both picks the active key and produces the
    // segment list; when none of them works, the last key tried is the one
    // reported, so the panel still shows a picker the user can move off.
    let mut candidate_keys: Vec<String> = Vec::new();
    if let Some(preferred) = preferred_component_key
        && component_options
            .iter()
            .any(|option| option.key == preferred)
    {
        candidate_keys.push(preferred.to_string());
    }
    candidate_keys.extend(
        component_options
            .iter()
            .filter(|option| Some(option.key.as_str()) != preferred_component_key)
            .map(|option| option.key.clone()),
    );

    let mut active_component_key = component_options[0].key.clone();
    let mut segment_results: Vec<Result<GraphEditorResolvedSegment, Unavailable>> = Vec::new();

    for candidate_key in candidate_keys {
        let results: Vec<Result<GraphEditorResolvedSegment, Unavailable>> =
            resolved_property_selections
                .iter()
                .map(|selection| resolve_segment_for_option(selection, &candidate_key))
                .collect();
        active_component_key = candidate_key;
        let all_resolved = results.iter().all(|result| result.is_ok());
        segment_results = results;
        if all_resolved {
            break;
        }
    }

    if let Some(Err(reason)) = segment_results.iter().find(|result| result.is_err()) {
        return GraphEditorSelectionState::Unavailable {
            component_options,
            active_component_key: Some(active_component_key),
            message: reason.message.to_string(),
            reason: reason.reason,
        };
    }

    let segments: Vec<GraphEditorResolvedSegment> =
        segment_results.into_iter().flatten().collect();
    let Some(primary_segment) = segments.first() else {
        return GraphEditorSelectionState::Unavailable {
            component_options,
            active_component_key: Some(active_component_key),
            message: "The selected keyframe is not editable as a graph segment.".to_string(),
            reason: GraphEditorUnavailableReason::SelectedKeyframeMissingOnChannel,
        };
    };

    let message = if segments.len() == 1 {
        "Edit graph".to_string()
    } else {
        format!("Edit graph for {} properties", segments.len())
    };
    let cubic_bezier = primary_segment.cubic_bezier.clone();

    GraphEditorSelectionState::Ready {
        component_options,
        active_component_key: Some(active_component_key),
        message,
        track_id: track_id.to_string(),
        element_id: element.id.clone(),
        element: element.clone(),
        segments,
        cubic_bezier,
    }
}

/// The pair of key writes a curve shape turns into, or `None` when the segment
/// cannot carry one.
///
/// A curve that has come back to the diagonal is stored as `linear` with both
/// handles cleared rather than as a bezier with straight handles: the two
/// render identically but only the first survives a later key move, since a
/// linear segment re-derives its shape and a bezier keeps stale handles.
pub fn build_graph_editor_curve_patches_inner(
    context: &ScalarGraphKeyframeContext,
    cubic_bezier: &[f64],
    reference_span_value: f64,
) -> Option<Vec<GraphEditorCurvePatch>> {
    let next_key = context.next_key.as_ref()?;

    if is_linear_curve(cubic_bezier) {
        return Some(vec![
            GraphEditorCurvePatch {
                keyframe_id: context.keyframe.id.clone(),
                patch: GraphEditorKeyframeCurvePatch {
                    segment_to_next: Some(ScalarSegmentType::Linear),
                    right_handle: Some(None),
                    left_handle: None,
                },
            },
            GraphEditorCurvePatch {
                keyframe_id: next_key.id.clone(),
                patch: GraphEditorKeyframeCurvePatch {
                    segment_to_next: None,
                    right_handle: None,
                    left_handle: Some(None),
                },
            },
        ]);
    }

    let handles = get_curve_handles_for_normalized_cubic_bezier(super::curve_bridge::CurveHandlesOptions {
        left_key: context.keyframe.clone(),
        right_key: next_key.clone(),
        cubic_bezier: cubic_bezier.to_vec(),
        reference_span_value: Some(reference_span_value),
    })?;

    Some(vec![
        GraphEditorCurvePatch {
            keyframe_id: context.keyframe.id.clone(),
            patch: GraphEditorKeyframeCurvePatch {
                segment_to_next: Some(ScalarSegmentType::Bezier),
                right_handle: Some(Some(CurveHandle {
                    dt: handles.right_handle.dt.as_ticks() as f64,
                    dv: handles.right_handle.dv,
                })),
                left_handle: None,
            },
        },
        GraphEditorCurvePatch {
            keyframe_id: next_key.id.clone(),
            patch: GraphEditorKeyframeCurvePatch {
                segment_to_next: None,
                right_handle: None,
                left_handle: Some(Some(CurveHandle {
                    dt: handles.left_handle.dt.as_ticks() as f64,
                    dv: handles.left_handle.dv,
                })),
            },
        },
    ])
}

/// Apply a curve shape to the element's animations without going through the
/// undo stack — what the panel calls while a control point is still under the
/// cursor. A segment that cannot carry a curve leaves the animations untouched
/// rather than clearing them.
pub fn apply_graph_editor_curve_preview_inner(
    animations: Option<ElementAnimations>,
    context: &ScalarGraphKeyframeContext,
    cubic_bezier: &[f64],
    reference_span_value: f64,
) -> Option<ElementAnimations> {
    let Some(patches) =
        build_graph_editor_curve_patches_inner(context, cubic_bezier, reference_span_value)
    else {
        return animations;
    };

    let mut current = animations;
    for patch in patches {
        current = update_scalar_keyframe_curve(UpdateCurveOptions {
            animations: current,
            property_path: context.property_path.clone(),
            component_key: context.component_key.clone(),
            keyframe_id: patch.keyframe_id,
            patch: patch.patch.to_scalar_patch(),
        })
        .animations;
    }
    current
}

// The exported surface. These only name the option and return shapes; the logic
// is in the `*_inner` functions above, which keep the borrowed arguments and
// plain `Option` that read better inside Rust.

#[export]
pub fn resolve_graph_editor_selection_state(
    GraphEditorSelectionOptions {
        tracks,
        selected_keyframes,
        preferred_component_key,
    }: GraphEditorSelectionOptions,
) -> GraphEditorSelectionState {
    resolve_graph_editor_selection_state_inner(
        &tracks,
        &selected_keyframes,
        preferred_component_key.as_deref(),
    )
}

#[export]
pub fn build_graph_editor_curve_patches(
    GraphEditorCurvePatchOptions {
        context,
        cubic_bezier,
        reference_span_value,
    }: GraphEditorCurvePatchOptions,
) -> Option<GraphEditorCurvePatchList> {
    build_graph_editor_curve_patches_inner(&context, &cubic_bezier, reference_span_value)
        .map(|patches| GraphEditorCurvePatchList { patches })
}

#[export]
pub fn apply_graph_editor_curve_preview(
    GraphEditorCurvePreviewOptions {
        animations,
        context,
        cubic_bezier,
        reference_span_value,
    }: GraphEditorCurvePreviewOptions,
) -> MaybeAnimations {
    MaybeAnimations {
        animations: apply_graph_editor_curve_preview_inner(
            animations,
            &context,
            &cubic_bezier,
            reference_span_value,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::TangentMode;
    use crate::model::{ElementKind, ParamValue};
    use time::MediaTime;

    fn key(id: &str, time: i64, value: f64, segment: ScalarSegmentType) -> ScalarAnimationKey {
        ScalarAnimationKey {
            id: id.to_string(),
            time: MediaTime::from_ticks(time),
            value,
            left_handle: None,
            right_handle: None,
            segment_to_next: segment,
            tangent_mode: TangentMode::Auto,
        }
    }

    fn scalar(keys: Vec<ScalarAnimationKey>) -> ChannelData {
        ChannelData::Channel(AnimationChannel::Scalar {
            keys,
            extrapolation: None,
        })
    }

    fn composite(components: &[(&str, Vec<ScalarAnimationKey>)]) -> ChannelData {
        ChannelData::Composite(
            components
                .iter()
                .map(|(component_key, keys)| {
                    (
                        (*component_key).to_string(),
                        AnimationChannel::Scalar {
                            keys: keys.clone(),
                            extrapolation: None,
                        },
                    )
                })
                .collect(),
        )
    }

    fn element(id: &str, animations: Option<ElementAnimations>) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: MediaTime::from_ticks(1000),
            start_time: MediaTime::ZERO,
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            animations,
            params: HashMap::from([("opacity".to_string(), ParamValue::Number(1.0))]),
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
        }
    }

    fn scene(elements: Vec<TimelineElement>) -> SceneTracks {
        SceneTracks {
            overlay: Vec::new(),
            main: Track::Video {
                id: "main".to_string(),
                name: "Main".to_string(),
                elements,
                muted: false,
                hidden: false,
            },
            audio: Vec::new(),
        }
    }

    fn selected(property_path: &str, keyframe_id: &str) -> GraphEditorSelectedKeyframe {
        GraphEditorSelectedKeyframe {
            track_id: "main".to_string(),
            element_id: "el".to_string(),
            property_path: property_path.to_string(),
            keyframe_id: keyframe_id.to_string(),
        }
    }

    /// A two-key sloped opacity channel: the ordinary editable case.
    fn sloped_opacity() -> ElementAnimations {
        HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                key("k1", 300, 30.0, ScalarSegmentType::Bezier),
            ]),
        )])
    }

    fn reason_of(state: &GraphEditorSelectionState) -> Option<GraphEditorUnavailableReason> {
        match state {
            GraphEditorSelectionState::Unavailable { reason, .. } => Some(*reason),
            GraphEditorSelectionState::Ready { .. } => None,
        }
    }

    fn resolve(
        tracks: &SceneTracks,
        selection: &[GraphEditorSelectedKeyframe],
    ) -> GraphEditorSelectionState {
        resolve_graph_editor_selection_state_inner(tracks, selection, None)
    }

    // --- Every unavailable reason ------------------------------------------

    #[test]
    fn no_selection_is_unavailable() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[])),
            Some(GraphEditorUnavailableReason::NoKeyframeSelected)
        );
    }

    #[test]
    fn three_keyframes_on_one_property_is_unavailable() {
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                key("k1", 300, 30.0, ScalarSegmentType::Bezier),
                key("k2", 600, 60.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(
            &tracks,
            &[
                selected("opacity", "k0"),
                selected("opacity", "k1"),
                selected("opacity", "k2"),
            ],
        );
        assert_eq!(
            reason_of(&state),
            Some(GraphEditorUnavailableReason::MultipleKeyframesSelected)
        );
    }

    #[test]
    fn a_selection_spanning_two_elements_is_unavailable() {
        let tracks = scene(vec![
            element("el", Some(sloped_opacity())),
            element("other", Some(sloped_opacity())),
        ]);
        let mut second = selected("opacity", "k0");
        second.element_id = "other".to_string();
        second.property_path = "volume".to_string();
        let state = resolve(&tracks, &[selected("opacity", "k0"), second]);
        assert_eq!(
            reason_of(&state),
            Some(GraphEditorUnavailableReason::SelectedKeyframesSpanMultipleElements)
        );
    }

    #[test]
    fn a_non_adjacent_pair_is_unavailable() {
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                key("k1", 300, 30.0, ScalarSegmentType::Bezier),
                key("k2", 600, 60.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(
            &tracks,
            &[selected("opacity", "k0"), selected("opacity", "k2")],
        );
        assert_eq!(
            reason_of(&state),
            Some(GraphEditorUnavailableReason::SelectedKeyframesAreNotAdjacent)
        );
    }

    #[test]
    fn two_properties_with_no_common_component_are_unavailable() {
        // `opacity` offers only "value"; the position composite offers "x"/"y"
        // and is not a full rgba, so it stays independent.
        let animations = HashMap::from([
            (
                "opacity".to_string(),
                scalar(vec![
                    key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                    key("k1", 300, 30.0, ScalarSegmentType::Bezier),
                ]),
            ),
            (
                "transform.position".to_string(),
                composite(&[
                    (
                        "x",
                        vec![
                            key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                            key("p1", 300, 30.0, ScalarSegmentType::Bezier),
                        ],
                    ),
                    (
                        "y",
                        vec![
                            key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                            key("p1", 300, 30.0, ScalarSegmentType::Bezier),
                        ],
                    ),
                ]),
            ),
        ]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(
            &tracks,
            &[
                selected("opacity", "k0"),
                selected("transform.position", "p0"),
            ],
        );
        assert_eq!(
            reason_of(&state),
            Some(GraphEditorUnavailableReason::SelectedPropertiesHaveNoSharedComponent)
        );
    }

    #[test]
    fn a_keyframe_on_a_missing_element_is_unavailable() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        let mut orphan = selected("opacity", "k0");
        orphan.element_id = "gone".to_string();
        assert_eq!(
            reason_of(&resolve(&tracks, &[orphan])),
            Some(GraphEditorUnavailableReason::SelectedElementMissing)
        );
    }

    #[test]
    fn an_unanimated_element_is_unavailable() {
        let tracks = scene(vec![element("el", None)]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("opacity", "k0")])),
            Some(GraphEditorUnavailableReason::SelectedElementHasNoAnimations)
        );
    }

    #[test]
    fn a_path_with_no_scalar_channel_is_unavailable() {
        // An animated element, but nothing under the selected path.
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("volume", "k0")])),
            Some(GraphEditorUnavailableReason::SelectedKeyframeHasNoScalarChannel)
        );
    }

    #[test]
    fn a_keyframe_id_that_is_on_no_channel_is_unavailable() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("opacity", "nope")])),
            Some(GraphEditorUnavailableReason::SelectedKeyframeMissingOnChannel)
        );
    }

    #[test]
    fn the_last_key_has_no_outgoing_segment() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("opacity", "k1")])),
            Some(GraphEditorUnavailableReason::SelectedKeyframeHasNoNextSegment)
        );
    }

    #[test]
    fn a_hold_segment_is_unavailable() {
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 0.0, ScalarSegmentType::Step),
                key("k1", 300, 30.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("opacity", "k0")])),
            Some(GraphEditorUnavailableReason::SelectedSegmentIsHold)
        );
    }

    #[test]
    fn a_zero_length_bezier_segment_is_unavailable() {
        // Two keys at the same time: no horizontal extent to normalise against.
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 300, 0.0, ScalarSegmentType::Bezier),
                key("k1", 300, 30.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        assert_eq!(
            reason_of(&resolve(&tracks, &[selected("opacity", "k0")])),
            Some(GraphEditorUnavailableReason::SelectedSegmentIsFlat)
        );
    }

    // --- Available selections ----------------------------------------------

    #[test]
    fn a_single_scalar_keyframe_resolves_to_one_value_option() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        let state = resolve(&tracks, &[selected("opacity", "k0")]);
        let GraphEditorSelectionState::Ready {
            component_options,
            active_component_key,
            message,
            segments,
            cubic_bezier,
            element_id,
            track_id,
            ..
        } = state
        else {
            panic!("a sloped two-key opacity segment is editable");
        };
        assert_eq!(track_id, "main");
        assert_eq!(element_id, "el");
        assert_eq!(component_options.len(), 1);
        assert_eq!(component_options[0].key, "value");
        assert_eq!(component_options[0].label, "Value");
        assert_eq!(active_component_key.as_deref(), Some("value"));
        assert_eq!(message, "Edit graph");
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].all_contexts.len(), 1);
        // Default handles sit a third along in both axes.
        assert!((cubic_bezier[0] - 1.0 / 3.0).abs() < 1e-12);
        assert!((cubic_bezier[3] - 2.0 / 3.0).abs() < 1e-12);
    }

    #[test]
    fn an_adjacent_pair_selected_backwards_still_resolves() {
        // The timeline hands over a selection, not an order.
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        let state = resolve(
            &tracks,
            &[selected("opacity", "k1"), selected("opacity", "k0")],
        );
        let GraphEditorSelectionState::Ready { segments, .. } = state else {
            panic!("an adjacent pair is editable whichever way round it arrives");
        };
        assert_eq!(segments[0].keyframe_id, "k0", "the segment is the left key's");
    }

    #[test]
    fn a_full_rgba_composite_collapses_to_one_curve_option() {
        let component_keys = ["r", "g", "b", "a"];
        let components: Vec<(&str, Vec<ScalarAnimationKey>)> = component_keys
            .iter()
            .map(|component_key| {
                (
                    *component_key,
                    vec![
                        key("c0", 0, 0.0, ScalarSegmentType::Bezier),
                        key("c1", 300, 30.0, ScalarSegmentType::Bezier),
                    ],
                )
            })
            .collect();
        let animations = HashMap::from([("color".to_string(), composite(&components))]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(&tracks, &[selected("color", "c0")]);
        let GraphEditorSelectionState::Ready {
            component_options,
            segments,
            ..
        } = state
        else {
            panic!("a colour is editable");
        };
        assert_eq!(component_options.len(), 1, "shared easing shows one curve");
        assert_eq!(component_options[0].key, "value");
        assert_eq!(component_options[0].label, "Curve");
        assert_eq!(
            segments[0].all_contexts.len(),
            4,
            "a write has to reach every component"
        );
    }

    #[test]
    fn an_independent_composite_offers_one_option_per_component() {
        let animations = HashMap::from([(
            "transform.position".to_string(),
            composite(&[
                (
                    "x",
                    vec![
                        key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                        key("p1", 300, 30.0, ScalarSegmentType::Bezier),
                    ],
                ),
                (
                    "y",
                    vec![
                        key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                        key("p1", 300, 60.0, ScalarSegmentType::Bezier),
                    ],
                ),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(&tracks, &[selected("transform.position", "p0")]);
        let GraphEditorSelectionState::Ready {
            component_options, ..
        } = state
        else {
            panic!("an independent composite is editable");
        };
        let keys: Vec<&str> = component_options
            .iter()
            .map(|option| option.key.as_str())
            .collect();
        assert_eq!(keys, vec!["x", "y"]);
        assert_eq!(component_options[0].label, "X", "labels upper-case");
    }

    #[test]
    fn the_preferred_component_key_wins_when_it_still_resolves() {
        let animations = HashMap::from([(
            "transform.position".to_string(),
            composite(&[
                (
                    "x",
                    vec![
                        key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                        key("p1", 300, 30.0, ScalarSegmentType::Bezier),
                    ],
                ),
                (
                    "y",
                    vec![
                        key("p0", 0, 0.0, ScalarSegmentType::Bezier),
                        key("p1", 300, 60.0, ScalarSegmentType::Bezier),
                    ],
                ),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve_graph_editor_selection_state_inner(
            &tracks,
            &[selected("transform.position", "p0")],
            Some("y"),
        );
        let GraphEditorSelectionState::Ready {
            active_component_key,
            ..
        } = state
        else {
            panic!("editable");
        };
        assert_eq!(active_component_key.as_deref(), Some("y"));
    }

    #[test]
    fn two_properties_sharing_value_report_the_property_count() {
        let animations = HashMap::from([
            (
                "opacity".to_string(),
                scalar(vec![
                    key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                    key("k1", 300, 30.0, ScalarSegmentType::Bezier),
                ]),
            ),
            (
                "volume".to_string(),
                scalar(vec![
                    key("v0", 0, 0.0, ScalarSegmentType::Bezier),
                    key("v1", 300, 30.0, ScalarSegmentType::Bezier),
                ]),
            ),
        ]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(
            &tracks,
            &[selected("opacity", "k0"), selected("volume", "v0")],
        );
        let GraphEditorSelectionState::Ready {
            message, segments, ..
        } = state
        else {
            panic!("both properties expose a \"value\" component");
        };
        assert_eq!(segments.len(), 2);
        assert_eq!(message, "Edit graph for 2 properties");
    }

    // --- Reference span -----------------------------------------------------

    #[test]
    fn a_flat_segment_borrows_the_neighbouring_span() {
        // k1 -> k2 is flat; the span to its left is 10, which becomes the scale.
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 0.0, ScalarSegmentType::Bezier),
                key("k1", 300, 10.0, ScalarSegmentType::Bezier),
                key("k2", 600, 10.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(&tracks, &[selected("opacity", "k1")]);
        let GraphEditorSelectionState::Ready { segments, .. } = state else {
            panic!("a flat segment with a sloped neighbour is still editable");
        };
        assert_eq!(segments[0].reference_span_value, 10.0);
    }

    #[test]
    fn an_entirely_flat_channel_falls_back_to_one() {
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 5.0, ScalarSegmentType::Bezier),
                key("k1", 300, 5.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let tracks = scene(vec![element("el", Some(animations))]);
        let state = resolve(&tracks, &[selected("opacity", "k0")]);
        let GraphEditorSelectionState::Ready { segments, .. } = state else {
            panic!("the 1.0 fallback keeps a wholly flat channel editable");
        };
        assert_eq!(segments[0].reference_span_value, 1.0);
    }

    #[test]
    fn the_flat_span_epsilon_is_a_strict_threshold() {
        let context_for = |neighbour_value: f64| {
            let animations = HashMap::from([(
                "opacity".to_string(),
                scalar(vec![
                    key("k0", 0, neighbour_value, ScalarSegmentType::Bezier),
                    key("k1", 300, 0.0, ScalarSegmentType::Bezier),
                    key("k2", 600, 0.0, ScalarSegmentType::Bezier),
                ]),
            )]);
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k1")
                .expect("k1 exists")
        };
        // Exactly at the epsilon is *not* clear of it — the test is `>`.
        assert_eq!(reference_span_value(&context_for(FLAT_VALUE_EPSILON)), 1.0);
        let just_over = FLAT_VALUE_EPSILON * 2.0;
        assert_eq!(reference_span_value(&context_for(just_over)), just_over);
    }

    #[test]
    fn the_reference_span_searches_right_when_the_left_is_flat() {
        let animations = HashMap::from([(
            "opacity".to_string(),
            scalar(vec![
                key("k0", 0, 5.0, ScalarSegmentType::Bezier),
                key("k1", 300, 5.0, ScalarSegmentType::Bezier),
                key("k2", 600, 5.0, ScalarSegmentType::Bezier),
                key("k3", 900, 12.0, ScalarSegmentType::Bezier),
            ]),
        )]);
        let context =
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k1")
                .expect("k1 exists");
        assert_eq!(reference_span_value(&context), 7.0);
    }

    // --- Curve patches ------------------------------------------------------

    fn opacity_context() -> ScalarGraphKeyframeContext {
        let animations = sloped_opacity();
        get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k0")
            .expect("k0 exists")
    }

    #[test]
    fn a_linear_curve_clears_both_handles() {
        let patches = build_graph_editor_curve_patches_inner(&opacity_context(), &GRAPH_LINEAR_CURVE, 1.0)
            .expect("a sloped segment takes a curve");
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].keyframe_id, "k0");
        assert_eq!(
            patches[0].patch.segment_to_next,
            Some(ScalarSegmentType::Linear)
        );
        assert_eq!(
            patches[0].patch.right_handle,
            Some(None),
            "an explicit clear, not \"leave alone\""
        );
        assert!(patches[0].patch.left_handle.is_none());
        assert_eq!(patches[1].keyframe_id, "k1");
        assert_eq!(patches[1].patch.left_handle, Some(None));
        assert!(patches[1].patch.segment_to_next.is_none());
    }

    #[test]
    fn the_linear_epsilon_is_inclusive() {
        // At the epsilon the curve still counts as linear; just past it does not.
        // The offsets go on `x1`/`y1`, whose reference is an exact zero — on
        // `x2`/`y2` the subtraction from 1.0 is not exact, so `1 - 1e-6` lands
        // a hair *outside* the epsilon and would test the float, not the rule.
        let at = [LINEAR_CURVE_EPSILON, LINEAR_CURVE_EPSILON, 1.0, 1.0];
        let past = [LINEAR_CURVE_EPSILON * 2.0, 0.0, 1.0, 1.0];
        assert!(is_linear_curve(&at));
        assert!(!is_linear_curve(&past));

        let context = opacity_context();
        let linear = build_graph_editor_curve_patches_inner(&context, &at, 1.0).expect("patches");
        assert_eq!(
            linear[0].patch.segment_to_next,
            Some(ScalarSegmentType::Linear)
        );
        let bezier = build_graph_editor_curve_patches_inner(&context, &past, 1.0).expect("patches");
        assert_eq!(
            bezier[0].patch.segment_to_next,
            Some(ScalarSegmentType::Bezier)
        );
    }

    #[test]
    fn a_shaped_curve_becomes_a_pair_of_handles() {
        let patches =
            build_graph_editor_curve_patches_inner(&opacity_context(), &[1.0 / 3.0, 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0], 1.0)
                .expect("patches");
        assert_eq!(
            patches[0].patch.segment_to_next,
            Some(ScalarSegmentType::Bezier)
        );
        // 300 / 3 is a whole number of ticks, so the round trip is exact.
        let Some(Some(right)) = patches[0].patch.right_handle else {
            panic!("a bezier write sets the outgoing handle");
        };
        assert_eq!(right.dt, 100.0);
        assert!((right.dv - 10.0).abs() < 1e-9);
        let Some(Some(left)) = patches[1].patch.left_handle else {
            panic!("a bezier write sets the incoming handle");
        };
        assert_eq!(left.dt, -100.0);
    }

    #[test]
    fn the_last_key_produces_no_patches() {
        let animations = sloped_opacity();
        let context =
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k1")
                .expect("k1 exists");
        assert!(
            build_graph_editor_curve_patches_inner(&context, &GRAPH_LINEAR_CURVE, 1.0).is_none(),
            "there is no segment leaving the last key"
        );
    }

    #[test]
    fn a_curve_that_is_not_four_numbers_produces_no_patches() {
        assert!(
            build_graph_editor_curve_patches_inner(&opacity_context(), &[0.1, 0.2, 0.3], 1.0)
                .is_none()
        );
    }

    // --- Preview ------------------------------------------------------------

    #[test]
    fn the_preview_writes_both_handles_onto_the_channel() {
        let animations = sloped_opacity();
        let context = opacity_context();
        let updated = apply_graph_editor_curve_preview_inner(
            Some(animations),
            &context,
            &[0.9, 0.1, 0.95, 0.2],
            1.0,
        )
        .expect("the channel survives the write");
        let Some(ChannelData::Channel(AnimationChannel::Scalar { keys, .. })) =
            updated.get("opacity")
        else {
            panic!("opacity is still a scalar channel");
        };
        assert_eq!(keys[0].segment_to_next, ScalarSegmentType::Bezier);
        assert!(keys[0].right_handle.is_some());
        assert!(keys[1].left_handle.is_some());
    }

    #[test]
    fn a_preview_on_a_segment_that_cannot_carry_a_curve_changes_nothing() {
        let animations = sloped_opacity();
        let context =
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k1")
                .expect("k1 exists");
        let updated = apply_graph_editor_curve_preview_inner(
            Some(animations.clone()),
            &context,
            &GRAPH_LINEAR_CURVE,
            1.0,
        );
        assert_eq!(updated, Some(animations));
    }

    #[test]
    fn a_linear_preview_clears_the_stored_handles() {
        let mut left = key("k0", 0, 0.0, ScalarSegmentType::Bezier);
        left.right_handle = Some(CurveHandle { dt: 10.0, dv: 2.0 });
        let mut right = key("k1", 300, 30.0, ScalarSegmentType::Bezier);
        right.left_handle = Some(CurveHandle {
            dt: -10.0,
            dv: -2.0,
        });
        let animations: ElementAnimations =
            HashMap::from([("opacity".to_string(), scalar(vec![left, right]))]);
        let context =
            get_scalar_keyframe_context_inner(Some(&animations), "opacity", "value", "k0")
                .expect("k0 exists");

        let updated = apply_graph_editor_curve_preview_inner(
            Some(animations),
            &context,
            &GRAPH_LINEAR_CURVE,
            1.0,
        )
        .expect("the channel survives the write");
        let Some(ChannelData::Channel(AnimationChannel::Scalar { keys, .. })) =
            updated.get("opacity")
        else {
            panic!("opacity is still a scalar channel");
        };
        assert_eq!(keys[0].segment_to_next, ScalarSegmentType::Linear);
        assert!(
            keys[0].right_handle.is_none(),
            "a stale handle would outlive the linear segment"
        );
        assert!(keys[1].left_handle.is_none());
    }

    // --- Serialised shape ---------------------------------------------------

    #[test]
    fn the_unavailable_reason_serialises_as_the_typescript_union_member() {
        let json = serde_json::to_value(GraphEditorUnavailableReason::SelectedSegmentIsHold)
            .expect("serialises");
        assert_eq!(json, serde_json::json!("selected-segment-is-hold"));
    }

    #[test]
    fn a_patch_omits_the_fields_it_does_not_touch() {
        let patches =
            build_graph_editor_curve_patches_inner(&opacity_context(), &GRAPH_LINEAR_CURVE, 1.0)
                .expect("patches");
        let json = serde_json::to_value(&patches[1]).expect("serialises");
        // The right key's patch names only `leftHandle`, and names it as an
        // explicit null rather than leaving it out.
        assert_eq!(
            json,
            serde_json::json!({ "keyframeId": "k1", "patch": { "leftHandle": null } })
        );
    }

    #[test]
    fn an_unavailable_state_carries_the_status_tag_and_a_null_active_key() {
        let tracks = scene(vec![element("el", Some(sloped_opacity()))]);
        let json = serde_json::to_value(resolve(&tracks, &[])).expect("serialises");
        assert_eq!(json["status"], serde_json::json!("unavailable"));
        assert_eq!(json["activeComponentKey"], serde_json::Value::Null);
        assert_eq!(json["componentOptions"], serde_json::json!([]));
    }
}
