//! Parameters: the typed values an element carries.

mod color;
pub mod defaults;
mod definition;
mod picker;
mod registry;

pub use color::{
    FormatColorOptions, ParseColorOptions, ParsedColor, format_linear_rgba_value,
    parse_color_to_linear_rgba_value,
    LinearRgba, format_linear_rgba, linear_to_srgb, parse_color_to_linear_rgba, srgb_to_linear,
};
pub use definition::{
    ChannelComponentDefinition, ChannelEasingMode, ChannelValueKind, CoerceOptions,
    CoercedValue, DefaultInterpolation, NumericBounds, NumericRange, ParamChannelLayout,
    ParamDefinition, ParamOptions, SelectOption, coerce_param_value,
    get_param_channel_layout, get_param_default_interpolation, get_param_numeric_range,
};
pub use picker::{
    AppendAlphaOptions, ColorFormat, ExtractColorOptions, ExtractedColor, FormatColorValueOptions,
    HexAlpha, HexOptions, Hsv, HsvOptions, ParseColorInputOptions, ParsedColorInput, append_alpha,
    append_alpha_value, extract_color_from_text, extract_color_from_text_value, format_color_value,
    format_color_value_string, hex_to_hsv, hex_to_hsv_value, hsv_to_hex, hsv_to_hex_value,
    parse_color_input, parse_color_input_value, parse_hex_alpha, parse_hex_alpha_value,
};
pub use definition::{
    ColorControl, NumberControl, ParamDependency, ParamGroup, ParamUnit,
};
pub use registry::{
    AdjustmentParamGroup, AdjustmentParamLayout, DefaultParamValues, DefaultValuesOptions,
    ElementParamOptions, ElementParams, ElementParamsOptions, MaybeParamDefinition,
    adjustment_param_groups, adjustment_param_keys, build_default_param_values,
    build_default_param_values_value, built_in_element_params, element_param,
    get_adjustment_param_layout, get_built_in_element_params, get_element_param,
    read_element_param_value,
};
