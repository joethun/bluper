use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::GpuContext;
use thiserror::Error;

use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const COLOR_ADJUST_SHADER_SOURCE: &str = include_str!("shaders/color_adjust.wgsl");
const CHROMA_KEY_SHADER_ID: &str = "chroma-key";
const CHROMA_KEY_SHADER_SOURCE: &str = include_str!("shaders/chroma_key.wgsl");

/// The colour functions of the CSS filter shorthand, each a pass of its own so
/// a chain applies in the order it was written. `brightness(2) contrast(0.5)`
/// and `contrast(0.5) brightness(2)` are different pictures, so collapsing the
/// chain into one pass would quietly change what the sliders do.
const COLOR_ADJUST_SHADERS: [(&str, &str); 5] = [
    ("brightness", "brightness_main"),
    ("contrast", "contrast_main"),
    ("saturate", "saturate_main"),
    ("hue-rotate", "hue_rotate_main"),
    ("invert", "invert_main"),
];

/// The chroma key's band, as the caller supplies it: where in the UV plane the
/// key colour sits, and the two distances the softness ramps between. All four
/// are 0..1, matching the shader's working space rather than the canvas path's
/// bytes.
const CHROMA_KEY_UNIFORMS: [&str; 3] = ["u_key_chroma", "u_near", "u_far"];

/// The single scalar every colour pass takes, in the units CSS uses: a
/// multiplier for everything except `hue-rotate`, which takes degrees.
const AMOUNT_UNIFORM: &str = "u_amount";

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    pipelines: HashMap<String, wgpu::RenderPipeline>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let pipeline_layout = context.create_pipeline_layout(
            "effects-pipeline-layout",
            &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.uniform_bind_group_layout()),
            ],
        );
        let shader = |label, source: &str| {
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(label),
                    source: wgpu::ShaderSource::Wgsl(source.into()),
                })
        };
        let gaussian_blur_module =
            shader("effects-gaussian-blur-shader", GAUSSIAN_BLUR_SHADER_SOURCE);
        let color_adjust_module = shader("effects-color-adjust-shader", COLOR_ADJUST_SHADER_SOURCE);
        let chroma_key_module = shader("effects-chroma-key-shader", CHROMA_KEY_SHADER_SOURCE);

        let mut pipelines = HashMap::from([(
            GAUSSIAN_BLUR_SHADER_ID.to_string(),
            context.create_fullscreen_pipeline(
                "effects-gaussian-blur-pipeline",
                &pipeline_layout,
                &gaussian_blur_module,
                "fragment_main",
            ),
        )]);
        pipelines.insert(
            CHROMA_KEY_SHADER_ID.to_string(),
            context.create_fullscreen_pipeline(
                "effects-chroma-key-pipeline",
                &pipeline_layout,
                &chroma_key_module,
                "chroma_key_main",
            ),
        );
        for (shader_id, entry_point) in COLOR_ADJUST_SHADERS {
            pipelines.insert(
                shader_id.to_string(),
                context.create_fullscreen_pipeline(
                    "effects-color-adjust-pipeline",
                    &pipeline_layout,
                    &color_adjust_module,
                    entry_point,
                ),
            );
        }

        Self { pipelines }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        options: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(context, &mut encoder, options)?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let texture_bind_group = context.create_texture_sampler_bind_group(
                "effects-texture-bind-group",
                input_texture,
                context.linear_sampler(),
            );
            let uniform_bind_group = context.create_uniform_bind_group(
                "effects-uniform-buffer",
                bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
            );

            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            context.draw_fullscreen_pass(
                encoder,
                "effects-render-pass",
                &output_view,
                wgpu::Color::TRANSPARENT,
                pipeline,
                &[&texture_bind_group, &uniform_bind_group],
            );

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }
}

