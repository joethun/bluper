use bytemuck::{Pod, Zeroable};
use gpu::{GpuContext, TexturePool};

use crate::sdf::SdfPipeline;

const JFA_DISTANCE_SHADER_SOURCE: &str = include_str!("shaders/jfa_distance.wgsl");

pub struct ApplyMaskFeatherOptions<'a> {
    pub mask: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub feather: f32,
}

pub struct MaskFeatherPipeline {
    sdf_pipeline: SdfPipeline,
    distance_pipeline: wgpu::RenderPipeline,
    /// The jump-flooding scratch buffers. Feathering one mask runs ~2·log2(size)
    /// passes over four full-size targets, so allocating them per call is the
    /// most texture churn anything in the renderer produces.
    pool: TexturePool,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DistanceUniformBuffer {
    resolution: [f32; 2],
    feather_half: f32,
    _padding: f32,
}

impl MaskFeatherPipeline {
    pub fn new(context: &GpuContext) -> Self {
        // The inside and outside distance fields bind at groups 0 and 1, both
        // with the shared texture + sampler shape.
        let pipeline_layout = context.create_pipeline_layout(
            "gpu-mask-distance-pipeline-layout",
            &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.uniform_bind_group_layout()),
            ],
        );
        let fragment_module = context
            .device()
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("gpu-mask-distance-fragment-shader"),
                source: wgpu::ShaderSource::Wgsl(JFA_DISTANCE_SHADER_SOURCE.into()),
            });

        Self {
            pool: TexturePool::default(),
            sdf_pipeline: SdfPipeline::new(context),
            distance_pipeline: context.create_fullscreen_pipeline(
                "gpu-mask-distance-pipeline",
                &pipeline_layout,
                &fragment_module,
                "fragment_main",
            ),
        }
    }

    /// Returns the scratch buffers of the frame that has been submitted. The
    /// feathered output is *not* pooled — callers cache it across frames — so
    /// only the jump-flooding intermediates come back here.
    pub fn recycle_frame(&mut self) {
        self.pool.recycle_frame();
    }

    pub fn apply_mask_feather(
        &mut self,
        context: &GpuContext,
        options: ApplyMaskFeatherOptions<'_>,
    ) -> wgpu::Texture {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("gpu-mask-distance-command-encoder"),
                });
        let output = self.apply_mask_feather_with_encoder(context, &mut encoder, options);
        context.queue().submit([encoder.finish()]);
        output
    }

    pub fn apply_mask_feather_with_encoder(
        &mut self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyMaskFeatherOptions {
            mask,
            width,
            height,
            feather,
        }: ApplyMaskFeatherOptions<'_>,
    ) -> wgpu::Texture {
        let sdf = self.sdf_pipeline.compute_signed_distance_field_with_encoder(
            context,
            encoder,
            &mut self.pool,
            mask,
            width,
            height,
        );
        let output_texture = context.create_render_texture(width, height, "masks-feather-output");
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let inside_bind_group = context.create_texture_sampler_bind_group(
            "gpu-mask-distance-inside-bind-group",
            &sdf.inside_texture,
            context.nearest_sampler(),
        );
        let outside_bind_group = context.create_texture_sampler_bind_group(
            "gpu-mask-distance-outside-bind-group",
            &sdf.outside_texture,
            context.nearest_sampler(),
        );
        let uniform_bind_group = context.create_uniform_bind_group(
            "gpu-mask-distance-uniform-buffer",
            bytemuck::bytes_of(&DistanceUniformBuffer {
                resolution: [width as f32, height as f32],
                feather_half: feather / 2.0,
                _padding: 0.0,
            }),
        );

        context.draw_fullscreen_pass(
            encoder,
            "gpu-mask-distance-render-pass",
            &output_view,
            wgpu::Color::TRANSPARENT,
            &self.distance_pipeline,
            &[&inside_bind_group, &outside_bind_group, &uniform_bind_group],
        );
        output_texture
    }
}
