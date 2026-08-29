//! Which cuts carry a transition, and what window each one occupies.
//!
//! A transition is stored on the *incoming* clip and straddles the cut it shares
//! with the clip before it on the same track: the first half eats into the
//! outgoing clip's tail, the second half into the incoming clip's head. Neither
//! clip's `startTime` or `duration` changes and the project keeps its length —
//! the overlap exists only at render time, paid for out of the material each
//! clip's trim is hiding.
//!
//! A transition therefore always needs two clips. Fading a single clip against
//! the background is a separate thing entirely.

use serde::{Deserialize, Serialize};

use time::{MediaTime, TICKS_PER_SECOND};

use crate::model::{ElementKind, ElementTransition, SceneTracks, TimelineElement, Track};

/// Two clips count as sharing a cut when they butt up against each other. A tick
/// or two of slack absorbs the rounding that resizing and frame-snapping leave
/// behind, without letting a real — audible, visible — gap carry a transition.
const MAX_CUT_GAP_TICKS: i64 = if TICKS_PER_SECOND / 1_000 > 1 {
    TICKS_PER_SECOND / 1_000
} else {
    1
};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransitionRole {
    Outgoing,
    Incoming,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPlacementSide {
    pub element_id: String,
    pub role: TransitionRole,
    /// How much of the window lies before the clip's own start.
    pub head_extension: MediaTime,
    /// How much of the window lies after the clip's own end.
    pub tail_extension: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPlacement {
    pub track_id: String,
    pub transition: ElementTransition,
    pub outgoing_id: String,
    pub incoming_id: String,
    /// Clamped duration actually used — never longer than either clip allows.
    pub duration: MediaTime,
    /// The longest this cut could carry, for whatever edits the length.
    pub max_duration: MediaTime,
    /// Timeline time of the cut the window straddles.
    pub cut: MediaTime,
    pub window_start: MediaTime,
    pub window_end: MediaTime,
    pub sides: Vec<TransitionPlacementSide>,
}

/// A cut a transition could be dropped on, whether or not one is there yet.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionCut {
    pub track_id: String,
    pub outgoing_id: String,
    pub incoming_id: String,
    /// Timeline time the two clips meet at.
    pub time: MediaTime,
    /// The longest transition this cut can carry.
    pub max_duration: MediaTime,
    pub transition: Option<ElementTransition>,
}

/// A transition bound to one concrete clip, ready for the renderer: the absolute
/// timeline window plus which side of it this clip plays.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionBinding {
    pub transition: ElementTransition,
    pub role: TransitionRole,
    pub window_start: MediaTime,
    pub window_end: MediaTime,
    pub head_extension: MediaTime,
    pub tail_extension: MediaTime,
}

/// Only clips with footage of their own take part in a cut. A text clip butted
/// against a video does not make a cut — it is composited over one.
pub fn can_element_have_transition(element: &TimelineElement) -> bool {
    matches!(
        element.kind,
        ElementKind::Video { .. } | ElementKind::Image { .. }
    )
}

pub fn read_element_transition(element: &TimelineElement) -> Option<&ElementTransition> {
    match &element.kind {
        ElementKind::Video { transition_in, .. } | ElementKind::Image { transition_in, .. } => {
            transition_in.as_ref()
        }
        _ => None,
    }
}

/// Drop the incoming-side transition from an element. Splitting a clip invents a
/// boundary that never had a transition, so the trailing half must not inherit
/// the one that belonged to the original clip's start.
pub fn strip_transition_in(element: &TimelineElement) -> TimelineElement {
    let mut stripped = element.clone();
    match &mut stripped.kind {
        ElementKind::Video { transition_in, .. } | ElementKind::Image { transition_in, .. } => {
            *transition_in = None;
        }
        _ => {}
    }
    stripped
}

