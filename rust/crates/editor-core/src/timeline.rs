//! Timeline editing.

mod audio_display;
mod drop_target;
mod gaps;
mod group_move;
mod group_resize;
mod pixel_utils;
mod placement;
mod ripple;
mod ruler_utils;
mod snapping;
mod update_pipeline;
mod zoom_utils;

pub use update_pipeline::{
    ApplyElementUpdateOptions, UpdatedElement, apply_element_update,
};
pub use ripple::{
    ApplyRippleOptions, ComputeRippleOptions, RippleAdjustment, RippleAdjustments,
    ShiftElementsOptions, ShiftedElements, apply_ripple_adjustments,
    compute_ripple_adjustments, ripple_shift_elements,
};
pub use placement::{
    AppliedPlacement, ApplyPlacementOptions, BuildEmptyTrackOptions, CompatibilityOptions,
    ElementType, ElementTypeOptions, InsertPosition, MAIN_TRACK_NAME, MakeRoomOptions,
    NewTrackPosition, PlacementResult, PlacementStrategy, PlacementTimeSpan,
    ResolvePlacementOptions, ResolvedPlacement, TrackType, VerticalDragDirection,
    CanPlaceOptions, CompatibilityVerdict, InsertIndexOptions, apply_placement,
    build_empty_track, can_element_go_on_track, can_place_time_spans_on_track, element_type,
    get_default_insert_index_for_track, get_highest_insert_index_for_track,
    validate_element_track_compatibility,
    get_track_type_for_element_type, resolve_track_placement,
    shift_elements_clear_of_element,
};
pub use drop_target::{
    DropTarget, DropTargetElement, DropTargetLineOptions, DropTargetOptions,
    DropTargetTransitionOptions, MaybeDropTarget, compute_drop_target,
    compute_transition_drop_target, get_drop_line_y,
};
pub use gaps::{
    CloseAllGapsOptions, CloseGapOptions, FindGapAtTimeOptions, FoundGap, FoundGaps,
    TimelineGap, TrackOptions, close_all_gaps, close_gap, find_gap_at_time, find_gaps,
};
pub use snapping::{
    BASE_TIMELINE_PIXELS_PER_SECOND, GestureSnapPointsOptions, ResolveSnapOptions, SnapPoint,
    TimelineSnapPointsOptions, bookmark_snap_points, build_timeline_snap_points,
    build_timeline_snap_points_value,
    SnapPointType, SnapPoints, SnapResult, SnapThresholdOptions, animation_keyframe_snap_points,
    build_element_gesture_snap_points, element_edge_snap_points, element_gesture_snap_points,
    element_keyframe_times, get_timeline_snap_threshold_in_ticks, playhead_snap_points,
    resolve_timeline_snap, resolve_timeline_snap_value, timeline_snap_threshold_in_ticks,
};
pub use group_move::{
    BuildMoveGroupOptions, ElementRefInput, GroupMoveResult, GroupMoveSnap,
    GroupMoveSnapPointsOptions, GroupMoveTarget, GroupMember, GroupTrackSection,
    MaybeGroupMoveResult, MaybeMoveGroup, MoveGroup, MovedElementRef, PlannedElementMove,
    PlannedTrackCreation, ResolveGroupMoveOptions, ResolveGroupMoveSnapOptions, TrackPlacement,
    build_group_move_snap_points, build_move_group, build_move_group_value, display_tracks,
    resolve_group_move, resolve_group_move_snap, resolve_group_move_snap_value,
    resolve_group_move_value, track_placement_by_display_index, track_placement_by_id,
};
pub use group_resize::{
    ComputeGroupResizeOptions, GroupResizeMember, GroupResizePatch, GroupResizeResult,
    GroupResizeUpdate, ResizeSide, compute_group_resize, compute_group_resize_value,
};
pub use pixel_utils::{
    TIMELINE_INDICATOR_LINE_WIDTH_PX, CenteredLineLeftOptions, PixelsPerSecondOptions,
    PixelsToTimeOptions, PixelsToTimeResult, TimeToPixelsOptions,
    TimeToSnappedPixelsOptions, get_centered_line_left, get_centered_line_left_value,
    get_timeline_pixels_per_second, get_timeline_pixels_per_second_value,
    snap_pixel_to_device_grid, timeline_pixels_to_time, timeline_pixels_to_time_value,
    timeline_time_to_pixels, timeline_time_to_pixels_value,
    timeline_time_to_snapped_pixels, timeline_time_to_snapped_pixels_value,
};
pub use ruler_utils::{
    FormatRulerLabelOptions, GetRulerConfigOptions, RulerConfig, ShouldShowLabelOptions,
    format_ruler_label, format_ruler_label_value, get_ruler_config, get_ruler_config_value,
    should_show_label, should_show_label_value,
};
pub use audio_display::{
    BarFractionFromOutputAmplitudeOptions, DbFromLinePosOptions, LinePosFromDbOptions,
    get_bar_fraction_from_output_amplitude_value, get_db_from_line_pos_value,
    get_line_pos_from_db_value,
};
pub use zoom_utils::{
    SliderToZoomOptions, TimelinePaddingPxOptions, TimelineZoomMinOptions, ZoomToSliderOptions,
    get_timeline_padding_px_value, get_timeline_zoom_min_value, slider_to_zoom_value,
    zoom_to_slider_value,
};
