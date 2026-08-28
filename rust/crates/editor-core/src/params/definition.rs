//! What a parameter is: its type, its bounds, and how its value decomposes into
//! animatable channels.
//!
//! The TypeScript expressed a layout as an object carrying `decompose` and
//! `compose` *closures*. Functions do not cross a wasm boundary, so the layout
//! here is data — a discriminant this module switches on — and the two
//! conversions are methods rather than fields. Nothing else changes: the layout
//! is a function of the param's type, and no definition in the codebase
//! overrides it.

use std::collections::HashMap;

use bridge::export;
use serde::{Deserialize, Serialize};

use crate::math::{clamp, snap_to_step};
use crate::model::ParamValue;

use super::color::{LinearRgba, format_linear_rgba, parse_color_to_linear_rgba};

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChannelValueKind {
    /// Interpolated between keys.
    Scalar,
    /// Held until the next key.
    Discrete,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChannelEasingMode {
    /// Each component carries its own curve.
    Independent,
    /// One curve drives every component — what stops a colour's channels
    /// drifting apart mid-transition.
    Shared,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DefaultInterpolation {
    Linear,
    Hold,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelComponentDefinition {
    pub key: String,
    pub value_kind: ChannelValueKind,
    pub default_interpolation: DefaultInterpolation,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ParamChannelLayout {
    /// One channel, keyed `"value"`.
    Leaf {
        component: ChannelComponentDefinition,
        easing_mode: ChannelEasingMode,
    },
    /// One channel per component — a colour's `r`/`g`/`b`/`a`.
    Composite {
        components: Vec<ChannelComponentDefinition>,
        easing_mode: ChannelEasingMode,
    },
}

fn leaf(kind: ChannelValueKind, interpolation: DefaultInterpolation) -> ParamChannelLayout {
    ParamChannelLayout::Leaf {
        component: ChannelComponentDefinition {
            key: "value".to_string(),
            value_kind: kind,
            default_interpolation: interpolation,
        },
        easing_mode: ChannelEasingMode::Independent,
    }
}

fn color_layout() -> ParamChannelLayout {
    ParamChannelLayout::Composite {
        components: ["r", "g", "b", "a"]
            .into_iter()
            .map(|key| ChannelComponentDefinition {
                key: key.to_string(),
                value_kind: ChannelValueKind::Scalar,
                default_interpolation: DefaultInterpolation::Linear,
            })
            .collect(),
        easing_mode: ChannelEasingMode::Shared,
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

/// How a parameter is presented in the panel. Not part of what a value *is*, but
/// it has to live with the definition: the registry in [`super::registry`] is the
/// only place a param is described, and a panel that had to look its label up
/// somewhere else would be a second list to keep in step.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParamGroup {
    Stroke,
}

/// Show the value as a percentage of its maximum. Bounds and default stay in
/// stored space, so a 0..1 opacity still stores 0..1.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParamUnit {
    Percent,
}

/// Render as a full-width track slider instead of the scrub field. For params
/// judged by eye against the picture — exposure, saturation — where the useful
/// gesture is a sweep rather than a typed number.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NumberControl {
    Slider,
}

/// Render as an eyedropper instead of the hue/saturation picker, for a colour
/// whose right value is one already in the picture rather than one to be mixed by
/// eye. A chroma key's screen colour is the case this exists for.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorControl {
    Eyedropper,
}

/// Hide this param unless another one holds a particular value — the text
/// background's colour and padding mean nothing while the background is off.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParamDependency {
    pub param: String,
    pub equals: ParamValue,
}

/// A parameter's definition: what its value is, and how the panel shows it.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ParamDefinition {
    Number {
        key: String,
        label: String,
        default: f64,
        min: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max: Option<f64>,
        step: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
        /// When set, `min`/`max`/`step` are in display space:
        /// `display = stored * displayMultiplier`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_multiplier: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<ParamUnit>,
        /// Rendered after the value in the number field, e.g. `dB`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suffix: Option<String>,
        /// Shown as the scrub handle's icon, e.g. `W`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        short_label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control: Option<NumberControl>,
        /// CSS background for a slider's track — a blue-to-orange temperature
        /// ramp, say — so the track itself says which way the slider pushes the
        /// picture. Read only when `control` is a slider.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track_gradient: Option<String>,
    },
    Boolean {
        key: String,
        label: String,
        default: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
    },
    Color {
        key: String,
        label: String,
        default: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        control: Option<ColorControl>,
    },
    Select {
        key: String,
        label: String,
        default: String,
        options: Vec<SelectOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
    },
    Text {
        key: String,
        label: String,
        default: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
    },
    Font {
        key: String,
        label: String,
        default: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyframable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<ParamGroup>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        dependencies: Vec<ParamDependency>,
    },
}