/// Timeline order, with the id settling a tie so two clips stacked at the same
/// instant always pair the same way round.
fn sorted_elements(track: &Track) -> Vec<&TimelineElement> {
    let mut elements: Vec<&TimelineElement> = track.elements().iter().collect();
    elements.sort_by(|left, right| {
        left.start_time
            .cmp(&right.start_time)
            .then_with(|| left.id.cmp(&right.id))
    });
    elements
}

fn element_end(element: &TimelineElement) -> MediaTime {
    element.start_time + element.duration
}

fn is_paired(outgoing: &TimelineElement, incoming: &TimelineElement) -> bool {
    if !can_element_have_transition(outgoing) || !can_element_have_transition(incoming) {
        return false;
    }

    let gap = (incoming.start_time.as_ticks() - element_end(outgoing).as_ticks()).abs();
    gap <= MAX_CUT_GAP_TICKS
}

/// A transition may not outrun either clip it joins: each half eats into one
/// neighbour, and eating past a clip's far edge would leave the transition
/// overlapping a third clip.
fn clamp_transition_duration(
    duration: MediaTime,
    outgoing_duration: MediaTime,
    incoming_duration: MediaTime,
) -> MediaTime {
    duration.min(outgoing_duration.min(incoming_duration))
}

fn build_placement(
    track_id: &str,
    outgoing: &TimelineElement,
    incoming: &TimelineElement,
    transition: &ElementTransition,
) -> Option<TransitionPlacement> {
    let duration = clamp_transition_duration(
        transition.duration,
        outgoing.duration,
        incoming.duration,
    );
    if duration <= MediaTime::ZERO {
        return None;
    }

    // Half away from zero, so an odd duration puts the extra tick after the cut.
    let half = MediaTime::from_ticks((duration.as_ticks() as f64 / 2.0).round() as i64);
    let cut = incoming.start_time;
    let window_start = cut - half;
    let window_end = cut + (duration - half);

    Some(TransitionPlacement {
        track_id: track_id.to_string(),
        transition: transition.clone(),
        outgoing_id: outgoing.id.clone(),
        incoming_id: incoming.id.clone(),
        duration,
        max_duration: outgoing.duration.min(incoming.duration),
        cut,
        window_start,
        window_end,
        sides: vec![
            TransitionPlacementSide {
                element_id: outgoing.id.clone(),
                role: TransitionRole::Outgoing,
                head_extension: MediaTime::ZERO,
                // The window runs past where this clip ends.
                tail_extension: window_end - cut,
            },
            TransitionPlacementSide {
                element_id: incoming.id.clone(),
                role: TransitionRole::Incoming,
                // The window opens before this clip does.
                head_extension: cut - window_start,
                tail_extension: MediaTime::ZERO,
            },
        ],
    })
}

/// Every transition on a track that currently joins two adjacent clips.
pub fn find_transitions(track: &Track) -> Vec<TransitionPlacement> {
    let elements = sorted_elements(track);
    let mut placements = Vec::new();

    for index in 1..elements.len() {
        let incoming = elements[index];
        let Some(transition) = read_element_transition(incoming) else {
            continue;
        };
        let outgoing = elements[index - 1];
        if !is_paired(outgoing, incoming) {
            continue;
        }
        if let Some(placement) = build_placement(track.id(), outgoing, incoming, transition) {
            placements.push(placement);
        }
    }

    placements
}

/// Every junction on a track that two clips share, in timeline order.
pub fn find_transition_cuts(track: &Track) -> Vec<TransitionCut> {
    let elements = sorted_elements(track);
    let mut cuts = Vec::new();

    for index in 1..elements.len() {
        let incoming = elements[index];
        let outgoing = elements[index - 1];
        if !is_paired(outgoing, incoming) {
            continue;
        }

        cuts.push(TransitionCut {
            track_id: track.id().to_string(),
            outgoing_id: outgoing.id.clone(),
            incoming_id: incoming.id.clone(),
            time: incoming.start_time,
            max_duration: outgoing.duration.min(incoming.duration),
            transition: read_element_transition(incoming).cloned(),
        });
    }

    cuts
}

