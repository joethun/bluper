use bytemuck::{Pod, Zeroable};
use effects::{ApplyEffectsOptions, EffectPass, EffectPipeline, UniformValue};
use gpu::{GpuContext, wgpu};
use masks::{ApplyMaskFeatherOptions, MaskFeatherPipeline};
use thiserror::Error;

use crate::{
    BlendMode,
    frame::{
        EffectPassDescriptor, EffectUniformValueDescriptor, FrameDescriptor, FrameItemDescriptor,
        LayerDescriptor,
    },
    texture_pool::TexturePool,
    texture_store::TextureStore,
    uniform_ring::UniformRing,
};

/// Slots in each uniform ring. Sized to clear the GPU's per-frame in-flight
/// budget on the backends that take 1–2 frames of latency — actual usage per
/// frame stays well below this (one slot per layer / blend / mask pass).
const UNIFORM_RING_SLOTS: usize = 16;

const LAYER_SHADER_SOURCE: &str = include_str!("shaders/layer.wgsl");
const BLEND_SHADER_SOURCE: &str = include_str!("shaders/blend.wgsl");
const MASK_SHADER_SOURCE: &str = include_str!("shaders/mask.wgsl");

pub struct RenderFrameOptions<'a, 'surface> {
    pub frame: &'a FrameDescriptor,
    pub surface: &'a wgpu::Surface<'surface>,
}

/// The GPU handles and target size every pass in one frame shares. Threaded
/// through the pass helpers so each one takes only what makes it different.
struct Pass<'a> {
    context: &'a GpuContext,
    encoder: &'a mut wgpu::CommandEncoder,
    width: u32,
    height: u32,
}

pub struct Compositor {
    textures: TextureStore,
    texture_pool: TexturePool,
    effects: EffectPipeline,
    masks: MaskFeatherPipeline,
    layer_pipeline: wgpu::RenderPipeline,
    layer_uniform_ring: UniformRing<LayerUniformBuffer>,
    blend_pipeline: wgpu::RenderPipeline,
    blend_uniform_ring: UniformRing<BlendUniformBuffer>,
    mask_pipeline: wgpu::RenderPipeline,
    mask_uniform_ring: UniformRing<MaskUniformBuffer>,
}

#[derive(Debug, Error)]
pub enum CompositorError {
    #[error("Texture '{texture_id}' is not available")]
    MissingTexture { texture_id: String },
    #[error("Failed to apply effects: {0}")]
    Effects(#[from] effects::EffectsError),
    #[error("Failed to present frame: {0}")]
    Gpu(#[from] gpu::GpuError),
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct LayerUniformBuffer {
    resolution: [f32; 2],
    center: [f32; 2],
    size: [f32; 2],
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    _padding: [f32; 2], // WebGL requires uniform buffer sizes to be multiples of 16 bytes (40 → 48)
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct BlendUniformBuffer {
    blend_mode: u32,
    _padding: [u32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct MaskUniformBuffer {
    inverted: f32,
    _padding: [f32; 3],
}

impl Compositor {
    pub fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let shader = |label, source: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            })
        };
        let layer_shader = shader("compositor-layer-shader", LAYER_SHADER_SOURCE);
        let blend_shader = shader("compositor-blend-shader", BLEND_SHADER_SOURCE);
        let mask_shader = shader("compositor-mask-shader", MASK_SHADER_SOURCE);

        // The layer pass samples one texture; blend and mask sample two. All
        // three take their parameters through the shared uniform layout.
        let layer_pipeline_layout = context.create_pipeline_layout(
            "compositor-layer-pipeline-layout",
            &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.uniform_bind_group_layout()),
            ],
        );
        let two_texture_layout = |label| {
            context.create_pipeline_layout(
                label,
                &[
                    Some(context.texture_sampler_bind_group_layout()),
                    Some(context.texture_sampler_bind_group_layout()),
                    Some(context.uniform_bind_group_layout()),
                ],
            )
        };
        let blend_pipeline_layout = two_texture_layout("compositor-blend-pipeline-layout");
        let mask_pipeline_layout = two_texture_layout("compositor-mask-pipeline-layout");

        Self {
            textures: TextureStore::default(),
            texture_pool: TexturePool::default(),
            effects: EffectPipeline::new(context),
            masks: MaskFeatherPipeline::new(context),
            layer_pipeline: context.create_fullscreen_pipeline(
                "compositor-layer-pipeline",
                &layer_pipeline_layout,
                &layer_shader,
                "fragment_main",
            ),
            layer_uniform_ring: UniformRing::new(
                context,
                "compositor-layer-uniform-ring",
                UNIFORM_RING_SLOTS,
            ),
            blend_pipeline: context.create_fullscreen_pipeline(
                "compositor-blend-pipeline",
                &blend_pipeline_layout,
                &blend_shader,
                "fragment_main",
            ),
            blend_uniform_ring: UniformRing::new(
                context,
                "compositor-blend-uniform-ring",
                UNIFORM_RING_SLOTS,
            ),
            mask_pipeline: context.create_fullscreen_pipeline(
                "compositor-mask-pipeline",
                &mask_pipeline_layout,
                &mask_shader,
                "fragment_main",
            ),
            mask_uniform_ring: UniformRing::new(
                context,
                "compositor-mask-uniform-ring",
                UNIFORM_RING_SLOTS,
            ),
        }
    }

