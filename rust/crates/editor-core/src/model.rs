//! The timeline document: scenes, tracks and the elements on them.
//!
//! These types carry no `Tsify` derive on purpose. Nothing exports a function
//! that takes or returns one yet, and tsify cannot render `#[serde(flatten)]`
//! over an internally-tagged enum as valid TypeScript — it emits
//! `interface TimelineElement extends ElementKind`, and an interface cannot
//! extend a union. `skipLibCheck: true` in `apps/web/tsconfig.json` would hide
//! that rather than fail on it. The flatten stays because it is what keeps the
//! shared fields written once and gives commands a plain `element.start_time`;
//! the boundary shape gets designed when there is a caller to design it for.
//!
//! Faithful round-tripping is the requirement here, not completeness. A command
//! that rewrites a tree must hand back everything it was given, so the parts
//! this module does not describe yet — effects, masks, adjustments, transitions
//! and animation channels — are carried as opaque [`serde_json::Value`]s rather
//! than dropped on the floor. They get real types when the code that reads them
//! moves; until then the invariant that matters is that nothing is lost.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::MediaTime;

/// A parameter value as the document stores one.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

pub type ParamValues = HashMap<String, ParamValue>;

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetimeCurvePoint {
    /// A fraction of the clip's visible source span rather than a time, so the
    /// shape survives trimming.
    pub position: f64,
    pub rate: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RetimeCurvePresetId {
    Custom,
    Montage,
    Hero,
    Bullet,
    JumpCut,
    FlashIn,
    FlashOut,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetimeCurve {
    pub preset: RetimeCurvePresetId,
    pub points: Vec<RetimeCurvePoint>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RetimeConfig {
    /// The uniform speed, or the average when `curve` is set.
    pub rate: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintain_pitch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curve: Option<RetimeCurve>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreezeConfig {
    /// An absolute source time, already past `trimStart`.
    pub source_time: MediaTime,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FadeConfig {
    #[serde(default, rename = "in", skip_serializing_if = "Option::is_none")]
    pub fade_in: Option<MediaTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<MediaTime>,
}

/// A stack entry on an element: a named effect with its own parameter bag.
/// `Adjustment` is the same shape — the two are kept apart because they sit in
/// different fields and a future change to one should not silently reshape the
/// other.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: String,
    #[serde(rename = "type")]
    pub effect_type: String,
    pub params: ParamValues,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Adjustment {
    pub id: String,
    #[serde(rename = "type")]
    pub adjustment_type: String,
    pub params: ParamValues,
    pub enabled: bool,
}

/// A transition borrowed from the neighbouring clip, entering this one.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ElementTransition {
    pub id: String,
    #[serde(rename = "type")]
    pub transition_type: String,
    pub duration: MediaTime,
    pub params: ParamValues,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChannelExtrapolationMode {
    Hold,
    Linear,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelExtrapolation {
    pub before: ChannelExtrapolationMode,
    pub after: ChannelExtrapolationMode,
}

/// A keyframe on a channel whose value is not interpolated — a boolean or an
/// enumerated string, which can only be held until the next key.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscreteAnimationKey {
    pub id: String,
    pub time: MediaTime,
    pub value: DiscreteValue,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum DiscreteValue {
    Bool(bool),
    Text(String),
}

/// One property's keys over time.
///
/// Scalar and discrete channels are told apart the way the TypeScript tells
/// them apart — by whether the keys carry `segmentToNext`, or the channel
/// carries `extrapolation` — so the untagged representation has to try the
/// scalar shape first. A discrete key would not deserialise as a scalar one
/// (its value is a bool or a string, not a number), which is what makes the
/// order safe.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum AnimationChannel {
    Scalar {
        keys: Vec<super::animation::ScalarAnimationKey>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        extrapolation: Option<ChannelExtrapolation>,
    },
    Discrete {
        keys: Vec<DiscreteAnimationKey>,
    },
}

/// A property path maps either to a single channel or, for a value with
/// components (a colour's r/g/b/a), to one channel per component.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum ChannelData {
    Channel(AnimationChannel),
    Composite(HashMap<String, AnimationChannel>),
}

/// Keyed by property path — `"opacity"`, `"transform.scaleX"`,
/// `"effects.<id>.params.<key>"`.
pub type ElementAnimations = HashMap<String, ChannelData>;

/// What distinguishes one element type from another. Split from the shared
/// fields so the common half is written once; `#[serde(flatten)]` puts them back
/// into one object on the wire, which is the shape TypeScript already stores.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ElementKind {
    Audio {
        source_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        media_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retime: Option<RetimeConfig>,
    },
    Video {
        media_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        is_source_audio_enabled: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retime: Option<RetimeConfig>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        freeze: Option<FreezeConfig>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effects: Option<Vec<Effect>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        masks: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition_in: Option<ElementTransition>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade: Option<FadeConfig>,
    },
    Image {
        media_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effects: Option<Vec<Effect>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        masks: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transition_in: Option<ElementTransition>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade: Option<FadeConfig>,
    },
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fade: Option<FadeConfig>,
    },
    Sticker {
        sticker_id: String,
        /// Natural dimensions recorded at insert time, so the renderer and the
        /// preview bounds cannot disagree about the asset's geometry.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intrinsic_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intrinsic_height: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effects: Option<Vec<Effect>>,
    },
    Graphic {
        definition_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effects: Option<Vec<Effect>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        masks: Option<Value>,
    },
    Effect {
        effect_type: String,
    },
    /// Owns no pixels: a stack of adjustments applied to everything drawn
    /// beneath it, for exactly the span it covers.
    Adjustment {
        adjustments: Vec<Adjustment>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hidden: Option<bool>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineElement {
    pub id: String,
    pub name: String,
    pub duration: MediaTime,
    /// Relative to the start of the track.
    pub start_time: MediaTime,
    pub trim_start: MediaTime,
    pub trim_end: MediaTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_duration: Option<MediaTime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animations: Option<ElementAnimations>,
    pub params: ParamValues,
    #[serde(flatten)]
    pub kind: ElementKind,
}

impl TimelineElement {
    /// The clip's fade, for the kinds that have one. Audio fades on its own
    /// path, so only the visual kinds carry the field.
    pub fn fade(&self) -> Option<&FadeConfig> {
        match &self.kind {
            ElementKind::Video { fade, .. }
            | ElementKind::Image { fade, .. }
            | ElementKind::Text { fade, .. } => fade.as_ref(),
            _ => None,
        }
    }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Track {
    Video {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        muted: bool,
        hidden: bool,
    },
    Text {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        hidden: bool,
    },
    Audio {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        muted: bool,
    },
    Graphic {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        hidden: bool,
    },
    Effect {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        hidden: bool,
    },
    Adjustment {
        id: String,
        name: String,
        elements: Vec<TimelineElement>,
        hidden: bool,
    },
}

impl Track {
    pub fn id(&self) -> &str {
        match self {
            Track::Video { id, .. }
            | Track::Text { id, .. }
            | Track::Audio { id, .. }
            | Track::Graphic { id, .. }
            | Track::Effect { id, .. }
            | Track::Adjustment { id, .. } => id,
        }
    }

    /// The same track carrying different elements. Every transform that edits a
    /// track goes through here so the variant — and the per-variant flags like
    /// `muted` — cannot be lost in the rebuild.
    pub fn with_elements(&self, elements: Vec<TimelineElement>) -> Track {
        match self {
            Track::Video {
                id,
                name,
                muted,
                hidden,
                ..
            } => Track::Video {
                id: id.clone(),
                name: name.clone(),
                elements,
                muted: *muted,
                hidden: *hidden,
            },
            Track::Text { id, name, hidden, .. } => Track::Text {
                id: id.clone(),
                name: name.clone(),
                elements,
                hidden: *hidden,
            },
            Track::Audio { id, name, muted, .. } => Track::Audio {
                id: id.clone(),
                name: name.clone(),
                elements,
                muted: *muted,
            },
            Track::Graphic { id, name, hidden, .. } => Track::Graphic {
                id: id.clone(),
                name: name.clone(),
                elements,
                hidden: *hidden,
            },
            Track::Effect { id, name, hidden, .. } => Track::Effect {
                id: id.clone(),
                name: name.clone(),
                elements,
                hidden: *hidden,
            },
            Track::Adjustment { id, name, hidden, .. } => Track::Adjustment {
                id: id.clone(),
                name: name.clone(),
                elements,
                hidden: *hidden,
            },
        }
    }

    pub fn elements(&self) -> &[TimelineElement] {
        match self {
            Track::Video { elements, .. }
            | Track::Text { elements, .. }
            | Track::Audio { elements, .. }
            | Track::Graphic { elements, .. }
            | Track::Effect { elements, .. }
            | Track::Adjustment { elements, .. } => elements,
        }
    }
}

/// The main video track is a single track rather than a list: there is exactly
/// one, and it is where the primary footage lives.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneTracks {
    pub overlay: Vec<Track>,
    pub main: Track,
    pub audio: Vec<Track>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub time: MediaTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<MediaTime>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree shaped the way storage writes one, including sub-domains this
    /// module deliberately does not type.
    const STORED_TRACKS: &str = r##"{
        "overlay": [
            {
                "id": "t-text",
                "name": "Text",
                "type": "text",
                "hidden": false,
                "elements": [
                    {
                        "id": "e-text",
                        "name": "Title",
                        "type": "text",
                        "duration": 120000,
                        "startTime": 0,
                        "trimStart": 0,
                        "trimEnd": 0,
                        "params": { "opacity": 1, "text": "Hello", "bold": true },
                        "fade": { "in": 6000 },
                        "animations": {
                            "opacity": {
                                "keys": [
                                    {
                                        "id": "k",
                                        "time": 0,
                                        "value": 1,
                                        "segmentToNext": "linear",
                                        "tangentMode": "flat"
                                    }
                                ]
                            },
                            "background.color": {
                                "r": { "keys": [{ "id": "kr", "time": 0, "value": 0.5, "segmentToNext": "linear", "tangentMode": "flat" }] }
                            },
                            "hidden": { "keys": [{ "id": "kh", "time": 0, "value": false }] }
                        }
                    }
                ]
            }
        ],
        "main": {
            "id": "t-main",
            "name": "Main",
            "type": "video",
            "muted": false,
            "hidden": false,
            "elements": [
                {
                    "id": "e-video",
                    "name": "clip.mp4",
                    "type": "video",
                    "mediaId": "m1",
                    "duration": 240000,
                    "startTime": 0,
                    "trimStart": 0,
                    "trimEnd": 0,
                    "sourceDuration": 480000,
                    "params": {},
                    "retime": { "rate": 2, "maintainPitch": true },
                    "effects": [{ "id": "fx", "type": "blur", "params": { "amount": 3 }, "enabled": true }],
                    "masks": [{ "id": "mk", "type": "ellipse", "params": {} }]
                }
            ]
        },
        "audio": []
    }"##;

    /// `serde_json` remembers whether a number was written `2` or `2.0`;
    /// JavaScript does not, and the boundary this model crosses is JavaScript.
    /// Unifying the two is the difference between comparing what the editor
    /// would observe and comparing an artefact of the intermediate encoding.
    /// Nothing else is touched, so a genuinely dropped field still fails.
    fn as_javascript_would_see_it(value: &Value) -> Value {
        match value {
            Value::Number(number) => Value::from(number.as_f64().expect("finite")),
            Value::Array(items) => {
                Value::Array(items.iter().map(as_javascript_would_see_it).collect())
            }
            Value::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(key, nested)| (key.clone(), as_javascript_would_see_it(nested)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn a_stored_tree_round_trips_without_losing_anything() {
        // The strong form of the requirement: whatever a command is handed, it
        // must be able to hand back. Untyped sub-domains included.
        let original: Value = serde_json::from_str(STORED_TRACKS).expect("fixture parses");
        let tracks: SceneTracks =
            serde_json::from_value(original.clone()).expect("model accepts a stored tree");
        let round_tripped = serde_json::to_value(&tracks).expect("model re-serialises");
        assert_eq!(
            as_javascript_would_see_it(&round_tripped),
            as_javascript_would_see_it(&original)
        );
    }

    #[test]
    fn the_round_trip_check_still_notices_a_dropped_field() {
        // Guards the normalisation above: it must not be quietly forgiving.
        let original: Value = serde_json::from_str(STORED_TRACKS).unwrap();
        let mut damaged = original.clone();
        damaged["main"]["elements"][0]
            .as_object_mut()
            .unwrap()
            .remove("mediaId");
        assert_ne!(
            as_javascript_would_see_it(&damaged),
            as_javascript_would_see_it(&original)
        );
    }

    #[test]
    fn effects_are_typed_and_masks_still_ride_through_untouched() {
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let Track::Video { elements, .. } = &tracks.main else {
            panic!("main is a video track");
        };
        let ElementKind::Video { effects, masks, .. } = &elements[0].kind else {
            panic!("the main element is a video");
        };
        // Effects are typed now; masks are still carried opaquely.
        assert_eq!(effects.as_ref().unwrap()[0].effect_type, "blur");
        assert!(effects.as_ref().unwrap()[0].enabled);
        assert_eq!(masks.as_ref().unwrap()[0]["type"], "ellipse");
    }

    #[test]
    fn the_discriminant_and_the_shared_fields_land_in_one_object() {
        // `#[serde(flatten)]` has to produce the shape TypeScript already
        // stores — `type` alongside `id`, not nested under a `kind` key.
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let value = serde_json::to_value(&tracks.main).unwrap();
        let element = &value["elements"][0];
        assert_eq!(element["type"], "video");
        assert_eq!(element["id"], "e-video");
        assert_eq!(element["mediaId"], "m1");
        assert!(element.get("kind").is_none(), "no nested wrapper");
    }

    #[test]
    fn fade_keeps_its_reserved_word_field_name() {
        // `in` is a keyword in Rust, so the field is renamed — and the rename
        // has to survive to the wire or every fade-in silently disappears.
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let value = serde_json::to_value(&tracks.overlay[0]).unwrap();
        assert_eq!(value["elements"][0]["fade"]["in"], 6000);
    }

    #[test]
    fn scalar_composite_and_discrete_channels_are_all_recognised() {
        // The untagged `ChannelData` has to tell three shapes apart: a scalar
        // channel, a per-component map of them, and a discrete channel whose
        // values are booleans rather than numbers.
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let animations = tracks.overlay[0].elements()[0]
            .animations
            .as_ref()
            .expect("the text element is animated");

        assert!(matches!(
            animations["opacity"],
            ChannelData::Channel(AnimationChannel::Scalar { .. })
        ));
        assert!(matches!(
            animations["background.color"],
            ChannelData::Composite(_)
        ));
        assert!(matches!(
            animations["hidden"],
            ChannelData::Channel(AnimationChannel::Discrete { .. })
        ));
    }

    #[test]
    fn param_values_keep_their_javascript_types() {
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let params = &tracks.overlay[0].elements()[0].params;
        assert_eq!(params["opacity"], ParamValue::Number(1.0));
        assert_eq!(params["text"], ParamValue::Text("Hello".to_string()));
        assert_eq!(params["bold"], ParamValue::Bool(true));
    }

    #[test]
    fn an_element_carrying_no_optional_fields_serialises_without_nulls() {
        // `skip_serializing_if` matters: a tree full of explicit nulls is not
        // what the editor wrote, and would show up as a diff on every save.
        let tracks: SceneTracks = serde_json::from_str(STORED_TRACKS).unwrap();
        let value = serde_json::to_value(&tracks.overlay[0].elements()[0]).unwrap();
        assert!(value.get("sourceDuration").is_none());
    }
}
