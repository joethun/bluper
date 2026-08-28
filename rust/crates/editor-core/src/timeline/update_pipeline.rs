//! Applying a patch to an element, and the invariants that follow from it.
//!
//! A patch is a bag of changed fields, so the merge happens at the JSON level
//! exactly as the TypeScript's spread did — there is no typed "partial element",
//! and inventing one would mean enumerating every field of every variant. The
//! merged object is then read back as a [`TimelineElement`] so the rules below
//! work on real types rather than on a map.
//!
//! Two phases, and the order matters. *Derive* rules compute fields that follow
//! from the patch (a new speed implies a new duration). *Enforce* rules then hold
//! the invariants over whatever the derive phase produced (a shorter element
//! cannot keep keyframes past its end). A rule only runs if a field it watches
//! actually changed, so an unrelated patch costs nothing.

use bridge::export;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::MediaTime;

use crate::animation::{ClampAnimationsOptions, clamp_animations_to_duration_inner};
use crate::model::{ElementKind, RetimeConfig, TimelineElement};
use crate::retime::{
    BuildCurveRetimeOptions, SourceSpanAtClipTimeOptions, TimelineDurationOptions,
    build_curve_retime, clamp_retime_rate, get_source_span_at_clip_time,
    get_timeline_duration_for_source_span, retime_curve,
};

/// Only footage walks its source at a speed; the rest have nothing to retime.
fn is_retimable(kind: &ElementKind) -> bool {
    matches!(kind, ElementKind::Video { .. } | ElementKind::Audio { .. })
}

fn retime_of(kind: &ElementKind) -> Option<&RetimeConfig> {
    match kind {
        ElementKind::Video { retime, .. } | ElementKind::Audio { retime, .. } => retime.as_ref(),
        _ => None,
    }
}

fn set_retime(kind: &mut ElementKind, next: Option<RetimeConfig>) {
    match kind {
        ElementKind::Video { retime, .. } | ElementKind::Audio { retime, .. } => *retime = next,
        _ => {}
    }
}

/// Brings an incoming retime into canonical form. A curve arrives from the panel
/// mid-drag, so it is sorted and clamped here rather than trusted, and its
/// average speed is recomputed so `rate` keeps describing the clip.
fn normalize_retime(retime: Option<&RetimeConfig>) -> Option<RetimeConfig> {
    let retime = retime?;
    match retime_curve(Some(retime)) {
        Some(curve) => Some(build_curve_retime(BuildCurveRetimeOptions {
            curve: curve.clone(),
            maintain_pitch: retime.maintain_pitch,
        })),
        None => Some(RetimeConfig {
            rate: clamp_retime_rate(retime.rate),
            maintain_pitch: retime.maintain_pitch,
            curve: None,
        }),
    }
}

/// How much source material the clip covers, trims included. Recorded on the
/// element when known; otherwise recovered from how long it runs.
fn source_duration(element: &TimelineElement) -> f64 {
    if let Some(recorded) = element.source_duration {
        return recorded.as_ticks() as f64;
    }

    let duration = element.duration.as_ticks() as f64;
    element.trim_start.as_ticks() as f64
        + get_source_span_at_clip_time(SourceSpanAtClipTimeOptions {
            clip_time: duration,
            clip_duration: Some(duration),
            retime: retime_of(&element.kind).cloned(),
        })
        + element.trim_end.as_ticks() as f64
}

/// Half away from zero, `-0` normalised — `roundMediaTime`'s rule.
fn round_ticks(time: f64) -> MediaTime {
    let magnitude = time.abs().round();
    if magnitude == 0.0 {
        return MediaTime::ZERO;
    }
    MediaTime::from_ticks(if time < 0.0 {
        -magnitude as i64
    } else {
        magnitude as i64
    })
}

