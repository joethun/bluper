//! Mask geometry: the overlay outlines and grab handles the preview draws.

mod builtin;
mod freeform_path;
mod handle_positions;
mod snap;

pub use builtin::{
    BaseMaskParamsDefaults, BuildMaskShapeOutlineOptions, MaskOutlineCommand, MaskOutlineKind,
    MaskShapeKind, MaskShapeOutline, MaskShapeOverlayPathOptions, build_mask_shape_outline,
    build_mask_shape_overlay_path, get_default_cinematic_bars_mask_params, BoxLikeCanvasGeometry, BoxMaskDefaultElementSize, BoxMaskParamUpdate,
    ComputeBoxMaskParamUpdateOptions, ComputeFeatherUpdateOptions,
    ComputeSplitMaskParamUpdateOptions, ComputeSplitMaskParamUpdateResult,
    ComputeTextMaskParamUpdateOptions, ComputeTextMaskParamUpdateResult,
    ComputeTextMaskScalePreferredEdgesOptions, ComputeTextMaskScalePreferredEdgesResult,
    DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO, FEATHER_HANDLE_SCALE, GetBoxLikeGeometryOptions,
    GetDefaultSquareMaskParamsOptions, GetStrokeOffsetOptions, MAX_FEATHER, MIN_MASK_DIMENSION,
    TextMaskParams, compute_box_mask_param_update, compute_feather_update,
    compute_split_mask_param_update_value, compute_text_mask_param_update_value,
    get_box_like_geometry, get_default_base_mask_params, get_default_square_mask_params,
    get_stroke_offset, get_text_mask_scale_preferred_edges_value,
};
pub use freeform_path::{
    BuildFreeformPath2DOptions, BuildFreeformSvgPathOptions, FindClosestPointOnFreeformSegmentOptions,
    FreeformCanvasAnchor, FreeformCanvasBounds, FreeformCanvasGeometry, FreeformCanvasPoint,
    FreeformCanvasSegment, FreeformClosestPoint, FreeformElementBounds, FreeformLocalBounds,
    FreeformPathPoint, FreeformRecenteredPath, FreeformSegmentCountOptions, FreeformTransformOptions,
    GetFreeformCanvasGeometryOptions, GetFreeformCanvasSegmentsOptions,
    GetFreeformLocalBoundsOptions, GetFreeformPathClosedStateAfterPointRemovalOptions,
    InsertPointIntoFreeformSegmentOptions, RecenterFreeformPathOptions,
    RemoveFreeformPathPointsOptions, build_freeform_path_2d, build_freeform_svg_path,
    find_closest_point_on_freeform_segment, freeform_canvas_point_to_local,
    get_freeform_canvas_geometry, get_freeform_canvas_segments, get_freeform_local_bounds,
    get_freeform_path_closed_state_after_point_removal, get_freeform_segment_count,
    insert_point_into_freeform_segment, recenter_freeform_path, remove_freeform_path_points,
};
pub use handle_positions::{
    MaskHandleBoxOptions, MaskHandleCorner, MaskHandleCornerX, MaskHandleCornerY, MaskHandleIcon,
    MaskHandleEdgeAxis, MaskHandleId, MaskHandleKind, MaskHandleLineOptions, MaskHandlePosition,
    MaskHandlePositionList, MaskHandleSide, MaskHandleSizeMode, MaskOverlayBounds,
    MaskOverlayBoxOptions, MaskOverlayBoxParams, MaskOverlayItem, MaskOverlayLineOptions,
    MaskOverlayList, MaskOverlayPoint, MaskOverlayRectOptions, get_box_mask_handle_positions,
    get_box_mask_overlays, get_box_mask_rect_overlay, get_line_mask_handle_positions,
    get_line_mask_overlay,
};
pub use snap::{
    BaseMaskParams, ElementBounds, MaskBoxSnapResult, MaskCanvasSize, MaskSnapThreshold,
    MaskSplitSnapResult, RectangleMaskParams, SnapBoxMaskInteractionOptions,
    SnapSplitMaskInteractionOptions, SplitMaskParams, snap_box_mask_interaction,
    snap_split_mask_interaction,
};
