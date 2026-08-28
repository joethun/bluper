use bytemuck::{Pod, Zeroable};
use gpu::{GpuContext, TexturePool};

const JFA_INIT_SHADER_SOURCE: &str = include_str!("shaders/jfa_init.wgsl");
const JFA_STEP_SHADER_SOURCE: &str = include_str!("shaders/jfa_step.wgsl");

pub(crate) struct SignedDistanceFieldTextures {
    pub(crate) inside_texture: wgpu::Texture,
    pub(crate) outside_texture: wgpu::Texture,
}

pub(crate) struct SdfPipeline {
    init_pipeline: wgpu::RenderPipeline,
    step_pipeline: wgpu::RenderPipeline,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct JfaInitUniformBuffer {
    resolution: [f32; 2],
    invert: f32,
    _padding: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct JfaStepUniformBuffer {
    resolution: [f32; 2],
    step_size: f32,
    _padding: f32,
}

impl SdfPipeline {
    pub(crate) fn new(context: &GpuContext) -> Self {
        let device = context.device();
        let pipeline_layout = context.create_pipeline_layout(
            "gpu-sdf-pipeline-layout",
            &[
                Some(context.texture_sampler_bind_group_layout()),
                Some(context.uniform_bind_group_layout()),
            ],
        );
        let shader = |label, source: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(source.into()),
            })
        };
        let init_module = shader("gpu-jfa-init-shader", JFA_INIT_SHADER_SOURCE);
        let step_module = shader("gpu-jfa-step-shader", JFA_STEP_SHADER_SOURCE);

        Self {
            init_pipeline: context.create_fullscreen_pipeline(
                "gpu-jfa-init-pipeline",
                &pipeline_layout,
                &init_module,
                "fragment_main",
            ),
            step_pipeline: context.create_fullscreen_pipeline(
                "gpu-jfa-step-pipeline",
                &pipeline_layout,
                &step_module,
                "fragment_main",
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn compute_signed_distance_field_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        pool: &mut TexturePool,
        source_texture: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> SignedDistanceFieldTextures {
        SignedDistanceFieldTextures {
            inside_texture: self.run_jfa(
                context,
                encoder,
                pool,
                source_texture,
                width,
                height,
                false,
            ),
            outside_texture: self.run_jfa(
                context,
                encoder,
                pool,
                source_texture,
                width,
                height,
                true,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run_jfa(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        pool: &mut TexturePool,
        source_texture: &wgpu::Texture,
        width: u32,
        height: u32,
        is_inverted: bool,
    ) -> wgpu::Texture {
        let ping_texture = pool.acquire(context, width, height, "gpu-jfa-ping-texture");
        let pong_texture = pool.acquire(context, width, height, "gpu-jfa-pong-texture");

        self.run_pass(
            context,
            encoder,
            source_texture,
            &ping_texture,
            &self.init_pipeline,
            bytemuck::bytes_of(&JfaInitUniformBuffer {
                resolution: [width as f32, height as f32],
                invert: if is_inverted { 1.0 } else { 0.0 },
                _padding: 0.0,
            }),
        );

        // Jump flooding halves the step each pass, so the seeds propagate the
        // full width of the texture in log2 passes, ping-ponging as it goes.
        let mut source_is_ping = true;
        let steps = (width.max(height) as f32).log2().ceil() as u32;
        for step_index in (0..steps).rev() {
            let (input_texture, output_texture) = if source_is_ping {
                (&ping_texture, &pong_texture)
            } else {
                (&pong_texture, &ping_texture)
            };
            self.run_pass(
                context,
                encoder,
                input_texture,
                output_texture,
                &self.step_pipeline,
                bytemuck::bytes_of(&JfaStepUniformBuffer {
                    resolution: [width as f32, height as f32],
                    step_size: 2u32.pow(step_index).max(1) as f32,
                    _padding: 0.0,
                }),
            );
            source_is_ping = !source_is_ping;
        }

        if source_is_ping {
            ping_texture
        } else {
            pong_texture
        }
    }

    fn run_pass(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        input_texture: &wgpu::Texture,
        output_texture: &wgpu::Texture,
        pipeline: &wgpu::RenderPipeline,
        uniform_buffer_bytes: &[u8],
    ) {
        let texture_bind_group = context.create_texture_sampler_bind_group(
            "gpu-sdf-texture-bind-group",
            input_texture,
            context.nearest_sampler(),
        );
        let uniform_bind_group =
            context.create_uniform_bind_group("gpu-sdf-uniform-buffer", uniform_buffer_bytes);
        let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());

        context.draw_fullscreen_pass(
            encoder,
            "gpu-sdf-render-pass",
            &output_view,
            wgpu::Color::WHITE,
            pipeline,
            &[&texture_bind_group, &uniform_bind_group],
        );
    }
}