const BLUR_UNIFORMS: [&str; 3] = ["u_sigma", "u_step", "u_direction"];

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let resolution = [width as f32, height as f32];

    if COLOR_ADJUST_SHADERS
        .iter()
        .any(|(shader_id, _)| *shader_id == pass.shader)
    {
        let amount = read_number_uniform(pass, AMOUNT_UNIFORM)?;
        reject_unknown_uniforms(pass, &[AMOUNT_UNIFORM])?;
        return Ok(EffectUniformBuffer {
            resolution,
            direction: [0.0, 0.0],
            scalars: [amount, 0.0, 0.0, 0.0],
        });
    }

    if pass.shader == CHROMA_KEY_SHADER_ID {
        let key_chroma = read_vec2_uniform(pass, "u_key_chroma")?;
        let near = read_number_uniform(pass, "u_near")?;
        let far = read_number_uniform(pass, "u_far")?;
        reject_unknown_uniforms(pass, &CHROMA_KEY_UNIFORMS)?;
        return Ok(EffectUniformBuffer {
            resolution,
            direction: [0.0, 0.0],
            scalars: [key_chroma[0], key_chroma[1], near, far],
        });
    }

    let sigma = read_number_uniform(pass, "u_sigma")?;
    let step = read_number_uniform(pass, "u_step")?;
    let direction = read_vec2_uniform(pass, "u_direction")?;
    reject_unknown_uniforms(pass, &BLUR_UNIFORMS)?;

    Ok(EffectUniformBuffer {
        resolution,
        direction,
        scalars: [sigma, step, 0.0, 0.0],
    })
}

/// A uniform the shader doesn't read is a caller bug — a renamed slider, or a
/// pass built for a different shader — so it's rejected rather than ignored,
/// which would silently drop the adjustment instead of reporting it.
fn reject_unknown_uniforms(pass: &EffectPass, supported: &[&str]) -> Result<(), EffectsError> {
    match pass
        .uniforms
        .keys()
        .find(|name| !supported.contains(&name.as_str()))
    {
        Some(uniform) => Err(EffectsError::UnsupportedUniform {
            shader: pass.shader.clone(),
            uniform: uniform.clone(),
        }),
        None => Ok(()),
    }
}

fn read_uniform<'a>(
    pass: &'a EffectPass,
    uniform: &str,
) -> Result<&'a UniformValue, EffectsError> {
    pass.uniforms
        .get(uniform)
        .ok_or_else(|| EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        })
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    match read_uniform(pass, uniform)? {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    match read_uniform(pass, uniform)? {
        UniformValue::Vector(values) if values.len() == 2 => Ok([values[0], values[1]]),
        _ => Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(source: &str) -> naga::valid::ModuleInfo {
        let module = naga::front::wgsl::parse_str(source).expect("shader parses");
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::default(),
        )
        .validate(&module)
        .expect("shader validates")
    }

    /// A bad shader only surfaces when the pipeline is built, which on the
    /// desktop shell reads as "the adjustment did nothing" rather than an error.
    #[test]
    fn shaders_compile() {
        validate(GAUSSIAN_BLUR_SHADER_SOURCE);
        validate(COLOR_ADJUST_SHADER_SOURCE);
        validate(CHROMA_KEY_SHADER_SOURCE);
    }

    /// Every registered colour shader needs a matching entry point, or the
    /// pipeline build panics the first time that slider is touched.
    #[test]
    fn color_adjust_entry_points_exist() {
        let module =
            naga::front::wgsl::parse_str(COLOR_ADJUST_SHADER_SOURCE).expect("shader parses");
        for (shader_id, entry_point) in COLOR_ADJUST_SHADERS {
            assert!(
                module
                    .entry_points
                    .iter()
                    .any(|entry| entry.name == entry_point),
                "shader '{shader_id}' declares entry point '{entry_point}', which the module does not define",
            );
        }
    }

    #[test]
    fn color_pass_uniforms_pack_the_amount() {
        let pass = EffectPass {
            shader: "saturate".to_string(),
            uniforms: HashMap::from([(AMOUNT_UNIFORM.to_string(), UniformValue::Number(1.5))]),
        };
        let packed = pack_effect_uniforms(&pass, 320, 240).expect("packs");
        assert_eq!(packed.scalars[0], 1.5);
        assert_eq!(packed.resolution, [320.0, 240.0]);
    }

    #[test]
    fn color_pass_rejects_a_stray_uniform() {
        let pass = EffectPass {
            shader: "brightness".to_string(),
            uniforms: HashMap::from([
                (AMOUNT_UNIFORM.to_string(), UniformValue::Number(1.0)),
                ("u_sigma".to_string(), UniformValue::Number(2.0)),
            ]),
        };
        assert!(matches!(
            pack_effect_uniforms(&pass, 8, 8),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }
}
