//! Transitions: the overlap two adjacent clips share at a cut.

mod pairing;

pub use pairing::{
    ActiveBindingOptions, BindingsForElementOptions, BindingsOptions, CutAtTimeOptions,
    CutForElementOptions, ElementOptions, MaybeTransitionBinding, StrippedElement, TransitionableOptions, MaybeTransitionCut,
    TransitionTrackOptions, TransitionBinding, TransitionBindings, TransitionCut, TransitionCuts,
    TransitionPlacement, TransitionPlacementSide, TransitionPlacements,
    TransitionRenderExtension, TransitionRole, active_transition_binding,
    can_element_have_transition, can_element_type_have_transition,
    find_transition_cut_at_time, find_transition_cut_at_time_value, find_transition_cuts,
    find_transition_cuts_on_track, find_transitions, find_transitions_on_track,
    get_active_transition_binding, get_transition_bindings_for_element,
    get_transition_cut_for_element, get_transition_render_extension, read_element_transition,
    strip_transition_in, strip_transition_in_value, transition_bindings_for_element,
    transition_cut_for_element, transition_render_extension,
};
