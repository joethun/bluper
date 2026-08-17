use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

// `rename_all` renames the *variants*; the fields of a struct variant need
// `rename_all_fields`. Without it `SceneEffect` looks for `effect_pass_groups`
// while the frame builder sends `effectPassGroups`, and since the field has no
// `#[serde(default)]` the whole frame fails to deserialize — every effect layer
// takes the frame it's on down with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    pub mask: Option<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frame builder emits camelCase for every descriptor field. A struct
    /// variant is the one place serde needs to be told twice, so pin it.
    #[test]
    fn scene_effect_deserializes_from_camel_case() {
        let json = r#"{
            "type": "sceneEffect",
            "effectPassGroups": [[{ "shader": "blur", "uniforms": { "radius": 4.0 } }]]
        }"#;
        let item: FrameItemDescriptor = serde_json::from_str(json).expect("camelCase frame item");
        match item {
            FrameItemDescriptor::SceneEffect { effect_pass_groups } => {
                assert_eq!(effect_pass_groups.len(), 1);
                assert_eq!(effect_pass_groups[0][0].shader, "blur");
            }
            other => panic!("expected a scene effect, got {other:?}"),
        }
    }
}