    pub fn upsert_texture(&mut self, id: String, texture: wgpu::Texture) {
        self.textures.upsert(id, texture);
    }

    pub fn release_texture(&mut self, id: &str) {
        self.textures.remove(id);
    }

    /// Composites all frame items into a texture and returns it.
    /// Used on backends that cannot surface-render to an arbitrary canvas (e.g. WebGL).
    pub fn render_frame_to_texture(
        &mut self,
        context: &GpuContext,
        frame: &FrameDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        let mut encoder = self.begin_frame(context);
        let scene = self.composite_scene(context, &mut encoder, frame)?;
        context.queue().submit([encoder.finish()]);
        Ok(scene)
    }

    pub fn render_frame(
        &mut self,
        context: &GpuContext,
        options: RenderFrameOptions<'_, '_>,
    ) -> Result<(), CompositorError> {
        let surface_texture = context.acquire_surface_texture(options.surface)?;
        let surface_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.begin_frame(context);
        let scene = self.composite_scene(context, &mut encoder, options.frame)?;

        context.encode_texture_blit_to_view(
            &mut encoder,
            &scene,
            &surface_view,
            "compositor-present-pass",
        );
        context.queue().submit([encoder.finish()]);
        surface_texture.present();
        Ok(())
    }

    /// Returns every texture the last frame borrowed to the pool and opens the
    /// encoder the next one records into.
    fn begin_frame(&mut self, context: &GpuContext) -> wgpu::CommandEncoder {
        self.texture_pool.recycle_frame();
        context
            .device()
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("compositor-frame-encoder"),
            })
    }

    /// Draws the frame's items bottom-up into a single texture: each layer is
    /// rendered on its own and blended onto the scene so far, and a scene effect
    /// applies to everything beneath it.
    fn composite_scene(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        frame: &FrameDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        let mut pass = Pass {
            context,
            encoder,
            width: frame.width,
            height: frame.height,
        };
        let mut scene = self.create_cleared_texture(&mut pass, frame.clear.color);

        for item in &frame.items {
            scene = match item {
                FrameItemDescriptor::Layer(layer) => {
                    let layer_texture = self.render_layer(&mut pass, layer)?;
                    self.blend_texture(&mut pass, &scene, &layer_texture, layer.blend_mode)
                }
                FrameItemDescriptor::SceneEffect { effect_pass_groups } => {
                    self.apply_effect_groups(&mut pass, &scene, effect_pass_groups)?
                }
            };
        }

        Ok(scene)
    }

    fn render_layer(
        &mut self,
        pass: &mut Pass<'_>,
        layer: &LayerDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        // Clone the texture out of the store so the call into
        // `render_source_to_texture` (which needs `&mut self` to cycle the
        // uniform ring) doesn't have to hold an immutable borrow alive.
        let source = self.texture(&layer.texture_id)?;
        let mut current = self.acquire(pass, "compositor-layer");
        self.render_source_to_texture(pass, &source, &current, layer);

        if !layer.effect_pass_groups.is_empty() {
            current = self.apply_effect_groups(pass, &current, &layer.effect_pass_groups)?;
        }

        if let Some(mask) = &layer.mask {
            let mask_source = self.texture(&mask.texture_id)?;
            let mask_texture = if mask.feather > 0.0 {
                self.masks.apply_mask_feather_with_encoder(
                    pass.context,
                    pass.encoder,
                    ApplyMaskFeatherOptions {
                        mask: &mask_source,
                        width: pass.width,
                        height: pass.height,
                        feather: mask.feather,
                    },
                )
            } else {
                self.copy_texture(pass, &mask_source)
            };
            current = self.apply_mask(pass, &current, &mask_texture, mask.inverted);
        }

        Ok(current)
    }

    fn texture(&self, texture_id: &str) -> Result<wgpu::Texture, CompositorError> {
        self.textures
            .get(texture_id)
            .cloned()
            .ok_or_else(|| CompositorError::MissingTexture {
                texture_id: texture_id.to_string(),
            })
    }

    fn acquire(&mut self, pass: &Pass<'_>, label: &'static str) -> wgpu::Texture {
        self.texture_pool
            .acquire(pass.context, pass.width, pass.height, label)
    }

    fn apply_effect_groups(
        &mut self,
        pass: &mut Pass<'_>,
        source: &wgpu::Texture,
        effect_pass_groups: &[Vec<EffectPassDescriptor>],
    ) -> Result<wgpu::Texture, CompositorError> {
        let mut current = self.copy_texture(pass, source);
        for group in effect_pass_groups {
            let passes = map_effect_passes(group);
            current = self.effects.apply_with_encoder(
                pass.context,
                pass.encoder,
                ApplyEffectsOptions {
                    source: &current,
                    width: pass.width,
                    height: pass.height,
                    passes: &passes,
                },
            )?;
        }
        Ok(current)
    }

    fn create_cleared_texture(
        &mut self,
        pass: &mut Pass<'_>,
        clear_color: [f32; 4],
    ) -> wgpu::Texture {
        let texture = self.acquire(pass, "compositor-cleared-texture");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        pass.context.clear_texture_view(
            pass.encoder,
            "compositor-clear-pass",
            &view,
            wgpu::Color {
                r: clear_color[0] as f64,
                g: clear_color[1] as f64,
                b: clear_color[2] as f64,
                a: clear_color[3] as f64,
            },
        );
        texture
    }

    fn copy_texture(&mut self, pass: &mut Pass<'_>, source: &wgpu::Texture) -> wgpu::Texture {
        let texture = self.acquire(pass, "compositor-copy-texture");
        let target_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        pass.context.encode_texture_blit_to_view(
            pass.encoder,
            source,
            &target_view,
            "compositor-blit-pass",
        );
        texture
    }

    fn render_source_to_texture(
        &mut self,
        pass: &mut Pass<'_>,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        layer: &LayerDescriptor,
    ) {
        let source_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-layer-source-bind-group",
            source,
            pass.context.linear_sampler(),
        );
        let uniform_bind_group = self.layer_uniform_ring.write(
            pass.context,
            &LayerUniformBuffer {
                resolution: [pass.width as f32, pass.height as f32],
                center: [layer.transform.center_x, layer.transform.center_y],
                size: [layer.transform.width, layer.transform.height],
                rotation_radians: layer.transform.rotation_degrees.to_radians(),
                opacity: layer.opacity,
                flip_x: if layer.transform.flip_x { 1.0 } else { 0.0 },
                flip_y: if layer.transform.flip_y { 1.0 } else { 0.0 },
                _padding: [0.0; 2],
            },
        );

        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        pass.context.draw_fullscreen_pass(
            pass.encoder,
            "compositor-layer-pass",
            &target_view,
            wgpu::Color::TRANSPARENT,
            &self.layer_pipeline,
            &[&source_bind_group, uniform_bind_group],
        );
    }

    fn apply_mask(
        &mut self,
        pass: &mut Pass<'_>,
        layer_texture: &wgpu::Texture,
        mask_texture: &wgpu::Texture,
        inverted: bool,
    ) -> wgpu::Texture {
        let layer_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-mask-layer-bind-group",
            layer_texture,
            pass.context.linear_sampler(),
        );
        let mask_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-mask-mask-bind-group",
            mask_texture,
            pass.context.linear_sampler(),
        );
        let target = self.acquire(pass, "compositor-masked-texture");
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        let uniform_bind_group = self.mask_uniform_ring.write(
            pass.context,
            &MaskUniformBuffer {
                inverted: if inverted { 1.0 } else { 0.0 },
                _padding: [0.0; 3],
            },
        );
        pass.context.draw_fullscreen_pass(
            pass.encoder,
            "compositor-mask-pass",
            &target_view,
            wgpu::Color::TRANSPARENT,
            &self.mask_pipeline,
            &[&layer_bind_group, &mask_bind_group, uniform_bind_group],
        );
        target
    }

    fn blend_texture(
        &mut self,
        pass: &mut Pass<'_>,
        base: &wgpu::Texture,
        layer: &wgpu::Texture,
        blend_mode: BlendMode,
    ) -> wgpu::Texture {
        let base_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-base-bind-group",
            base,
            pass.context.linear_sampler(),
        );
        let layer_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-layer-bind-group",
            layer,
            pass.context.linear_sampler(),
        );
        let target = self.acquire(pass, "compositor-blended-texture");
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

        let uniform_bind_group = self.blend_uniform_ring.write(
            pass.context,
            &BlendUniformBuffer {
                blend_mode: blend_mode.shader_code(),
                _padding: [0; 3],
            },
        );
        pass.context.draw_fullscreen_pass(
            pass.encoder,
            "compositor-blend-pass",
            &target_view,
            wgpu::Color::TRANSPARENT,
            &self.blend_pipeline,
            &[&base_bind_group, &layer_bind_group, uniform_bind_group],
        );
        target
    }
}

fn map_effect_passes(passes: &[EffectPassDescriptor]) -> Vec<EffectPass> {
    passes
        .iter()
        .map(|pass| EffectPass {
            shader: pass.shader.clone(),
            uniforms: pass
                .uniforms
                .iter()
                .map(|(name, value)| {
                    let uniform_value = match value {
                        EffectUniformValueDescriptor::Number(n) => UniformValue::Number(*n),
                        EffectUniformValueDescriptor::Vector(v) => UniformValue::Vector(v.clone()),
                    };
                    (name.clone(), uniform_value)
                })
                .collect(),
        })
        .collect()
}
