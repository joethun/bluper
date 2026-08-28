//! Keyframe evaluation.

mod bezier;
mod curve_bridge;
mod graph_channels;
mod graph_editor;
mod interpolation;
mod keyframes;
mod keyframes_query;
mod path;

pub use bezier::{
    BezierPointOptions, CurveHandle, DefaultHandleOptions, ScalarAnimationKey, ScalarSegmentType,
    SolveBezierProgressOptions, TangentMode, bezier_point, default_left_handle,
    default_right_handle, get_bezier_point, get_default_left_handle, get_default_right_handle,
    solve_bezier_progress, solve_bezier_progress_for_time,
};
pub use curve_bridge::{
    CurveHandlePair, CurveHandlesOptions, NormalizedCubicBezier, NormalizedCubicBezierOptions,
    StoredCurveHandle,
    get_curve_handles_for_normalized_cubic_bezier,
    get_normalized_cubic_bezier_for_scalar_segment,
};
pub use graph_channels::{
    EditableScalarChannels, GetEditableScalarChannelsOptions, GetScalarKeyframeContextOptions,
    ScalarGraphChannel, ScalarGraphChannelData, ScalarGraphKeyframeContext,
    get_editable_scalar_channels_inner, get_editable_scalar_channels_value,
    get_scalar_keyframe_context_inner, get_scalar_keyframe_context_value,
};
pub use graph_editor::{
    GraphEditorComponentOption, GraphEditorCurvePatch, GraphEditorCurvePatchList,
    GraphEditorCurvePatchOptions, GraphEditorCurvePreviewOptions,
    GraphEditorKeyframeCurvePatch, GraphEditorResolvedSegment, GraphEditorSelectedKeyframe,
    GraphEditorSelectionOptions, GraphEditorSelectionState, GraphEditorUnavailableReason,
    apply_graph_editor_curve_preview, apply_graph_editor_curve_preview_inner,
    build_graph_editor_curve_patches, build_graph_editor_curve_patches_inner,
    resolve_graph_editor_selection_state, resolve_graph_editor_selection_state_inner,
};
pub use interpolation::{
    AnimationInterpolation, ChannelOptions, ChannelValueAtTimeOptions,
    ScalarSegmentInterpolationOptions, get_channel_value_at_time,
    get_scalar_segment_interpolation, is_scalar_channel, normalize_channel,
    normalize_scalar_keys,
};
pub use keyframes::{
    ClampAnimationsOptions, CloneAnimationsOptions, KeyframeRefOptions, RetimeKeyframeOptions,
    ScalarCurveKeyframePatch, SetChannelOptions, SplitAnimations, SplitAnimationsOptions,
    MaybeAnimations, UpdateCurveOptions, clamp_animations_to_duration, clamp_animations_to_duration_inner, clone_animations,
    remove_element_keyframe, retime_element_keyframe, set_channel,
    split_animations_at_time, update_scalar_keyframe_curve,
};
pub use keyframes_query::{
    ElementKeyframe, GetElementKeyframesOptions, GetElementLocalTimeOptions,
    GetKeyframeAtTimeOptions, GetKeyframeByIdOptions, HasKeyframesOptions,
    ResolveAnimationPathValueAtTimeOptions, ResolveTransformAtTimeOptions, ResolvedAnimationValue,
    Transform, TransformPosition, get_element_keyframes_inner, get_element_keyframes_value,
    get_element_local_time_inner, get_element_local_time_value, get_keyframe_at_time_inner,
    get_keyframe_at_time_value, get_keyframe_by_id_inner, get_keyframe_by_id_value,
    has_keyframes_for_path_inner, has_keyframes_for_path_value,
    resolve_animation_path_value_at_time_inner, resolve_animation_path_value_at_time_value,
    resolve_transform_at_time_inner, resolve_transform_at_time_value,
};
pub use path::{
    ANIMATION_PROPERTY_PATHS, EffectParamPathBuilderOptions, EffectParamPathParts,
    ParamKeyOptions, PropertyPathOptions, StorageKeyOptions, effect_param_path,
    effect_param_path_value, graphic_param_path, graphic_param_path_value,
    is_animation_path, is_animation_path_value, is_animation_property_path,
    is_animation_property_path_value, is_animation_storage_key,
    is_animation_storage_key_value, is_effect_param_path, is_effect_param_path_value,
    is_graphic_param_path, is_graphic_param_path_value, parse_effect_param_path,
    parse_effect_param_path_value, parse_graphic_param_path,
    parse_graphic_param_path_value,
};