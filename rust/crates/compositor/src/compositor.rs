use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use effects::{ApplyEffectsOptions, EffectPass, EffectPipeline, UniformValue};
use gpu::{GpuContext, TexturePool, wgpu};
use masks::{ApplyMaskFeatherOptions, MaskFeatherPipeline};
use thiserror::Error;

use crate::{
    BlendMode,
    frame::{
        EffectPassDescriptor, EffectUniformValueDescriptor, FrameDescriptor, FrameItemDescriptor,
        LayerDescriptor, LayerMaskDescriptor,
    },
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
    /// Pixel size of every render target this frame allocates.
    width: u32,
    height: u32,
    /// The canvas space the frame's geometry is written in. Equal to
    /// `width`/`height` at full resolution and larger than them below it — a
    /// quad's centre and size, and a blur's sigma, are in these units, and the
    /// layer pass maps them onto whatever target it is handed.
    resolution: [f32; 2],
    /// `width / resolution.x`. Only the quantities that have to be re-expressed
    /// in target pixels — a mask feather, which is measured in texels of the
    /// texture it is applied to — need it.
    scale: f32,
}

/// What a cached feathered mask was derived from. Any difference means the
/// cached texture is stale and the jump-flooding has to run again.
#[derive(PartialEq, Eq)]
struct FeatherKey {
    /// Which upload of the mask texture this was feathered from.
    generation: u64,
    /// `f32` has no `Eq`, and the feather only has to compare *identical* to
    /// count as a hit, so the bit pattern is the honest key.
    feather_bits: u32,
    width: u32,
    height: u32,
}