/// Deep-merge in the one place it matters: `params` is a bag, so a patch that
/// sets one param must not drop the others. Everything else replaces wholesale,
/// which is what a spread does.
fn merge_patch(element: &Value, patch: &Value) -> Value {
    let (Some(element_object), Some(patch_object)) = (element.as_object(), patch.as_object())
    else {
        return element.clone();
    };

    let mut merged: Map<String, Value> = element_object.clone();
    for (key, value) in patch_object {
        if key == "params" {
            let mut params = element_object
                .get("params")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(incoming) = value.as_object() {
                for (param_key, param_value) in incoming {
                    params.insert(param_key.clone(), param_value.clone());
                }
            }
            merged.insert("params".to_string(), Value::Object(params));
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    Value::Object(merged)
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyElementUpdateOptions {
    /// The element as stored. Untyped at the boundary because
    /// `TimelineElement`'s `#[serde(flatten)]` has no valid TypeScript rendering;
    /// the façade is where callers get their types.
    #[cfg_attr(feature = "wasm", tsify(type = "unknown"))]
    pub element: Value,
    #[cfg_attr(feature = "wasm", tsify(type = "unknown"))]
    pub patch: Value,
    /// Seed for any keyframe ids the animation clamp has to mint.
    pub id_seed: String,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdatedElement {
    #[cfg_attr(feature = "wasm", tsify(type = "unknown"))]
    pub element: Value,
}

#[export]
pub fn apply_element_update(
    ApplyElementUpdateOptions {
        element,
        patch,
        id_seed,
    }: ApplyElementUpdateOptions,
) -> UpdatedElement {
    let merged = merge_patch(&element, &patch);

    // An element shape this crate does not understand is handed back merged but
    // unruled: the alternative is refusing an edit over a field nobody here
    // reads, which would be worse than applying no derived changes.
    let (Ok(original), Ok(mut next)) = (
        serde_json::from_value::<TimelineElement>(element.clone()),
        serde_json::from_value::<TimelineElement>(merged.clone()),
    ) else {
        return UpdatedElement { element: merged };
    };

    let changed: Vec<String> = patch
        .as_object()
        .map(|fields| fields.keys().cloned().collect())
        .unwrap_or_default();
    let changed_field = |name: &str| changed.iter().any(|field| field == name);

    // --- Derive ---------------------------------------------------------
    // A new speed changes how long the clip runs: the material the trim
    // exposes is fixed, so the duration is whatever getting through it takes.
    let mut duration_changed = changed_field("duration");
    if changed_field("retime") && is_retimable(&next.kind) {
        let normalized = normalize_retime(retime_of(&next.kind));
        let source = source_duration(&original);
        let visible = (source
            - next.trim_start.as_ticks() as f64
            - next.trim_end.as_ticks() as f64)
            .max(0.0);
        let duration = round_ticks(get_timeline_duration_for_source_span(
            TimelineDurationOptions {
                source_span: visible,
                retime: normalized.clone(),
            },
        ));

        set_retime(&mut next.kind, normalized);
        next.duration = duration;
        duration_changed = true;
    }

    // --- Enforce --------------------------------------------------------
    if duration_changed {
        next.animations = clamp_animations_to_duration_inner(ClampAnimationsOptions {
            animations: next.animations.clone(),
            duration: next.duration,
            id_seed,
        });
    }
    if changed_field("startTime") && next.start_time.as_ticks() < 0 {
        // The timeline begins at zero and nothing may sit before it. That is the
        // only constraint on where an element starts: a track — the main one
        // included — is free to open with a gap.
        next.start_time = MediaTime::ZERO;
    }

    UpdatedElement {
        element: serde_json::to_value(&next).unwrap_or(merged),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn video(overrides: Value) -> Value {
        let mut element = json!({
            "id": "e1",
            "name": "clip.mp4",
            "type": "video",
            "mediaId": "m1",
            "duration": 4000,
            "startTime": 0,
            "trimStart": 0,
            "trimEnd": 0,
            "sourceDuration": 4000,
            "params": { "opacity": 1, "volume": 0.8 }
        });
        for (key, value) in overrides.as_object().expect("object") {
            element[key] = value.clone();
        }
        element
    }

    fn apply(element: Value, patch: Value) -> Value {
        apply_element_update(ApplyElementUpdateOptions {
            element,
            patch,
            id_seed: "seed".to_string(),
        })
        .element
    }

    #[test]
    fn a_patch_replaces_fields_but_merges_params() {
        let updated = apply(
            video(json!({})),
            json!({ "name": "renamed", "params": { "opacity": 0.5 } }),
        );
        assert_eq!(updated["name"], "renamed");
        assert_eq!(updated["params"]["opacity"], 0.5);
        // The param the patch did not mention has to survive.
        assert_eq!(updated["params"]["volume"], 0.8);
    }

    #[test]
    fn a_new_speed_resizes_the_clip() {
        let updated = apply(
            video(json!({})),
            json!({ "retime": { "rate": 2, "maintainPitch": false } }),
        );
        // 4000 ticks of source at 2x runs for 2000.
        assert_eq!(updated["duration"], 2000);
        assert_eq!(updated["retime"]["rate"], 2.0);
    }

    #[test]
    fn a_speed_outside_the_bounds_is_clamped_before_it_resizes_anything() {
        let updated = apply(video(json!({})), json!({ "retime": { "rate": 500 } }));
        assert_eq!(updated["retime"]["rate"], 5.0);
        assert_eq!(updated["duration"], 800);
    }

    #[test]
    fn trims_narrow_the_material_a_speed_change_has_to_get_through() {
        let updated = apply(
            video(json!({ "trimStart": 1000, "trimEnd": 500 })),
            json!({ "retime": { "rate": 1 } }),
        );
        // 4000 source, 1500 trimmed away, so 2500 at 1x.
        assert_eq!(updated["duration"], 2500);
    }

    #[test]
    fn a_type_that_cannot_be_retimed_keeps_its_duration() {
        let text = json!({
            "id": "t1", "name": "Title", "type": "text",
            "duration": 4000, "startTime": 0, "trimStart": 0, "trimEnd": 0,
            "params": {}
        });
        let updated = apply(text, json!({ "retime": { "rate": 4 } }));
        assert_eq!(updated["duration"], 4000);
    }

    #[test]
    fn shortening_the_clip_drops_keyframes_past_its_end() {
        let element = video(json!({
            "animations": {
                "opacity": {
                    "keys": [
                        { "id": "a", "time": 0, "value": 0.0, "segmentToNext": "linear", "tangentMode": "flat" },
                        { "id": "b", "time": 3500, "value": 1.0, "segmentToNext": "linear", "tangentMode": "flat" }
                    ]
                }
            }
        }));
        let updated = apply(element, json!({ "duration": 1000 }));
        let keys = updated["animations"]["opacity"]["keys"]
            .as_array()
            .expect("still animated");
        assert!(
            keys.iter().all(|key| key["time"].as_i64().unwrap() <= 1000),
            "a keyframe outlived the element: {keys:?}"
        );
    }

    #[test]
    fn a_negative_start_time_is_pulled_back_to_zero() {
        let updated = apply(video(json!({})), json!({ "startTime": -500 }));
        assert_eq!(updated["startTime"], 0);
    }

    #[test]
    fn a_start_time_is_only_checked_when_the_patch_touches_it() {
        // The element already sits before zero and the patch says nothing about
        // it, so the rule does not fire — matching the trigger-driven design.
        let updated = apply(video(json!({ "startTime": -500 })), json!({ "name": "x" }));
        assert_eq!(updated["startTime"], -500);
    }

    #[test]
    fn an_unrelated_patch_leaves_everything_else_alone() {
        let before = video(json!({}));
        let updated = apply(before.clone(), json!({ "name": "renamed" }));
        assert_eq!(updated["duration"], before["duration"]);
        assert_eq!(updated["startTime"], before["startTime"]);
    }

    #[test]
    fn an_element_shape_this_crate_does_not_know_is_merged_and_returned() {
        let alien = json!({ "id": "x", "type": "somethingNew", "duration": 10 });
        let updated = apply(alien, json!({ "duration": 20 }));
        assert_eq!(updated["duration"], 20);
        assert_eq!(updated["type"], "somethingNew");
    }
}
