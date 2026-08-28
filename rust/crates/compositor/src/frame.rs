use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    /// The canvas coordinate space every transform, sigma and feather in this
    /// frame is written in — the project's resolution, not necessarily the
    /// number of pixels the frame is drawn at.
    pub width: u32,
    pub height: u32,
    /// What fraction of `width` × `height` to actually render, in (0, 1].
    ///
    /// Lets the preview render below the project's resolution without any of
    /// the frame's geometry changing: the layer pass maps the canvas space onto
    /// whatever target it is given, so the picture is the same one, sampled to
    /// fewer pixels. That is the lever behind playback resolution — see
    /// `preview/render-scale.ts`.
    #[serde(default = "default_render_scale")]
    pub render_scale: f32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

fn default_render_scale() -> f32 {
    1.0
}

impl FrameDescriptor {
    /// `render_scale`, with anything out of range or non-finite treated as full
    /// resolution rather than as a reason to fail the frame.
    pub fn clamped_render_scale(&self) -> f32 {
        if self.render_scale.is_finite() && self.render_scale > 0.0 {
            self.render_scale.min(1.0)
        } else {
            1.0
        }
    }

    /// How many pixels this frame is drawn at. At least 1×1: a viewport of zero
    /// is not a legal render target.
    pub fn target_size(&self) -> (u32, u32) {
        let scale = self.clamped_render_scale();
        (
            ((self.width as f32 * scale).round() as u32).max(1),
            ((self.height as f32 * scale).round() as u32).max(1),
        )
    }
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

    fn frame(width: u32, height: u32, render_scale: f32) -> FrameDescriptor {
        FrameDescriptor {
            width,
            height,
            render_scale,
            clear: CanvasClearDescriptor {
                color: [0.0, 0.0, 0.0, 1.0],
            },
            items: Vec::new(),
        }
    }

    #[test]
    fn full_scale_renders_at_the_canvas_size() {
        assert_eq!(frame(1920, 1080, 1.0).target_size(), (1920, 1080));
    }

    #[test]
    fn a_reduced_scale_rounds_to_whole_pixels() {
        assert_eq!(frame(1920, 1080, 0.5).target_size(), (960, 540));
        assert_eq!(frame(1921, 1081, 0.5).target_size(), (961, 541));
    }

    /// A viewport of zero pixels is not a legal render target, and the scale can
    /// reach one on a canvas small enough — a 4x4 thumbnail at an eighth.
    #[test]
    fn a_tiny_frame_still_has_a_pixel() {
        assert_eq!(frame(4, 4, 0.125).target_size(), (1, 1));
    }

    /// A scale that makes no sense renders at full resolution rather than
    /// failing the frame: the picture is what the user is looking at, and the
    /// only thing at stake is how many pixels it takes.
    #[test]
    fn a_nonsensical_scale_falls_back_to_full() {
        for scale in [0.0, -1.0, f32::NAN, f32::INFINITY, 4.0] {
            assert_eq!(frame(640, 480, scale).target_size(), (640, 480));
        }
    }

    /// The field is defaulted, so a frame from a caller that predates it — the
    /// self-check builds descriptors by hand — still deserializes.
    #[test]
    fn render_scale_defaults_to_full() {
        let json = r#"{
            "width": 100,
            "height": 50,
            "clear": { "color": [0.0, 0.0, 0.0, 1.0] },
            "items": []
        }"#;
        let frame: FrameDescriptor = serde_json::from_str(json).expect("frame");
        assert_eq!(frame.render_scale, 1.0);
        assert_eq!(frame.target_size(), (100, 50));
    }

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