impl ParamDefinition {
    pub fn key(&self) -> &str {
        match self {
            ParamDefinition::Number { key, .. }
            | ParamDefinition::Boolean { key, .. }
            | ParamDefinition::Color { key, .. }
            | ParamDefinition::Select { key, .. }
            | ParamDefinition::Text { key, .. }
            | ParamDefinition::Font { key, .. } => key,
        }
    }

    /// The value the param starts at, in the same shape it is stored in.
    pub fn default_value(&self) -> ParamValue {
        match self {
            ParamDefinition::Number { default, .. } => ParamValue::Number(*default),
            ParamDefinition::Boolean { default, .. } => ParamValue::Bool(*default),
            ParamDefinition::Color { default, .. }
            | ParamDefinition::Select { default, .. }
            | ParamDefinition::Text { default, .. }
            | ParamDefinition::Font { default, .. } => ParamValue::Text(default.clone()),
        }
    }

    pub fn channel_layout(&self) -> ParamChannelLayout {
        match self {
            ParamDefinition::Number { .. } => {
                leaf(ChannelValueKind::Scalar, DefaultInterpolation::Linear)
            }
            ParamDefinition::Color { .. } => color_layout(),
            // A boolean or a string cannot be interpolated, only held.
            ParamDefinition::Boolean { .. }
            | ParamDefinition::Select { .. }
            | ParamDefinition::Text { .. }
            | ParamDefinition::Font { .. } => {
                leaf(ChannelValueKind::Discrete, DefaultInterpolation::Hold)
            }
        }
    }

    pub fn default_interpolation(&self) -> DefaultInterpolation {
        match self.channel_layout() {
            ParamChannelLayout::Leaf { component, .. } => component.default_interpolation,
            ParamChannelLayout::Composite { components, .. } => components
                .first()
                .map(|component| component.default_interpolation)
                .unwrap_or(DefaultInterpolation::Linear),
        }
    }

    /// Split a value into the channels that animate it. `None` when the value is
    /// not of the param's own type — a colour string that will not parse, say.
    pub fn decompose(&self, value: &ParamValue) -> Option<HashMap<String, ParamValue>> {
        match self {
            ParamDefinition::Color { .. } => {
                let ParamValue::Text(text) = value else {
                    return None;
                };
                let color = parse_color_to_linear_rgba(text)?;
                Some(HashMap::from([
                    ("r".to_string(), ParamValue::Number(color.r)),
                    ("g".to_string(), ParamValue::Number(color.g)),
                    ("b".to_string(), ParamValue::Number(color.b)),
                    ("a".to_string(), ParamValue::Number(color.a)),
                ]))
            }
            _ => Some(HashMap::from([("value".to_string(), value.clone())])),
        }
    }

    /// The inverse. `None` when a component is missing or of the wrong type, so
    /// a half-resolved colour does not become a colour-shaped string.
    pub fn compose(&self, components: &HashMap<String, ParamValue>) -> Option<ParamValue> {
        match self {
            ParamDefinition::Color { .. } => {
                let channel = |key: &str| match components.get(key) {
                    Some(ParamValue::Number(value)) => Some(*value),
                    _ => None,
                };
                Some(ParamValue::Text(format_linear_rgba(&LinearRgba {
                    r: channel("r")?,
                    g: channel("g")?,
                    b: channel("b")?,
                    a: channel("a")?,
                })))
            }
            _ => components.get("value").cloned(),
        }
    }

