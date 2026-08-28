//! Geometry for the preview canvas — the interactive surface the user drags
//! elements around on.

mod coords;
mod hit_test;
mod render_scale;
mod snap;

pub use coords::{
    CanvasToOverlayOptions, PositionToOverlayOptions, PreviewGeometryOptions,
    PreviewViewportGeometry, ScreenPixelsToLogicalThresholdOptions, ScreenToCanvasOptions,
    canvas_to_overlay, canvas_to_overlay_point, display_scale, get_display_scale,
    position_to_overlay, position_to_overlay_point, screen_pixels_to_logical_threshold,
    screen_pixels_to_logical_threshold_value, screen_to_canvas, screen_to_canvas_point,
};
pub use hit_test::{
    HitElementIndexesOptions, HitTestBounds, HitTestElementRef, HitTestIndexes,
    PreferredHitIndexOptions, get_hit_element_indexes, get_preferred_hit_index,
    hit_element_indexes, preferred_hit_index,
};
pub use render_scale::{
    FitScaleToDisplayOptions, RecordRenderFrameOptions, RenderScaleDecision, RenderScaleForOptions,
    RenderScaleState, fit_scale_to_display, fit_scale_to_display_value,
    get_initial_render_scale_state, record_frame, record_render_frame, render_scale_for, scale_for,
};
pub use snap::{
    PREVIEW_MIN_SCALE, PREVIEW_SNAP_THRESHOLD_SCREEN_PIXELS, PreviewAxesSnapResult,
    PreviewAxisSnapResult, PreviewRotationSnapResult, PreviewScaleEdgePreference,
    PreviewScaleSnapResult, PreviewSnapLine, PreviewSnapLineKind, PreviewSnapPoint,
    PreviewSnapPositionOptions, PreviewSnapResult, PreviewSnapRotationOptions,
    PreviewSnapScaleAxesOptions, PreviewSnapScaleOptions, PreviewSnapSize, preview_snap_position,
    preview_snap_rotation, preview_snap_scale, preview_snap_scale_axes,
};
