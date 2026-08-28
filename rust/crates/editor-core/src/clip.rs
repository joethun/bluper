//! Per-clip visual settings that are neither keyframes nor effects: how a clip
//! fades against the background, and how much of its source it throws away.

mod crop;
mod fades;

pub use crop::{
    CROP_PARAM_KEYS, CropEdge, CropInsets, CropPlacement, CropPlacementOptions, CropRect,
    HashCropOptions, MaybeCropRect, NO_CROP, ReadCropOptions, ResolveCropOptions,
    SetCropEdgeOptions, get_crop_placement, get_crop_placement_value, hash_crop, hash_crop_value, read_crop_from_params,
    read_crop_from_params_value, resolve_crop_rect, resolve_crop_rect_value, set_crop_edge,
    set_crop_edge_value,
};
pub use fades::{
    FadeEdge, FadeOpacityOptions, MaxFadeDurationOptions, MaybeFade, WithFadeEdgeOptions,
    get_max_fade_duration, max_fade_duration, resolve_fade_opacity, resolve_fade_opacity_value,
    with_fade_edge, with_fade_edge_value,
};
