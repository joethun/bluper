//! Pure-math parts of `apps/web/src/masks/builtin/` — the ones that don't
//! drag a `MaskDefinition` closure graph along with them. The closures in
//! `box-like.ts` and the per-shape files stay in TypeScript; only the literal
//! defaults, the geometry/coordinate transforms, and the drag-dispatch
//! math live here.

mod box_like;
mod shapes;
mod split;
mod text;

pub use box_like::{
    BaseMaskParamsDefaults, BoxLikeCanvasGeometry, BoxMaskDefaultElementSize, BoxMaskParamUpdate,
    ComputeBoxMaskParamUpdateOptions, ComputeFeatherUpdateOptions,
    DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO, FEATHER_HANDLE_SCALE, GetBoxLikeGeometryOptions,
    GetDefaultSquareMaskParamsOptions, GetStrokeOffsetOptions, MAX_FEATHER, MIN_MASK_DIMENSION,
    compute_box_mask_param_update, compute_feather_update, get_box_like_geometry,
    get_default_base_mask_params, get_default_square_mask_params, get_stroke_offset,
};
pub use shapes::{
    BuildMaskShapeOutlineOptions, MaskOutlineCommand, MaskOutlineKind, MaskShapeKind,
    MaskShapeOutline, MaskShapeOverlayPathOptions, build_mask_shape_outline,
    build_mask_shape_overlay_path, get_default_cinematic_bars_mask_params,
};
pub use split::{
    ComputeSplitMaskParamUpdateOptions, ComputeSplitMaskParamUpdateResult,
    compute_split_mask_param_update_value,
};
pub use text::{
    ComputeTextMaskParamUpdateOptions, ComputeTextMaskParamUpdateResult,
    ComputeTextMaskScalePreferredEdgesOptions, ComputeTextMaskScalePreferredEdgesResult,
    TextMaskParams, compute_text_mask_param_update_value, get_text_mask_scale_preferred_edges_value,
};