/// The cut at a clip's leading edge, if it shares one with the clip before it.
pub fn transition_cut_for_element(track: &Track, element_id: &str) -> Option<TransitionCut> {
    find_transition_cuts(track)
        .into_iter()
        .find(|cut| cut.incoming_id == element_id)
}

/// The join the playhead is parked on, across every track.
///
/// A transition drag hit-tests the pointer, but the transition browser's add
/// button has only a playhead. A cut is a single instant, so landing on one to
/// the tick would be luck — the caller passes the slack it will accept rather
/// than this guessing at a pixel distance it cannot see.
pub fn find_transition_cut_at_time(
    tracks: &SceneTracks,
    time: MediaTime,
    tolerance_ticks: i64,
    preferred_track_id: Option<&str>,
) -> Option<TransitionCut> {
    // The same order the transition drop target scans in, so the button and a
    // drag agree on which track wins when two are cut at the same instant.
    let mut ordered: Vec<&Track> = tracks.overlay.iter().collect();
    ordered.push(&tracks.main);
    ordered.extend(tracks.audio.iter());

    let mut candidates: Vec<(TransitionCut, i64)> = Vec::new();
    for track in ordered {
        for cut in find_transition_cuts(track) {
            let distance = (cut.time.as_ticks() - time.as_ticks()).abs();
            if distance <= tolerance_ticks {
                candidates.push((cut, distance));
            }
        }
    }

    if candidates.is_empty() {
        return None;
    }

    // A cut on the track already being worked in beats a nearer one elsewhere;
    // failing that the closest wins, and track order settles a tie.
    let preferred: Vec<&(TransitionCut, i64)> = candidates
        .iter()
        .filter(|(cut, _)| Some(cut.track_id.as_str()) == preferred_track_id)
        .collect();

    let best = if preferred.is_empty() {
        candidates
            .iter()
            .reduce(|best, candidate| if candidate.1 < best.1 { candidate } else { best })?
    } else {
        preferred
            .into_iter()
            .reduce(|best, candidate| if candidate.1 < best.1 { candidate } else { best })?
    };
    Some(best.0.clone())
}

