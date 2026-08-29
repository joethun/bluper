//! Which stored keys under an element's `animations` are property paths the
//! editor recognises.
//!
//! The list is not just documentation. `get_element_keyframes` filters an
//! element's channels through [`is_animation_path`], so a path missing from it
//! keyframes correctly but draws no diamond on the clip and never snaps the
//! playhead. Two of the three forms are open-ended — a graphic's own params and
//! an effect instance's params — and are recognised by shape rather than by
//! being listed.

use bridge::export;
use serde::{Deserialize, Serialize};

/// The fixed property paths: an element's transform, its text, its background,
/// and the Adjust panel's sliders.
pub const ANIMATION_PROPERTY_PATHS: &[&str] = &[
    "transform.positionX",
    "transform.positionY",
    "transform.scaleX",
    "transform.scaleY",
    "transform.rotate",
    "opacity",
    "volume",
    "fontSize",
    "letterSpacing",
    "lineHeight",
    "color",
    "background.color",
    "background.paddingX",
    "background.paddingY",
    "background.offsetX",
    "background.offsetY",
    "background.cornerRadius",
    "adjust.saturation",
    "adjust.temperature",
    "adjust.hue",
    "adjust.brightness",
    "adjust.contrast",
    "adjust.shadow",
    "adjust.sharpness",
    "adjust.vignette",
    "adjust.grain",
];

const GRAPHIC_PARAM_PATH_PREFIX: &str = "params.";
const EFFECT_PARAM_PATH_PREFIX: &str = "effects.";
const EFFECT_PARAM_PATH_SUFFIX: &str = ".params.";

/// Keys an older version of the editor stored animations under. They are not
/// property paths, and reading them as such would invent keyframes.
const LEGACY_ANIMATION_STORAGE_KEYS: &[&str] = &["bindings", "channels"];

pub fn is_animation_property_path(property_path: &str) -> bool {
    ANIMATION_PROPERTY_PATHS.contains(&property_path)
}

pub fn is_graphic_param_path(property_path: &str) -> bool {
    property_path.starts_with(GRAPHIC_PARAM_PATH_PREFIX)
}

pub fn is_effect_param_path(property_path: &str) -> bool {
    property_path.starts_with(EFFECT_PARAM_PATH_PREFIX)
        && property_path.contains(EFFECT_PARAM_PATH_SUFFIX)
}

pub fn is_animation_path(property_path: &str) -> bool {
    is_animation_property_path(property_path)
        || is_graphic_param_path(property_path)
        || is_effect_param_path(property_path)
}

pub fn is_animation_storage_key(key: &str) -> bool {
    !LEGACY_ANIMATION_STORAGE_KEYS.contains(&key)
}

pub fn graphic_param_path(param_key: &str) -> String {
    format!("{GRAPHIC_PARAM_PATH_PREFIX}{param_key}")
}

/// The param key inside a `params.<key>` path.
pub fn parse_graphic_param_path(property_path: &str) -> Option<&str> {
    let param_key = property_path.strip_prefix(GRAPHIC_PARAM_PATH_PREFIX)?;
    (!param_key.is_empty()).then_some(param_key)
}

pub fn effect_param_path(effect_id: &str, param_key: &str) -> String {
    format!("{EFFECT_PARAM_PATH_PREFIX}{effect_id}{EFFECT_PARAM_PATH_SUFFIX}{param_key}")
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectParamPathParts {
    pub effect_id: String,
    pub param_key: String,
}

/// The effect instance and param key inside an `effects.<id>.params.<key>` path.
/// The id is everything before the *first* `.params.`, so an id containing that
/// literal would split at the wrong place — ids are generated, so none does.
pub fn parse_effect_param_path(property_path: &str) -> Option<EffectParamPathParts> {
    let rest = property_path.strip_prefix(EFFECT_PARAM_PATH_PREFIX)?;
    let separator = rest.find(EFFECT_PARAM_PATH_SUFFIX)?;
    let effect_id = &rest[..separator];
    let param_key = &rest[separator + EFFECT_PARAM_PATH_SUFFIX.len()..];
    if effect_id.is_empty() || param_key.is_empty() {
        return None;
    }
    Some(EffectParamPathParts {
        effect_id: effect_id.to_string(),
        param_key: param_key.to_string(),
    })
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPathOptions {
    pub property_path: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageKeyOptions {
    pub key: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParamKeyOptions {
    pub param_key: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EffectParamPathBuilderOptions {
    pub effect_id: String,
    pub param_key: String,
}

#[export]
pub fn is_animation_property_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> bool {
    is_animation_property_path(&property_path)
}

#[export]
pub fn is_graphic_param_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> bool {
    is_graphic_param_path(&property_path)
}

#[export]
pub fn is_effect_param_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> bool {
    is_effect_param_path(&property_path)
}

#[export]
pub fn is_animation_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> bool {
    is_animation_path(&property_path)
}

#[export]
pub fn is_animation_storage_key_value(
    StorageKeyOptions { key }: StorageKeyOptions,
) -> bool {
    is_animation_storage_key(&key)
}

#[export]
pub fn graphic_param_path_value(ParamKeyOptions { param_key }: ParamKeyOptions) -> String {
    graphic_param_path(&param_key)
}

/// `parse_graphic_param_path` returns a borrow, which won't cross the wasm
/// boundary. The exported form hands back an owned string and discards the
/// borrow once the message has been built.
#[export]
pub fn parse_graphic_param_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> Option<String> {
    parse_graphic_param_path(&property_path).map(str::to_string)
}

#[export]
pub fn effect_param_path_value(
    EffectParamPathBuilderOptions {
        effect_id,
        param_key,
    }: EffectParamPathBuilderOptions,
) -> String {
    effect_param_path(&effect_id, &param_key)
}

#[export]
pub fn parse_effect_param_path_value(
    PropertyPathOptions { property_path }: PropertyPathOptions,
) -> Option<EffectParamPathParts> {
    parse_effect_param_path(&property_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_each_of_the_three_forms() {
        assert!(is_animation_path("transform.scaleX"));
        assert!(is_animation_path("adjust.grain"));
        assert!(is_animation_path("params.radius"));
        assert!(is_animation_path("effects.abc123.params.amount"));
    }

    #[test]
    fn refuses_a_key_that_is_not_a_property_path() {
        assert!(!is_animation_path("transform"));
        assert!(!is_animation_path("effects.abc123.enabled"));
        assert!(!is_animation_path(""));
    }

    #[test]
    fn a_legacy_storage_key_is_not_read_as_a_path() {
        assert!(!is_animation_storage_key("bindings"));
        assert!(!is_animation_storage_key("channels"));
        assert!(is_animation_storage_key("opacity"));
    }

    #[test]
    fn splits_an_effect_param_path_at_its_first_separator() {
        assert_eq!(
            parse_effect_param_path("effects.abc.params.amount"),
            Some(EffectParamPathParts {
                effect_id: "abc".to_string(),
                param_key: "amount".to_string(),
            })
        );
        assert_eq!(parse_effect_param_path("effects..params.amount"), None);
        assert_eq!(parse_effect_param_path("effects.abc.params."), None);
        assert_eq!(parse_effect_param_path("params.amount"), None);
    }

    #[test]
    fn splits_a_graphic_param_path() {
        assert_eq!(parse_graphic_param_path("params.radius"), Some("radius"));
        assert_eq!(parse_graphic_param_path("params."), None);
        assert_eq!(parse_graphic_param_path("radius"), None);
    }
}