    /// Narrow an incoming value to what this param can hold, or refuse it.
    ///
    /// A number is snapped to its step and clamped to its bounds; a select only
    /// accepts one of its own options. Anything of the wrong type is refused
    /// rather than coerced, because guessing what a caller meant is how a
    /// boolean ends up stored as the string `"false"`.
    pub fn coerce(&self, value: &ParamValue) -> Option<ParamValue> {
        match self {
            ParamDefinition::Number {
                min, max, step, ..
            } => {
                let ParamValue::Number(number) = value else {
                    return None;
                };
                if number.is_nan() {
                    return None;
                }
                let stepped = snap_to_step(*number, *step);
                Some(ParamValue::Number(clamp(
                    stepped,
                    *min,
                    max.unwrap_or(f64::INFINITY),
                )))
            }
            ParamDefinition::Boolean { .. } => match value {
                ParamValue::Bool(_) => Some(value.clone()),
                _ => None,
            },
            ParamDefinition::Color { .. }
            | ParamDefinition::Text { .. }
            | ParamDefinition::Font { .. } => match value {
                ParamValue::Text(_) => Some(value.clone()),
                _ => None,
            },
            ParamDefinition::Select { options, .. } => match value {
                ParamValue::Text(text) if options.iter().any(|o| &o.value == text) => {
                    Some(value.clone())
                }
                _ => None,
            },
        }
    }
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParamOptions {
    pub param: ParamDefinition,
}

#[export]
pub fn get_param_channel_layout(ParamOptions { param }: ParamOptions) -> ParamChannelLayout {
    param.channel_layout()
}

#[export]
pub fn get_param_default_interpolation(
    ParamOptions { param }: ParamOptions,
) -> DefaultInterpolation {
    param.default_interpolation()
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NumericRange {
    pub range: Option<NumericBounds>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NumericBounds {
    pub min: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    pub step: f64,
}

/// The bounds a numeric field should present, or nothing for a param that is
/// not a number.
#[export]
pub fn get_param_numeric_range(ParamOptions { param }: ParamOptions) -> NumericRange {
    NumericRange {
        range: match param {
            ParamDefinition::Number {
                min, max, step, ..
            } => Some(NumericBounds { min, max, step }),
            _ => None,
        },
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoerceOptions {
    pub param: ParamDefinition,
    pub value: ParamValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoercedValue {
    pub value: Option<ParamValue>,
}

#[export]
pub fn coerce_param_value(CoerceOptions { param, value }: CoerceOptions) -> CoercedValue {
    CoercedValue {
        value: param.coerce(&value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(min: f64, max: Option<f64>, step: f64) -> ParamDefinition {
        ParamDefinition::Number {
            key: "n".to_string(),
            label: "N".to_string(),
            default: 0.0,
            min,
            max,
            step,
            keyframable: Some(true),
            group: None,
            dependencies: Vec::new(),
            display_multiplier: None,
            unit: None,
            suffix: None,
            short_label: None,
            control: None,
            track_gradient: None,
        }
    }

    fn color() -> ParamDefinition {
        ParamDefinition::Color {
            key: "c".to_string(),
            label: "C".to_string(),
            default: "#000000".to_string(),
            keyframable: Some(true),
            group: None,
            dependencies: Vec::new(),
            control: None,
        }
    }

    #[test]
    fn a_number_is_snapped_then_clamped() {
        let param = number(0.0, Some(1.0), 0.1);
        assert_eq!(
            param.coerce(&ParamValue::Number(0.34)),
            Some(ParamValue::Number(0.3))
        );
        // Clamping happens after snapping, so a value just past the top lands on
        // the bound rather than on the next step beyond it.
        assert_eq!(
            param.coerce(&ParamValue::Number(1.04)),
            Some(ParamValue::Number(1.0))
        );
        assert_eq!(
            param.coerce(&ParamValue::Number(-5.0)),
            Some(ParamValue::Number(0.0))
        );
    }

    #[test]
    fn a_number_with_no_maximum_is_only_bounded_below() {
        let param = number(0.0, None, 1.0);
        assert_eq!(
            param.coerce(&ParamValue::Number(1e9)),
            Some(ParamValue::Number(1e9))
        );
    }

    #[test]
    fn a_value_of_the_wrong_type_is_refused_rather_than_coerced() {
        let param = number(0.0, Some(1.0), 0.1);
        assert_eq!(param.coerce(&ParamValue::Text("0.5".to_string())), None);
        assert_eq!(param.coerce(&ParamValue::Bool(true)), None);
        assert_eq!(param.coerce(&ParamValue::Number(f64::NAN)), None);
    }

    #[test]
    fn a_select_only_accepts_one_of_its_own_options() {
        let param = ParamDefinition::Select {
            key: "s".to_string(),
            label: "S".to_string(),
            default: "a".to_string(),
            options: vec![
                SelectOption {
                    value: "a".to_string(),
                    label: "A".to_string(),
                },
                SelectOption {
                    value: "b".to_string(),
                    label: "B".to_string(),
                },
            ],
            keyframable: None,
            group: None,
            dependencies: Vec::new(),
        };
        assert_eq!(
            param.coerce(&ParamValue::Text("b".to_string())),
            Some(ParamValue::Text("b".to_string()))
        );
        assert_eq!(param.coerce(&ParamValue::Text("c".to_string())), None);
    }

    #[test]
    fn only_numbers_and_colours_interpolate() {
        assert_eq!(
            number(0.0, None, 1.0).default_interpolation(),
            DefaultInterpolation::Linear
        );
        assert_eq!(color().default_interpolation(), DefaultInterpolation::Linear);
        assert_eq!(
            ParamDefinition::Boolean {
                key: "b".to_string(),
                label: "B".to_string(),
                default: false,
                keyframable: None,
                group: None,
                dependencies: Vec::new(),
            }
            .default_interpolation(),
            DefaultInterpolation::Hold
        );
    }

    #[test]
    fn a_colour_decomposes_into_four_shared_easing_channels() {
        let layout = color().channel_layout();
        let ParamChannelLayout::Composite {
            components,
            easing_mode,
        } = layout
        else {
            panic!("a colour is composite")
        };
        assert_eq!(
            components.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(),
            vec!["r", "g", "b", "a"]
        );
        // One curve for all four, so the channels cannot drift apart.
        assert_eq!(easing_mode, ChannelEasingMode::Shared);
    }

    #[test]
    fn a_colour_round_trips_through_its_channels() {
        let param = color();
        let components = param
            .decompose(&ParamValue::Text("#3366cc".to_string()))
            .expect("parses");
        assert_eq!(components.len(), 4);
        assert_eq!(
            param.compose(&components),
            Some(ParamValue::Text("#3366cc".to_string()))
        );
    }

    #[test]
    fn a_colour_that_will_not_parse_decomposes_to_nothing() {
        assert!(color().decompose(&ParamValue::Text("nope".to_string())).is_none());
    }

    #[test]
    fn a_half_resolved_colour_does_not_compose() {
        // Missing a channel must not silently produce a colour with a made-up
        // component.
        let param = color();
        let partial = HashMap::from([
            ("r".to_string(), ParamValue::Number(0.5)),
            ("g".to_string(), ParamValue::Number(0.5)),
        ]);
        assert!(param.compose(&partial).is_none());
    }

    #[test]
    fn a_non_colour_decomposes_to_a_single_value_channel() {
        let param = number(0.0, None, 1.0);
        let components = param.decompose(&ParamValue::Number(4.0)).expect("some");
        assert_eq!(components.len(), 1);
        assert_eq!(components["value"], ParamValue::Number(4.0));
        assert_eq!(param.compose(&components), Some(ParamValue::Number(4.0)));
    }
}
