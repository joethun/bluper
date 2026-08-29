//! Which params each element type has.
//!
//! This is the one place a built-in param is described: its bounds, its default,
//! and how the panel shows it. A second list would drift, and the way that shows
//! up is a clip created carrying a value the panel then reports as non-default.
//!
//! The TypeScript `ElementParamDefinition` also allowed a `read`/`write` pair of
//! closures per param, for a value stored somewhere other than the param bag.
//! Nothing ever supplied them — every built-in param lives in `element.params` —
//! so they are gone rather than ported.

use serde::{Deserialize, Serialize};

use super::defaults;
use super::definition::{
    NumberControl, ParamDefinition, ParamUnit, SelectOption,
};
use crate::model::{ParamValue, ParamValues, TimelineElement};
use crate::timeline::ElementType;

fn number(
    key: &str,
    label: &str,
    default: f64,
    min: f64,
    max: Option<f64>,
    step: f64,
) -> ParamDefinition {
    ParamDefinition::Number {
        key: key.to_string(),
        label: label.to_string(),
        default,
        min,
        max,
        step,
        keyframable: None,
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

/// Sets the fields a plain `number` leaves empty. Written as a mutation on the
/// built value rather than as another ten-argument constructor.
fn with_number<F>(param: ParamDefinition, edit: F) -> ParamDefinition
where
    F: FnOnce(&mut NumberFields),
{
    let ParamDefinition::Number {
        key,
        label,
        default,
        min,
        max,
        step,
        ..
    } = param
    else {
        unreachable!("with_number is only ever handed a number");
    };
    let mut fields = NumberFields::default();
    edit(&mut fields);
    ParamDefinition::Number {
        key,
        label,
        default,
        min,
        max,
        step,
        keyframable: fields.keyframable,
        group: None,
        dependencies: fields.dependencies,
        display_multiplier: None,
        unit: fields.unit,
        suffix: fields.suffix,
        short_label: None,
        control: fields.control,
        track_gradient: fields.track_gradient,
    }
}

#[derive(Default)]
struct NumberFields {
    keyframable: Option<bool>,
    unit: Option<ParamUnit>,
    suffix: Option<String>,
    control: Option<NumberControl>,
    track_gradient: Option<String>,
    dependencies: Vec<super::definition::ParamDependency>,
}

fn background_enabled() -> Vec<super::definition::ParamDependency> {
    vec![super::definition::ParamDependency {
        param: "background.enabled".to_string(),
        equals: ParamValue::Bool(true),
    }]
}

fn select(
    key: &str,
    label: &str,
    default: &str,
    options: &[(&str, &str)],
) -> ParamDefinition {
    ParamDefinition::Select {
        key: key.to_string(),
        label: label.to_string(),
        default: default.to_string(),
        options: options
            .iter()
            .map(|(value, label)| SelectOption {
                value: (*value).to_string(),
                label: (*label).to_string(),
            })
            .collect(),
        keyframable: Some(false),
        group: None,
        dependencies: Vec::new(),
    }
}

const BLEND_MODE_OPTIONS: &[(&str, &str)] = &[
    ("normal", "Normal"),
    ("darken", "Darken"),
    ("multiply", "Multiply"),
    ("color-burn", "Color Burn"),
    ("lighten", "Lighten"),
    ("screen", "Screen"),
    ("plus-lighter", "Plus Lighter"),
    ("color-dodge", "Color Dodge"),
    ("overlay", "Overlay"),
    ("soft-light", "Soft Light"),
    ("hard-light", "Hard Light"),
    ("difference", "Difference"),
    ("exclusion", "Exclusion"),
    ("hue", "Hue"),
    ("saturation", "Saturation"),
    ("color", "Color"),
    ("luminosity", "Luminosity"),
];

/// The Adjust panel, laid out the way a colourist works: what the colour is,
/// then how the light falls, then what is done to the grain of the picture. Each
/// group resets as a unit, so a whole pass can be thrown away without touching
/// the rest.
///
/// Every slider here has to reach for something none of its neighbours can. Two
/// did not, and are gone: Shine was Brightness with a softer roll-off, and Fade
/// was a black lift plus a saturation drop, which is Shadow and Saturation put
/// together. The group is called Texture rather than Effects because the tab rail
/// already has an Effects tab, and two lists under one word is one too many.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentParamGroup {
    pub title: String,
    pub keys: Vec<String>,
}

const ADJUSTMENT_GROUPS: &[(&str, &[&str])] = &[
    (
        "Color",
        &["adjust.saturation", "adjust.temperature", "adjust.hue"],
    ),
    (
        "Lightness",
        &["adjust.brightness", "adjust.contrast", "adjust.shadow"],
    ),
    (
        "Texture",
        &["adjust.sharpness", "adjust.vignette", "adjust.grain"],
    ),
];

pub fn adjustment_param_groups() -> Vec<AdjustmentParamGroup> {
    ADJUSTMENT_GROUPS
        .iter()
        .map(|(title, keys)| AdjustmentParamGroup {
            title: (*title).to_string(),
            keys: keys.iter().map(|key| (*key).to_string()).collect(),
        })
        .collect()
}

/// The keys the Adjust tab lists, in the order it lists them.
pub fn adjustment_param_keys() -> Vec<String> {
    ADJUSTMENT_GROUPS
        .iter()
        .flat_map(|(_, keys)| keys.iter().map(|key| (*key).to_string()))
        .collect()
}

const LUMINANCE_GRADIENT: &str = "linear-gradient(to right, #26262e, #ffffff)";

/// Adjust sliders are integers on the same -100..100 scale (0 = leave it alone)
/// that the adjustment definitions read, so the panel stores exactly what the
/// maths consumes. `signed: false` is for the ones that only add — grain cannot
/// be removed from a clean frame — which start at the left instead of the middle.
///
/// A track gradient is given only where the ramp means something: dark to bright,
/// cool to warm, grey to saturated. Sliders whose ends have no colour to show,
/// such as sharpness, keep a plain track rather than a decorative one.
fn adjust_param(
    key: &str,
    label: &str,
    signed: bool,
    track_gradient: Option<&str>,
) -> ParamDefinition {
    with_number(
        number(
            &format!("adjust.{key}"),
            label,
            0.0,
            if signed { -100.0 } else { 0.0 },
            Some(100.0),
            1.0,
        ),
        |fields| {
            fields.control = Some(NumberControl::Slider);
            fields.track_gradient = track_gradient.map(str::to_string);
        },
    )
}

fn adjustment_element_params() -> Vec<ParamDefinition> {
    vec![
        adjust_param(
            "saturation",
            "Saturation",
            true,
            Some("linear-gradient(to right, #55555f, #22e06a)"),
        ),
        adjust_param(
            "temperature",
            "Temperature",
            true,
            // The ends mirror the cool/warm washes the temperature adjustment
            // paints.
            Some("linear-gradient(to right, #2f9dff, #8b8b96 50%, #ff7a2f)"),
        ),
        adjust_param(
            "hue",
            "Hue",
            true,
            Some(
                "linear-gradient(to right, #ff2f6a, #ffd12f, #22e06a, #2f9dff, #a12fff, #ff2f6a)",
            ),
        ),
        adjust_param("brightness", "Brightness", true, Some(LUMINANCE_GRADIENT)),
        adjust_param("contrast", "Contrast", true, Some(LUMINANCE_GRADIENT)),
        adjust_param("shadow", "Shadow", true, None),
        adjust_param("sharpness", "Sharpness", false, None),
        adjust_param("vignette", "Vignette", false, None),
        adjust_param("grain", "Grain", false, None),
    ]
}

fn px(param: ParamDefinition) -> ParamDefinition {
    with_number(param, |fields| fields.suffix = Some("px".to_string()))
}

fn visual_element_params() -> Vec<ParamDefinition> {
    vec![
        px(number(
            "transform.positionX",
            "Position X",
            defaults::TRANSFORM.position_x,
            -100_000.0,
            None,
            1.0,
        )),
        px(number(
            "transform.positionY",
            "Position Y",
            defaults::TRANSFORM.position_y,
            -100_000.0,
            None,
            1.0,
        )),
        with_number(
            number(
                "transform.scaleX",
                "Scale X",
                defaults::TRANSFORM.scale_x,
                defaults::MIN_TRANSFORM_SCALE,
                None,
                0.01,
            ),
            |fields| fields.suffix = Some("x".to_string()),
        ),
        with_number(
            number(
                "transform.scaleY",
                "Scale Y",
                defaults::TRANSFORM.scale_y,
                defaults::MIN_TRANSFORM_SCALE,
                None,
                0.01,
            ),
            |fields| fields.suffix = Some("x".to_string()),
        ),
        with_number(
            number(
                "transform.rotate",
                "Rotate",
                defaults::TRANSFORM.rotate,
                -360.0,
                Some(360.0),
                1.0,
            ),
            |fields| fields.suffix = Some("°".to_string()),
        ),
        with_number(
            number("opacity", "Opacity", defaults::OPACITY, 0.0, Some(1.0), 0.01),
            |fields| {
                fields.unit = Some(ParamUnit::Percent);
                // Reads as one more of the Adjust panel's sliders, which is the
                // only place it is shown. The slider works in stored 0..1 space
                // while the number field beside it still shows a percentage.
                fields.control = Some(NumberControl::Slider);
            },
        ),
        select(
            "blendMode",
            "Blend Mode",
            defaults::BLEND_MODE,
            BLEND_MODE_OPTIONS,
        ),
    ]
}

/// How much of each edge the clip throws away, as a fraction of that side of the
/// source. Stored 0..1 and shown as a percentage, so a crop copied between clips
/// of different sizes trims the same proportion of each.
///
/// Not keyframable: the cropped size is what everything downstream fits to the
/// canvas, so animating it would move the layer's whole geometry frame by frame —
/// an effect that belongs to Transform's position and scale, which are animated.
fn crop_param(key: &str, label: &str) -> ParamDefinition {
    with_number(
        number(&format!("crop.{key}"), label, 0.0, 0.0, Some(1.0), 0.01),
        |fields| {
            fields.unit = Some(ParamUnit::Percent);
            fields.control = Some(NumberControl::Slider);
            fields.keyframable = Some(false);
        },
    )
}

fn crop_element_params() -> Vec<ParamDefinition> {
    vec![
        crop_param("left", "Left"),
        crop_param("right", "Right"),
        crop_param("top", "Top"),
        crop_param("bottom", "Bottom"),
    ]
}

/// Only footage and stills carry the colour/tone sliders. Grading text, a sticker
/// or a vector shape means grading something whose colour was chosen outright in
/// the panel above — the sliders would be fighting the author rather than
/// correcting a camera.
///
/// Cropping is scoped the same way, for the same reason in reverse: a shape or a
/// line of text is drawn at exactly the size it was authored, so there are no
/// edges of a source frame to trim off it.
fn media_element_params() -> Vec<ParamDefinition> {
    let mut params = visual_element_params();
    params.extend(crop_element_params());
    params.extend(adjustment_element_params());
    params
}

fn audio_element_params() -> Vec<ParamDefinition> {
    vec![
        with_number(
            number(
                "volume",
                "Volume",
                defaults::VOLUME,
                defaults::VOLUME_DB_MIN,
                Some(defaults::VOLUME_DB_MAX),
                0.01,
            ),
            |fields| fields.suffix = Some("dB".to_string()),
        ),
        ParamDefinition::Boolean {
            key: "muted".to_string(),
            label: "Muted".to_string(),
            default: false,
            keyframable: Some(false),
            group: None,
            dependencies: Vec::new(),
        },
    ]
}

fn text_element_params() -> Vec<ParamDefinition> {
    let background = defaults::text_background();
    vec![
        ParamDefinition::Text {
            key: "content".to_string(),
            label: "Content".to_string(),
            default: "Default text".to_string(),
            keyframable: Some(false),
            group: None,
            dependencies: Vec::new(),
        },
        ParamDefinition::Font {
            key: "fontFamily".to_string(),
            label: "Font Family".to_string(),
            default: "Arial".to_string(),
            keyframable: Some(false),
            group: None,
            dependencies: Vec::new(),
        },
        px(number("fontSize", "Font Size", 15.0, 1.0, None, 1.0)),
        ParamDefinition::Color {
            key: "color".to_string(),
            label: "Color".to_string(),
            default: "#ffffff".to_string(),
            keyframable: None,
            group: None,
            dependencies: Vec::new(),
            control: None,
        },
        select(
            "textAlign",
            "Text Align",
            "center",
            &[("left", "Left"), ("center", "Center"), ("right", "Right")],
        ),
        select(
            "fontWeight",
            "Font Weight",
            "normal",
            &[("normal", "Normal"), ("bold", "Bold")],
        ),
        select(
            "fontStyle",
            "Font Style",
            "normal",
            &[("normal", "Normal"), ("italic", "Italic")],
        ),
        select(
            "textDecoration",
            "Text Decoration",
            "none",
            &[
                ("none", "None"),
                ("underline", "Underline"),
                ("line-through", "Line Through"),
            ],
        ),
        px(number(
            "letterSpacing",
            "Letter Spacing",
            defaults::TEXT_LETTER_SPACING,
            -100.0,
            None,
            0.1,
        )),
        number(
            "lineHeight",
            "Line Height",
            defaults::TEXT_LINE_HEIGHT,
            0.1,
            None,
            0.1,
        ),
        ParamDefinition::Boolean {
            key: "background.enabled".to_string(),
            label: "Background Enabled".to_string(),
            default: background.enabled,
            keyframable: Some(false),
            group: None,
            dependencies: Vec::new(),
        },
        ParamDefinition::Color {
            key: "background.color".to_string(),
            label: "Background Color".to_string(),
            default: background.color.clone(),
            keyframable: None,
            group: None,
            dependencies: background_enabled(),
            control: None,
        },
        with_number(
            px(number(
                "background.cornerRadius",
                "Background Radius",
                background.corner_radius,
                defaults::CORNER_RADIUS_MIN,
                Some(defaults::CORNER_RADIUS_MAX),
                1.0,
            )),
            |fields| {
                fields.suffix = Some("px".to_string());
                fields.dependencies = background_enabled();
            },
        ),
        with_number(
            number(
                "background.paddingX",
                "Background Padding X",
                background.padding_x,
                0.0,
                None,
                1.0,
            ),
            |fields| {
                fields.suffix = Some("px".to_string());
                fields.dependencies = background_enabled();
            },
        ),
        with_number(
            number(
                "background.paddingY",
                "Background Padding Y",
                background.padding_y,
                0.0,
                None,
                1.0,
            ),
            |fields| {
                fields.suffix = Some("px".to_string());
                fields.dependencies = background_enabled();
            },
        ),
        with_number(
            number(
                "background.offsetX",
                "Background Offset X",
                background.offset_x,
                -100_000.0,
                None,
                1.0,
            ),
            |fields| {
                fields.suffix = Some("px".to_string());
                fields.dependencies = background_enabled();
            },
        ),
        with_number(
            number(
                "background.offsetY",
                "Background Offset Y",
                background.offset_y,
                -100_000.0,
                None,
                1.0,
            ),
            |fields| {
                fields.suffix = Some("px".to_string());
                fields.dependencies = background_enabled();
            },
        ),
    ]
}

/// The params an element type carries. An effect or adjustment layer has none of
/// its own — each entry in its stack carries the params from its own definition.
pub fn built_in_element_params(element_type: ElementType) -> Vec<ParamDefinition> {
    match element_type {
        ElementType::Video => {
            let mut params = media_element_params();
            params.extend(audio_element_params());
            params
        }
        ElementType::Image => media_element_params(),
        ElementType::Text => {
            let mut params = text_element_params();
            params.extend(visual_element_params());
            params
        }
        ElementType::Sticker | ElementType::Graphic => visual_element_params(),
        ElementType::Audio => audio_element_params(),
        ElementType::Effect | ElementType::Adjustment => Vec::new(),
    }
}

pub fn build_default_param_values(params: &[ParamDefinition]) -> ParamValues {
    params
        .iter()
        .map(|param| (param.key().to_string(), param.default_value()))
        .collect()
}

pub fn element_param(element_type: ElementType, key: &str) -> Option<ParamDefinition> {
    built_in_element_params(element_type)
        .into_iter()
        .find(|param| param.key() == key)
}

/// The stored value, falling back to the definition's default. Every built-in
/// param lives in the element's own bag, so there is nowhere else to look.
pub fn read_element_param_value(
    element: &TimelineElement,
    param: &ParamDefinition,
) -> ParamValue {
    element
        .params
        .get(param.key())
        .cloned()
        .unwrap_or_else(|| param.default_value())
}

// Bridge surface.

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementParamsOptions {
    pub element_type: ElementType,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElementParams {
    pub params: Vec<ParamDefinition>,
}

#[bridge::export]
pub fn get_built_in_element_params(
    ElementParamsOptions { element_type }: ElementParamsOptions,
) -> ElementParams {
    ElementParams {
        params: built_in_element_params(element_type),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ElementParamOptions {
    pub element_type: ElementType,
    pub key: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaybeParamDefinition {
    pub param: Option<ParamDefinition>,
}

#[bridge::export]
pub fn get_element_param(
    ElementParamOptions { element_type, key }: ElementParamOptions,
) -> MaybeParamDefinition {
    MaybeParamDefinition {
        param: element_param(element_type, &key),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DefaultValuesOptions {
    pub params: Vec<ParamDefinition>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefaultParamValues {
    pub values: ParamValues,
}

#[bridge::export]
pub fn build_default_param_values_value(
    DefaultValuesOptions { params }: DefaultValuesOptions,
) -> DefaultParamValues {
    DefaultParamValues {
        values: build_default_param_values(&params),
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentParamLayout {
    pub groups: Vec<AdjustmentParamGroup>,
    pub keys: Vec<String>,
}

#[bridge::export]
pub fn get_adjustment_param_layout() -> AdjustmentParamLayout {
    AdjustmentParamLayout {
        groups: adjustment_param_groups(),
        keys: adjustment_param_keys(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(element_type: ElementType) -> Vec<String> {
        built_in_element_params(element_type)
            .iter()
            .map(|param| param.key().to_string())
            .collect()
    }

    #[test]
    fn a_video_carries_the_visual_crop_grade_and_audio_params() {
        let video = keys(ElementType::Video);
        assert!(video.contains(&"transform.scaleX".to_string()));
        assert!(video.contains(&"crop.left".to_string()));
        assert!(video.contains(&"adjust.saturation".to_string()));
        assert!(video.contains(&"volume".to_string()));
    }

    #[test]
    fn a_still_carries_everything_a_video_does_except_sound() {
        let image = keys(ElementType::Image);
        assert!(image.contains(&"crop.left".to_string()));
        assert!(!image.contains(&"volume".to_string()));
        assert!(!image.contains(&"muted".to_string()));
    }

    #[test]
    fn authored_content_is_neither_graded_nor_cropped() {
        for element_type in [ElementType::Text, ElementType::Sticker, ElementType::Graphic] {
            let params = keys(element_type);
            assert!(
                !params.contains(&"adjust.saturation".to_string()),
                "{element_type:?} should not be gradeable"
            );
            assert!(
                !params.contains(&"crop.left".to_string()),
                "{element_type:?} should not be croppable"
            );
            assert!(params.contains(&"opacity".to_string()));
        }
    }

    #[test]
    fn a_layer_with_no_pixels_of_its_own_has_no_params() {
        assert!(keys(ElementType::Effect).is_empty());
        assert!(keys(ElementType::Adjustment).is_empty());
    }

    #[test]
    fn every_param_key_is_listed_once_per_element_type() {
        for element_type in [
            ElementType::Video,
            ElementType::Image,
            ElementType::Text,
            ElementType::Sticker,
            ElementType::Graphic,
            ElementType::Audio,
        ] {
            let listed = keys(element_type);
            let mut unique = listed.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(
                listed.len(),
                unique.len(),
                "{element_type:?} lists a param twice"
            );
        }
    }

    #[test]
    fn the_defaults_come_from_the_definitions() {
        let values = build_default_param_values(&built_in_element_params(ElementType::Text));
        assert_eq!(values["opacity"], ParamValue::Number(1.0));
        assert_eq!(values["lineHeight"], ParamValue::Number(1.2));
        assert_eq!(
            values["blendMode"],
            ParamValue::Text("normal".to_string())
        );
        assert_eq!(values["background.enabled"], ParamValue::Bool(false));
    }

    #[test]
    fn an_adjust_slider_that_only_adds_starts_at_the_left() {
        let grain = element_param(ElementType::Video, "adjust.grain").expect("grain exists");
        let ParamDefinition::Number { min, max, .. } = grain else {
            panic!("grain is a number");
        };
        assert_eq!(min, 0.0);
        assert_eq!(max, Some(100.0));

        let hue = element_param(ElementType::Video, "adjust.hue").expect("hue exists");
        let ParamDefinition::Number { min, .. } = hue else {
            panic!("hue is a number");
        };
        assert_eq!(min, -100.0);
    }

    #[test]
    fn the_adjust_tab_lists_every_grade_slider_the_registry_has() {
        let listed = adjustment_param_keys();
        let registered: Vec<String> = keys(ElementType::Video)
            .into_iter()
            .filter(|key| key.starts_with("adjust."))
            .collect();
        let mut sorted_listed = listed.clone();
        sorted_listed.sort();
        let mut sorted_registered = registered;
        sorted_registered.sort();
        assert_eq!(sorted_listed, sorted_registered);
    }

    #[test]
    fn the_text_background_params_hide_until_the_background_is_on() {
        let color = element_param(ElementType::Text, "background.color").expect("exists");
        let ParamDefinition::Color { dependencies, .. } = color else {
            panic!("a colour");
        };
        assert_eq!(dependencies.len(), 1);
        assert_eq!(dependencies[0].param, "background.enabled");
        assert_eq!(dependencies[0].equals, ParamValue::Bool(true));
    }

    #[test]
    fn a_crop_inset_is_not_keyframable() {
        let left = element_param(ElementType::Video, "crop.left").expect("exists");
        let ParamDefinition::Number { keyframable, .. } = left else {
            panic!("a number");
        };
        assert_eq!(keyframable, Some(false));
    }

    #[test]
    fn an_unknown_key_answers_nothing() {
        assert!(element_param(ElementType::Video, "nope").is_none());
    }
}
