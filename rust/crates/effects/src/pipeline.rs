use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{GpuContext, TexturePool};
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

/// The chroma key's input: the key colour (RGB plus its precomputed length),
/// the similarity floor below which a pixel cannot be the background, the
/// near/far band edges the softness ramps between, and how aggressively to
/// despill the surviving pixels. All are 0..1, matching the shader's
/// working space rather than the canvas path's bytes.
const CHROMA_KEY_UNIFORMS: [&str; 6] = [
    "u_key_color",
    "u_key_length",
    "u_min_similarity",
    "u_near",
    "u_far",
    "u_spill_reduction",
];

/// The single scalar every colour pass takes, in the units CSS uses: a
/// multiplier for everything except `hue-rotate`, which takes degrees.
const AMOUNT_UNIFORM: &str = "u_amount";

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    /// Size of the render target each pass draws into.
    pub width: u32,
    pub height: u32,
    /// The coordinate space the passes' pixel-valued uniforms are written in —
    /// a blur sigma is in these units, not in target pixels.
    ///
    /// Normally the same as `width`/`height`. They come apart when the preview
    /// renders below the project's resolution: the shader's sample offsets are
    /// `direction / resolution`, so keeping `resolution` at the project size
    /// makes a blur cover the same fraction of the picture whatever the target
    /// it lands on, which is what stops an effect changing strength when
    /// playback drops the preview scale.
    pub resolution: [f32; 2],
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    /// Pass outputs, recycled across frames. Every pass needs a target of its
    /// own and a stack can be a dozen deep, so allocating them per frame is a
    /// dozen texture creations per effected layer per frame.
    pool: TexturePool,
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

        Self {
            pipelines,
            pool: TexturePool::default(),
        }
    }

    /// Returns the previous frame's pass outputs to the pool. Call once the
    /// frame that borrowed them has been submitted.
    pub fn recycle_frame(&mut self) {
        self.pool.recycle_frame();
    }

    pub fn apply(
        &mut self,
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
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            resolution,
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
                bytemuck::bytes_of(&pack_effect_uniforms(pass, resolution)?),
            );

            let output_texture = self.pool.acquire(context, width, height, "effects-pass-output");
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
    resolution: [f32; 2],
) -> Result<EffectUniformBuffer, EffectsError> {
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
        let key_color = read_vec3_uniform(pass, "u_key_color")?;
        let key_length = read_number_uniform(pass, "u_key_length")?;
        let min_similarity = read_number_uniform(pass, "u_min_similarity")?;
        let near = read_number_uniform(pass, "u_near")?;
        let far = read_number_uniform(pass, "u_far")?;
        let spill_reduction = read_number_uniform(pass, "u_spill_reduction")?;
        reject_unknown_uniforms(pass, &CHROMA_KEY_UNIFORMS)?;
        // The other passes use `resolution` and `direction` for their own
        // values; the chroma key shader is the only consumer of every field
        // in the struct, so they are repurposed here as four more scalars.
        return Ok(EffectUniformBuffer {
            resolution: [key_color[0], key_color[1]],
            direction: [key_color[2], key_length],
            scalars: [min_similarity, near, far, spill_reduction],
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

fn read_vec3_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 3], EffectsError> {
    match read_uniform(pass, uniform)? {
        UniformValue::Vector(values) if values.len() == 3 => {
            Ok([values[0], values[1], values[2]])
        }
        _ => Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 3,
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
        let packed = pack_effect_uniforms(&pass, [320.0, 240.0]).expect("packs");
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
            pack_effect_uniforms(&pass, [8.0, 8.0]),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }

    /// The chroma key shader reads its uniforms from every field in the
    /// uniform buffer, including `resolution` and `direction`, which the
    /// other passes use for their own values. A shader that drifts out of
    /// sync with the packer would silently apply the wrong cut, so the
    /// pack is checked here.
    #[test]
    fn chroma_key_pass_uniforms_pack_the_shader_slots() {
        let pass = EffectPass {
            shader: CHROMA_KEY_SHADER_ID.to_string(),
            uniforms: HashMap::from([
                (
                    "u_key_color".to_string(),
                    UniformValue::Vector(vec![0.0, 0.824, 0.118]),
                ),
                ("u_key_length".to_string(), UniformValue::Number(0.832)),
                ("u_min_similarity".to_string(), UniformValue::Number(0.25)),
                ("u_near".to_string(), UniformValue::Number(0.256)),
                ("u_far".to_string(), UniformValue::Number(0.384)),
                (
                    "u_spill_reduction".to_string(),
                    UniformValue::Number(0.5),
                ),
            ]),
        };
        let packed = pack_effect_uniforms(&pass, [16.0, 16.0]).expect("packs");
        assert_eq!(packed.resolution, [0.0, 0.824]);
        assert_eq!(packed.direction, [0.118, 0.832]);
        assert_eq!(packed.scalars, [0.25, 0.256, 0.384, 0.5]);
    }

    /// A renamed or typo'd chroma-key uniform must surface as a hard error,
    /// not as a silent pass that produces a green-but-uncut picture.
    #[test]
    fn chroma_key_pass_rejects_a_stray_uniform() {
        let mut uniforms = HashMap::from([
            (
                "u_key_color".to_string(),
                UniformValue::Vector(vec![0.0, 0.5, 0.0]),
            ),
            ("u_key_length".to_string(), UniformValue::Number(0.5)),
            ("u_min_similarity".to_string(), UniformValue::Number(0.25)),
            ("u_near".to_string(), UniformValue::Number(0.1)),
            ("u_far".to_string(), UniformValue::Number(0.2)),
            ("u_spill_reduction".to_string(), UniformValue::Number(0.0)),
        ]);
        uniforms.insert("u_unknown".to_string(), UniformValue::Number(0.0));
        let pass = EffectPass {
            shader: CHROMA_KEY_SHADER_ID.to_string(),
            uniforms,
        };
        assert!(matches!(
            pack_effect_uniforms(&pass, [8.0, 8.0]),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
    }
}