/// The bindings that affect one element. A clip can be the incoming side of the
/// transition on its own leading edge and the outgoing side of the next clip's;
/// their windows can touch but never overlap, because each half is capped at half
/// the clip's duration.
pub fn transition_bindings_for_element(
    placements: &[TransitionPlacement],
    element_id: &str,
) -> Vec<TransitionBinding> {
    let mut bindings = Vec::new();
    for placement in placements {
        for side in &placement.sides {
            if side.element_id != element_id {
                continue;
            }
            bindings.push(TransitionBinding {
                transition: ElementTransition {
                    duration: placement.duration,
                    ..placement.transition.clone()
                },
                role: side.role,
                window_start: placement.window_start,
                window_end: placement.window_end,
                head_extension: side.head_extension,
                tail_extension: side.tail_extension,
            });
        }
    }
    bindings
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRenderExtension {
    pub head: MediaTime,
    pub tail: MediaTime,
}

/// How far a clip's render window has to grow so both sides of its transitions
/// have pixels to show.
pub fn transition_render_extension(bindings: &[TransitionBinding]) -> TransitionRenderExtension {
    let mut head = MediaTime::ZERO;
    let mut tail = MediaTime::ZERO;
    for binding in bindings {
        head = head.max(binding.head_extension);
        tail = tail.max(binding.tail_extension);
    }
    TransitionRenderExtension { head, tail }
}

/// The binding covering an instant, or `None` outside every window. The window is
/// half-open, so the tick a window ends on already belongs to the plain clip.
///
/// The time is a tick count rather than a `MediaTime` because the renderer asks
/// this per frame with whatever instant it is drawing, which a seek can leave
/// between two ticks.
pub fn active_transition_binding(
    bindings: &[TransitionBinding],
    time: f64,
) -> Option<&TransitionBinding> {
    bindings.iter().find(|binding| {
        time >= binding.window_start.as_ticks() as f64
            && time < binding.window_end.as_ticks() as f64
    })
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionTrackOptions {
    pub track: Track,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPlacements {
    pub placements: Vec<TransitionPlacement>,
}

#[bridge::export]
pub fn find_transitions_on_track(TransitionTrackOptions { track }: TransitionTrackOptions) -> TransitionPlacements {
    TransitionPlacements {
        placements: find_transitions(&track),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionCuts {
    pub cuts: Vec<TransitionCut>,
}

#[bridge::export]
pub fn find_transition_cuts_on_track(TransitionTrackOptions { track }: TransitionTrackOptions) -> TransitionCuts {
    TransitionCuts {
        cuts: find_transition_cuts(&track),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeTransitionCut {
    pub cut: Option<TransitionCut>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CutForElementOptions {
    pub track: Track,
    pub element_id: String,
}

#[bridge::export]
pub fn get_transition_cut_for_element(
    CutForElementOptions { track, element_id }: CutForElementOptions,
) -> MaybeTransitionCut {
    MaybeTransitionCut {
        cut: transition_cut_for_element(&track, &element_id),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CutAtTimeOptions {
    pub tracks: SceneTracks,
    pub time: MediaTime,
    pub tolerance_ticks: f64,
    #[serde(default)]
    pub preferred_track_id: Option<String>,
}

#[bridge::export]
pub fn find_transition_cut_at_time_value(
    CutAtTimeOptions {
        tracks,
        time,
        tolerance_ticks,
        preferred_track_id,
    }: CutAtTimeOptions,
) -> MaybeTransitionCut {
    MaybeTransitionCut {
        cut: find_transition_cut_at_time(
            &tracks,
            time,
            tolerance_ticks as i64,
            preferred_track_id.as_deref(),
        ),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BindingsForElementOptions {
    pub placements: Vec<TransitionPlacement>,
    pub element_id: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionBindings {
    pub bindings: Vec<TransitionBinding>,
}

#[bridge::export]
pub fn get_transition_bindings_for_element(
    BindingsForElementOptions {
        placements,
        element_id,
    }: BindingsForElementOptions,
) -> TransitionBindings {
    TransitionBindings {
        bindings: transition_bindings_for_element(&placements, &element_id),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BindingsOptions {
    pub bindings: Vec<TransitionBinding>,
}

#[bridge::export]
pub fn get_transition_render_extension(
    BindingsOptions { bindings }: BindingsOptions,
) -> TransitionRenderExtension {
    transition_render_extension(&bindings)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBindingOptions {
    pub bindings: Vec<TransitionBinding>,
    pub time: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeTransitionBinding {
    pub binding: Option<TransitionBinding>,
}

#[bridge::export]
pub fn get_active_transition_binding(
    ActiveBindingOptions { bindings, time }: ActiveBindingOptions,
) -> MaybeTransitionBinding {
    MaybeTransitionBinding {
        binding: active_transition_binding(&bindings, time).cloned(),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementOptions {
    /// The stored element as JSON. Typed models cannot be a top-level wasm
    /// return — `#[serde(flatten)]` has no TypeScript rendering — and taking the
    /// raw value also means an element shape this crate does not understand
    /// comes back with every field it arrived with.
    #[cfg_attr(feature = "wasm", tsify(type = "unknown"))]
    pub element: serde_json::Value,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StrippedElement {
    #[cfg_attr(feature = "wasm", tsify(type = "unknown"))]
    pub element: serde_json::Value,
}

/// Removes the stored key rather than rebuilding the element through the typed
/// model, so an element carrying fields this crate has never heard of keeps them.
#[bridge::export]
pub fn strip_transition_in_value(ElementOptions { element }: ElementOptions) -> StrippedElement {
    let mut element = element;
    if let Some(fields) = element.as_object_mut() {
        fields.remove("transitionIn");
    }
    StrippedElement { element }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TransitionableOptions {
    pub element_type: super::super::timeline::ElementType,
}

/// Only clips with footage of their own take part in a cut, which is a fact about
/// the element type rather than about any one element.
#[bridge::export]
pub fn can_element_type_have_transition(
    TransitionableOptions { element_type }: TransitionableOptions,
) -> bool {
    matches!(
        element_type,
        super::super::timeline::ElementType::Video | super::super::timeline::ElementType::Image
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ParamValues;

    fn video(id: &str, start: i64, duration: i64, transition: Option<i64>) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: MediaTime::from_ticks(duration),
            start_time: MediaTime::from_ticks(start),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            animations: None,
            params: ParamValues::new(),
            kind: ElementKind::Video {
                media_id: "media".to_string(),
                hidden: None,
                is_source_audio_enabled: None,
                retime: None,
                freeze: None,
                effects: None,
                masks: None,
                transition_in: transition.map(|ticks| ElementTransition {
                    id: format!("{id}-transition"),
                    transition_type: "crossDissolve".to_string(),
                    duration: MediaTime::from_ticks(ticks),
                    params: ParamValues::new(),
                }),
                fade: None,
            },
        }
    }

    fn text(id: &str, start: i64, duration: i64) -> TimelineElement {
        TimelineElement {
            id: id.to_string(),
            name: id.to_string(),
            duration: MediaTime::from_ticks(duration),
            start_time: MediaTime::from_ticks(start),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::ZERO,
            source_duration: None,
            animations: None,
            params: ParamValues::new(),
            kind: ElementKind::Text {
                hidden: None,
                fade: None,
            },
        }
    }

    fn track(elements: Vec<TimelineElement>) -> Track {
        Track::Video {
            id: "track-1".to_string(),
            name: "Main".to_string(),
            elements,
            muted: false,
            hidden: false,
        }
    }

    const SECOND: i64 = 120_000;

    #[test]
    fn a_cut_carries_a_window_straddling_it() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND, SECOND, Some(12_000)),
        ]);
        let placements = find_transitions(&subject);
        assert_eq!(placements.len(), 1);
        let placement = &placements[0];
        assert_eq!(placement.cut, MediaTime::from_ticks(SECOND));
        assert_eq!(placement.duration, MediaTime::from_ticks(12_000));
        assert_eq!(placement.window_start, MediaTime::from_ticks(SECOND - 6_000));
        assert_eq!(placement.window_end, MediaTime::from_ticks(SECOND + 6_000));
        assert_eq!(placement.sides[0].tail_extension, MediaTime::from_ticks(6_000));
        assert_eq!(placement.sides[1].head_extension, MediaTime::from_ticks(6_000));
    }

    #[test]
    fn an_odd_duration_puts_the_extra_tick_after_the_cut() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND, SECOND, Some(5)),
        ]);
        let placement = &find_transitions(&subject)[0];
        // round(2.5) away from zero is 3, so 3 ticks come out of the outgoing
        // clip and 2 out of the incoming one.
        assert_eq!(placement.window_start, MediaTime::from_ticks(SECOND - 3));
        assert_eq!(placement.window_end, MediaTime::from_ticks(SECOND + 2));
    }

    #[test]
    fn a_transition_is_never_longer_than_the_shorter_clip() {
        let subject = track(vec![
            video("a", 0, 8_000, None),
            video("b", 8_000, SECOND, Some(SECOND)),
        ]);
        let placement = &find_transitions(&subject)[0];
        assert_eq!(placement.duration, MediaTime::from_ticks(8_000));
        assert_eq!(placement.max_duration, MediaTime::from_ticks(8_000));
    }

    #[test]
    fn a_real_gap_carries_no_transition() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND + SECOND, SECOND, Some(12_000)),
        ]);
        assert!(find_transitions(&subject).is_empty());
        assert!(find_transition_cuts(&subject).is_empty());
    }

    #[test]
    fn a_tick_of_rounding_slack_still_counts_as_a_cut() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND + 60, SECOND, Some(12_000)),
        ]);
        assert_eq!(find_transitions(&subject).len(), 1);
    }

    #[test]
    fn a_clip_without_footage_of_its_own_makes_no_cut() {
        let subject = Track::Text {
            id: "track-1".to_string(),
            name: "Text".to_string(),
            elements: vec![text("a", 0, SECOND), text("b", SECOND, SECOND)],
            hidden: false,
        };
        assert!(find_transition_cuts(&subject).is_empty());
    }

    #[test]
    fn a_cut_is_reported_whether_or_not_it_carries_a_transition() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND, SECOND, None),
        ]);
        let cuts = find_transition_cuts(&subject);
        assert_eq!(cuts.len(), 1);
        assert_eq!(cuts[0].time, MediaTime::from_ticks(SECOND));
        assert!(cuts[0].transition.is_none());
        assert_eq!(cuts[0].incoming_id, "b");
    }

    #[test]
    fn a_split_does_not_inherit_the_original_clips_transition() {
        let element = video("a", 0, SECOND, Some(12_000));
        assert!(read_element_transition(&element).is_some());
        assert!(read_element_transition(&strip_transition_in(&element)).is_none());
    }

    #[test]
    fn a_clip_gets_one_binding_for_each_of_its_two_edges() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND, SECOND, Some(12_000)),
            video("c", 2 * SECOND, SECOND, Some(12_000)),
        ]);
        let placements = find_transitions(&subject);
        let bindings = transition_bindings_for_element(&placements, "b");
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].role, TransitionRole::Incoming);
        assert_eq!(bindings[1].role, TransitionRole::Outgoing);

        let extension = transition_render_extension(&bindings);
        assert_eq!(extension.head, MediaTime::from_ticks(6_000));
        assert_eq!(extension.tail, MediaTime::from_ticks(6_000));
    }

    #[test]
    fn the_active_binding_is_the_window_the_time_falls_inside() {
        let subject = track(vec![
            video("a", 0, SECOND, None),
            video("b", SECOND, SECOND, Some(12_000)),
        ]);
        let bindings = transition_bindings_for_element(&find_transitions(&subject), "b");
        assert!(active_transition_binding(&bindings, SECOND as f64).is_some());
        // Half-open: the tick the window ends on is already the plain clip.
        assert!(active_transition_binding(&bindings, (SECOND + 6_000) as f64).is_none());
        assert!(active_transition_binding(&bindings, 0.0).is_none());
        // A seek can land between ticks.
        assert!(active_transition_binding(&bindings, SECOND as f64 - 0.5).is_some());
    }

    #[test]
    fn the_track_being_worked_in_wins_over_a_nearer_cut_elsewhere() {
        let tracks = SceneTracks {
            overlay: vec![Track::Video {
                id: "overlay-1".to_string(),
                name: "Overlay".to_string(),
                elements: vec![
                    video("x", 0, SECOND, None),
                    video("y", SECOND, SECOND, None),
                ],
                muted: false,
                hidden: false,
            }],
            main: track(vec![
                video("a", 0, SECOND + 600, None),
                video("b", SECOND + 600, SECOND, None),
            ]),
            audio: vec![],
        };

        let nearest = find_transition_cut_at_time(&tracks, MediaTime::from_ticks(SECOND), 1_000, None);
        assert_eq!(nearest.map(|cut| cut.track_id), Some("overlay-1".to_string()));

        let preferred = find_transition_cut_at_time(
            &tracks,
            MediaTime::from_ticks(SECOND),
            1_000,
            Some("track-1"),
        );
        assert_eq!(preferred.map(|cut| cut.track_id), Some("track-1".to_string()));
    }

    #[test]
    fn nothing_within_tolerance_answers_none() {
        let tracks = SceneTracks {
            overlay: vec![],
            main: track(vec![
                video("a", 0, SECOND, None),
                video("b", SECOND, SECOND, None),
            ]),
            audio: vec![],
        };
        assert!(
            find_transition_cut_at_time(&tracks, MediaTime::from_ticks(10 * SECOND), 100, None)
                .is_none()
        );
    }
}