pub struct Compositor {
    textures: TextureStore,
    texture_pool: TexturePool,
    /// Feathered masks, by the id of the mask texture they came from.
    ///
    /// Feathering is the most expensive thing a frame can do — two jump-flood
    /// runs, each ~log2(size) passes over a full-size target — and a mask is
    /// static for as long as nobody drags its handles, while the footage under
    /// it changes every frame. Keying on the upload generation means the work
    /// happens when the mask changes rather than when the picture does.
    feather_cache: HashMap<String, (FeatherKey, wgpu::Texture)>,
    effects: EffectPipeline,
    masks: MaskFeatherPipeline,
    layer_pipeline: wgpu::RenderPipeline,
    /// The layer pass with alpha blending, for drawing straight onto the scene.
    /// See `draw_layer`.
    layer_over_pipeline: wgpu::RenderPipeline,
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
            feather_cache: HashMap::new(),
            effects: EffectPipeline::new(context),
            masks: MaskFeatherPipeline::new(context),
            layer_pipeline: context.create_fullscreen_pipeline(
                "compositor-layer-pipeline",
                &layer_pipeline_layout,
                &layer_shader,
                "fragment_main",
            ),
            layer_over_pipeline: context.create_fullscreen_pipeline_blended(
                "compositor-layer-over-pipeline",
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

    /// Replaces the texture held for `id` with the one `import` produces, handing
    /// it whatever is stored there now so the upload can write into that
    /// allocation instead of building another.
    ///
    /// The lookup and the store are one call rather than two because they are
    /// only correct together, and only for the same id. An upload that forgot to
    /// pass the existing texture would quietly go back to allocating one per
    /// layer per frame — a couple of megabytes of driver-side work inside a
    /// frame, whose only symptom is a dropped one.
    ///
    /// `upsert` still bumps the id's generation, so anything caching work
    /// derived from a texture — the mask feather cache — sees the new contents
    /// rather than the recycled handle.
    pub fn upsert_texture_with(
        &mut self,
        id: String,
        import: impl FnOnce(Option<&wgpu::Texture>) -> wgpu::Texture,
    ) {
        let texture = import(self.textures.get(&id));
        self.textures.upsert(id, texture);
    }

    pub fn release_texture(&mut self, id: &str) {
        self.textures.remove(id);
        self.feather_cache.remove(id);
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

    /// Renders the frame and starts reading the result back as a row-major
    /// RGBA8 byte buffer. The export pipeline uses this — see
    /// `editor_core::export::Sink` for the encoder side that consumes it.
    /// Per-frame 8 MB at 1080p is the boundary cost AGENTS.md budgets for;
    /// the readback stays in the same Rust process as the renderer.
    ///
    /// The readback is handed back in flight rather than finished: on the
    /// webview's WebGL backend the copy only retires once the caller has
    /// returned to the JavaScript event loop, so the caller drives it with
    /// [`gpu::GpuContext::poll_texture_readback`]. See
    /// [`gpu::GpuContext::begin_texture_readback`] for why a blocking wait is
    /// not an option there.
    pub fn begin_frame_readback(
        &mut self,
        context: &GpuContext,
        frame: &FrameDescriptor,
    ) -> Result<gpu::TextureReadback, CompositorError> {
        let scene = self.render_frame_to_texture(context, frame)?;
        let (width, height) = frame.target_size();
        context
            .begin_texture_readback(&scene, width, height)
            .map_err(CompositorError::Gpu)
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

    /// Hands back everything the last frame borrowed — pooled render targets and
    /// uniform slots alike — and opens the encoder the next one records into.
    /// Safe here rather than at the end of a frame because the previous frame's
    /// commands have been submitted by the time another one starts.
    fn begin_frame(&mut self, context: &GpuContext) -> wgpu::CommandEncoder {
        self.texture_pool.recycle_frame();
        self.effects.recycle_frame();
        self.masks.recycle_frame();
        self.layer_uniform_ring.reset();
        self.blend_uniform_ring.reset();
        self.mask_uniform_ring.reset();
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
        let (width, height) = frame.target_size();
        let mut pass = Pass {
            context,
            encoder,
            width,
            height,
            resolution: [frame.width as f32, frame.height as f32],
            scale: frame.clamped_render_scale(),
        };
        let mut scene = self.create_cleared_texture(&mut pass, frame.clear.color);
        // The direct path's equivalence to the blend shader rests on the scene
        // being opaque, which the clear is what establishes.
        let scene_is_opaque = false; // TEMP

        for item in &frame.items {
            scene = match item {
                // A layer that contributes no pixels is skipped rather than
                // drawn: a transition side that has faded out still arrives as
                // an item, because the node carrying it also carries the wash
                // the transition paints over the cut, and `layer.a == 0` is a
                // no-op for every blend mode.
                FrameItemDescriptor::Layer(layer) if layer.opacity <= 0.0 => scene,
                // The common layer — stacked with `normal`, no effects, no mask
                // — is drawn straight onto the scene with alpha blending. The
                // general path below has to render it to a texture of its own
                // first so the blend shader can read it back, which is two
                // full-canvas passes and two pooled targets per layer instead of
                // one pass and none. The pictures are identical: the scene is
                // opaque (the clear sets alpha 1), and for an opaque backdrop
                // `normal` in the blend shader reduces to exactly the hardware's
                // `src.a·src + (1 - src.a)·dst`.
                FrameItemDescriptor::Layer(layer)
                    if scene_is_opaque && is_direct_composite(layer) =>
                {
                    let source = self.texture(&layer.texture_id)?;
                    self.draw_layer(&mut pass, &source, &scene, layer, DrawMode::Over);
                    scene
                }
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
        // Clone the texture out of the store so the call into `draw_layer`
        // (which needs `&mut self` to cycle the uniform ring) doesn't have to
        // hold an immutable borrow alive.
        let source = self.texture(&layer.texture_id)?;
        let mut current = self.acquire(pass, "compositor-layer");
        self.draw_layer(pass, &source, &current, layer, DrawMode::Replace);

        if !layer.effect_pass_groups.is_empty() {
            current = self.apply_effect_groups(pass, &current, &layer.effect_pass_groups)?;
        }

        if let Some(mask) = &layer.mask {
            let mask_texture = self.mask_texture(pass, mask)?;
            current = self.apply_mask(pass, &current, &mask_texture, mask.inverted);
        }

        Ok(current)
    }

    /// The alpha this layer's mask contributes, feathered if it asked to be.
    ///
    /// An unfeathered mask is used as uploaded — the mask pass samples it by
    /// normalised coordinate, so it needs no copy and no resize to line up with
    /// the target. A feathered one is derived work and is cached: see
    /// `feather_cache`.
    fn mask_texture(
        &mut self,
        pass: &mut Pass<'_>,
        mask: &LayerMaskDescriptor,
    ) -> Result<wgpu::Texture, CompositorError> {
        let source = self.texture(&mask.texture_id)?;
        if mask.feather <= 0.0 {
            return Ok(source);
        }

        // The feather arrives in canvas units and the jump flood measures
        // distance in texels of the target, so it has to come down with the
        // render scale or a reduced-resolution preview would soften the edge
        // several times as far as the full-resolution frame does.
        let feather = mask.feather * pass.scale;
        let key = FeatherKey {
            generation: self
                .textures
                .generation(&mask.texture_id)
                .ok_or_else(|| CompositorError::MissingTexture {
                    texture_id: mask.texture_id.clone(),
                })?,
            feather_bits: feather.to_bits(),
            width: pass.width,
            height: pass.height,
        };
        if let Some((cached_key, texture)) = self.feather_cache.get(&mask.texture_id) {
            if *cached_key == key {
                return Ok(texture.clone());
            }
        }

        let feathered = self.masks.apply_mask_feather_with_encoder(
            pass.context,
            pass.encoder,
            ApplyMaskFeatherOptions {
                mask: &source,
                width: pass.width,
                height: pass.height,
                feather,
            },
        );
        self.feather_cache
            .insert(mask.texture_id.clone(), (key, feathered.clone()));
        Ok(feathered)
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
        // The first group reads `source` directly. It used to read a copy of it,
        // which cost a full-canvas blit per effected layer and per scene effect
        // and was never observable — every group writes to a target of its own.
        let mut current: Option<wgpu::Texture> = None;
        for group in effect_pass_groups {
            let passes = map_effect_passes(group);
            current = Some(self.effects.apply_with_encoder(
                pass.context,
                pass.encoder,
                ApplyEffectsOptions {
                    source: current.as_ref().unwrap_or(source),
                    width: pass.width,
                    height: pass.height,
                    resolution: pass.resolution,
                    passes: &passes,
                },
            )?);
        }
        // Nothing to apply: the caller owns whatever it composites next, so it
        // gets a texture of its own rather than a borrow of the source.
        match current {
            Some(texture) => Ok(texture),
            None => Ok(self.copy_texture(pass, source)),
        }
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

    /// Places `source` on `target` as `layer`'s quad says to.
    ///
    /// `Replace` owns the target — it clears it first and writes the quad's
    /// alpha through, which is what the effect and mask passes downstream need
    /// to see. `Over` blends onto whatever the target already holds.
    fn draw_layer(
        &mut self,
        pass: &mut Pass<'_>,
        source: &wgpu::Texture,
        target: &wgpu::Texture,
        layer: &LayerDescriptor,
        mode: DrawMode,
    ) {
        let source_bind_group = pass.context.create_texture_sampler_bind_group(
            "compositor-layer-source-bind-group",
            source,
            pass.context.linear_sampler(),
        );
        let uniform_bind_group = self.layer_uniform_ring.write(
            pass.context,
            &LayerUniformBuffer {
                resolution: pass.resolution,
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
        match mode {
            DrawMode::Replace => pass.context.draw_fullscreen_pass(
                pass.encoder,
                "compositor-layer-pass",
                &target_view,
                wgpu::Color::TRANSPARENT,
                &self.layer_pipeline,
                &[&source_bind_group, uniform_bind_group],
            ),
            DrawMode::Over => pass.context.draw_fullscreen_pass_over(
                pass.encoder,
                "compositor-layer-over-pass",
                &target_view,
                &self.layer_over_pipeline,
                &[&source_bind_group, uniform_bind_group],
            ),
        }
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

/// How a layer pass treats what is already in its target.
#[derive(Clone, Copy)]
enum DrawMode {
    Replace,
    Over,
}

/// Whether this layer can be drawn straight onto the scene rather than
/// composited through the blend shader. Anything that has to read the layer
/// back — an effect stack, a mask, a blend mode that is not `normal` — needs a
/// texture of its own first.
fn is_direct_composite(layer: &LayerDescriptor) -> bool {
    layer.blend_mode == BlendMode::Normal
        && layer.effect_pass_groups.is_empty()
        && layer.mask.is_none()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::QuadTransformDescriptor;

    fn layer() -> LayerDescriptor {
        LayerDescriptor {
            texture_id: "t".to_string(),
            transform: QuadTransformDescriptor {
                center_x: 0.0,
                center_y: 0.0,
                width: 1.0,
                height: 1.0,
                rotation_degrees: 0.0,
                flip_x: false,
                flip_y: false,
            },
            opacity: 1.0,
            blend_mode: BlendMode::Normal,
            effect_pass_groups: Vec::new(),
            mask: None,
        }
    }

    #[test]
    fn a_plain_stacked_layer_goes_straight_onto_the_scene() {
        assert!(is_direct_composite(&layer()));
    }

    /// Each of these needs the layer readable as a texture of its own before it
    /// can be composited, so none of them may take the direct path.
    #[test]
    fn anything_that_reads_the_layer_back_takes_the_general_path() {
        let mut blended = layer();
        blended.blend_mode = BlendMode::Multiply;
        assert!(!is_direct_composite(&blended));

        let mut effected = layer();
        effected.effect_pass_groups = vec![vec![EffectPassDescriptor {
            shader: "gaussian-blur".to_string(),
            uniforms: HashMap::new(),
        }]];
        assert!(!is_direct_composite(&effected));

        let mut masked = layer();
        masked.mask = Some(LayerMaskDescriptor {
            texture_id: "m".to_string(),
            feather: 0.0,
            inverted: false,
        });
        assert!(!is_direct_composite(&masked));
    }
}
