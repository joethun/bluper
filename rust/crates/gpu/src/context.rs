use wgpu::util::DeviceExt;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
use std::cell::{Cell, RefCell};

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
use wasm_bindgen::{JsCast, JsValue};

use crate::GpuError;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
#[derive(Debug)]
struct WebDisplay;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
impl wgpu::rwh::HasDisplayHandle for WebDisplay {
    fn display_handle(&self) -> Result<wgpu::rwh::DisplayHandle<'_>, wgpu::rwh::HandleError> {
        let raw = wgpu::rwh::WebDisplayHandle::new();
        Ok(unsafe { wgpu::rwh::DisplayHandle::borrow_raw(raw.into()) })
    }
}

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
struct CachedCanvasSurface {
    surface: wgpu::Surface<'static>,
    size: (u32, u32),
}

/// The vertex stage every pass in the renderer shares: it draws
/// [`FULLSCREEN_QUAD_POSITIONS`] and hands the fragment stage a `VertexOutput`.
const FULLSCREEN_SHADER_SOURCE: &str = include_str!("shaders/fullscreen.wgsl");
const BLIT_SHADER_SOURCE: &str = include_str!("shaders/blit.wgsl");

const FULLSCREEN_QUAD_POSITIONS: [[f32; 2]; 6] = [
    [-1.0, -1.0],
    [1.0, -1.0],
    [-1.0, 1.0],
    [-1.0, 1.0],
    [1.0, -1.0],
    [1.0, 1.0],
];

/// One vertex of [`FULLSCREEN_QUAD_POSITIONS`], as the vertex stage reads it.
const FULLSCREEN_QUAD_VERTEX_LAYOUT: wgpu::VertexBufferLayout<'static> = wgpu::VertexBufferLayout {
    array_stride: std::mem::size_of::<[f32; 2]>() as u64,
    step_mode: wgpu::VertexStepMode::Vertex,
    attributes: &[wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 0,
        shader_location: 0,
    }],
};

/// A texture at binding 0 and a filtering sampler at binding 1, both visible to
/// the fragment stage. Every pass that samples an input uses this shape.
const TEXTURE_SAMPLER_LAYOUT_ENTRIES: [wgpu::BindGroupLayoutEntry; 2] = [
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            multisampled: false,
            view_dimension: wgpu::TextureViewDimension::D2,
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
        },
        count: None,
    },
    wgpu::BindGroupLayoutEntry {
        binding: 1,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    },
];

/// A single uniform buffer at binding 0, visible to the fragment stage. Every
/// pass that takes parameters uses this shape.
const UNIFORM_LAYOUT_ENTRIES: [wgpu::BindGroupLayoutEntry; 1] = [wgpu::BindGroupLayoutEntry {
    binding: 0,
    visibility: wgpu::ShaderStages::FRAGMENT,
    ty: wgpu::BindingType::Buffer {
        ty: wgpu::BufferBindingType::Uniform,
        has_dynamic_offset: false,
        min_binding_size: None,
    },
    count: None,
}];

pub struct GpuContext {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    texture_format: wgpu::TextureFormat,
    fullscreen_quad: wgpu::Buffer,
    fullscreen_vertex_module: wgpu::ShaderModule,
    linear_sampler: wgpu::Sampler,
    nearest_sampler: wgpu::Sampler,
    texture_sampler_bind_group_layout: wgpu::BindGroupLayout,
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    blit_pipeline: wgpu::RenderPipeline,
    supports_external_texture_copies: bool,
    /// The HTML canvas that the WebGL context is bound to. Only populated on the WebGL
    /// fallback path. Used by render_texture_to_gl_canvas_surface to output frames on WebGL.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    gl_canvas: Option<web_sys::HtmlCanvasElement>,
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    gl_surface: RefCell<Option<CachedCanvasSurface>>,
    /// Scratch canvas that `VideoFrame`s are drawn into on their way to a
    /// texture. See [`StagingCanvas`].
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    video_staging: RefCell<Option<StagingCanvas>>,
    /// How many times the staging canvas has been built.
    ///
    /// Reported so a check can hold down the one thing [`StagingCanvas`] is for:
    /// that uploading at a new size grows the canvas once and every size seen
    /// before is free. The failure it guards has no other symptom — an allocation
    /// per cut, or per frame, is a dropped frame and nothing else.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    video_staging_allocations: Cell<u32>,
}

/// An `OffscreenCanvas` and its 2D context, kept between uploads.
///
/// `import_video_frame_texture` built both on every call — a canvas, a backing
/// store of `width * height * 4` bytes and a `getContext` — which is once per
/// video layer per frame, for objects that depend only on the target size.
///
/// ## Why it is never replaced by a smaller one
///
/// The target size is not a property of the preview. It is how many pixels the
/// layer covers, bucketed to 64 (see `fitUploadToQuad`), capped at the source's
/// own resolution — so it differs between two clips of different resolutions or
/// aspect ratios, and between two layers on screen together. Keyed by exact
/// size, one slot therefore threw its canvas away and built another:
///
/// - at every cut between clips whose upload sizes fall in different buckets,
///   which on a timeline mixing sources is some cuts and not others — a dropped
///   frame at those joins and a clean one at the rest;
/// - on *every frame* where two video layers of different sizes are composited
///   together, each upload replacing the other's canvas.
///
/// Only the top-left `width × height` of this canvas is ever cleared, drawn or
/// read back, so one that is larger than the request serves it exactly. Holding
/// the largest asked for costs one backing store at the project's biggest source
/// resolution — which an exact-size slot allocates too, the first time that clip
/// is drawn — and reallocation stops after the sizes on the timeline have been
/// seen once.
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
struct StagingCanvas {
    width: u32,
    height: u32,
    /// Held so the canvas outlives the context taken from it.
    #[allow(dead_code)]
    canvas: web_sys::OffscreenCanvas,
    context: web_sys::OffscreenCanvasRenderingContext2d,
}

impl GpuContext {
    pub async fn new() -> Result<Self, GpuError> {
        #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
        let (instance, adapter, device, queue, gl_canvas) = Self::acquire_device().await?;
        #[cfg(not(all(feature = "wasm", target_arch = "wasm32")))]
        let (instance, adapter, device, queue) = Self::acquire_device().await?;
        let texture_format = if adapter.get_info().backend == wgpu::Backend::Gl {
            wgpu::TextureFormat::Rgba8Unorm
        } else {
            wgpu::TextureFormat::Bgra8Unorm
        };
        let fullscreen_quad = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("gpu-fullscreen-quad-buffer"),
            contents: bytemuck::cast_slice(&FULLSCREEN_QUAD_POSITIONS),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let sampler = |label, filter| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some(label),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: filter,
                min_filter: filter,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                ..Default::default()
            })
        };
        let linear_sampler = sampler("gpu-linear-sampler", wgpu::FilterMode::Linear);
        let nearest_sampler = sampler("gpu-nearest-sampler", wgpu::FilterMode::Nearest);
        let texture_sampler_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("gpu-texture-sampler-bind-group-layout"),
                entries: &TEXTURE_SAMPLER_LAYOUT_ENTRIES,
            });
        let uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("gpu-uniform-bind-group-layout"),
                entries: &UNIFORM_LAYOUT_ENTRIES,
            });
        let fullscreen_vertex_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gpu-fullscreen-shader"),
            source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
        });
        let blit_shader_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gpu-blit-shader"),
            source: wgpu::ShaderSource::Wgsl(BLIT_SHADER_SOURCE.into()),
        });

        let supports_external_texture_copies = adapter
            .get_downlevel_capabilities()
            .flags
            .contains(wgpu::DownlevelFlags::UNRESTRICTED_EXTERNAL_TEXTURE_COPIES);

        // `blit_pipeline` is the one pipeline built before `Self` exists, so it
        // spells out what `create_fullscreen_pipeline` does for every other pass.
        let blit_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gpu-blit-pipeline-layout"),
            bind_group_layouts: &[Some(&texture_sampler_bind_group_layout)],
            immediate_size: 0,
        });
        let blit_pipeline = create_fullscreen_pipeline(
            &device,
            "gpu-blit-pipeline",
            &blit_pipeline_layout,
            &fullscreen_vertex_module,
            &blit_shader_module,
            "fragment_main",
            texture_format,
            None,
        );

        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            texture_format,
            fullscreen_quad,
            fullscreen_vertex_module,
            linear_sampler,
            nearest_sampler,
            texture_sampler_bind_group_layout,
            uniform_bind_group_layout,
            blit_pipeline,
            supports_external_texture_copies,
            #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
            gl_canvas,
            #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
            gl_surface: RefCell::new(None),
            #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
            video_staging: RefCell::new(None),
            #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
            video_staging_allocations: Cell::new(0),
        })
    }

    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    async fn acquire_device() -> Result<
        (
            wgpu::Instance,
            wgpu::Adapter,
            wgpu::Device,
            wgpu::Queue,
            Option<web_sys::HtmlCanvasElement>,
        ),
        GpuError,
    > {
        let instance = wgpu::util::new_instance_with_webgpu_detection(
            wgpu::InstanceDescriptor::new_without_display_handle(),
        )
        .await;

        if let Ok((adapter, device, queue)) = Self::try_request_device(&instance, None).await {
            return Ok((instance, adapter, device, queue, None));
        }
        let (gl_instance, adapter, device, queue, canvas) = Self::try_gl_fallback().await?;
        Ok((gl_instance, adapter, device, queue, Some(canvas)))
    }

    #[cfg(not(all(feature = "wasm", target_arch = "wasm32")))]
    async fn acquire_device()
    -> Result<(wgpu::Instance, wgpu::Adapter, wgpu::Device, wgpu::Queue), GpuError> {
        let instance = wgpu::util::new_instance_with_webgpu_detection(
            wgpu::InstanceDescriptor::new_without_display_handle(),
        )
        .await;

        if let Ok((adapter, device, queue)) = Self::try_request_device(&instance, None).await {
            return Ok((instance, adapter, device, queue));
        }

        Self::try_gl_fallback().await
    }

    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    async fn try_gl_fallback() -> Result<
        (
            wgpu::Instance,
            wgpu::Adapter,
            wgpu::Device,
            wgpu::Queue,
            web_sys::HtmlCanvasElement,
        ),
        GpuError,
    > {
        let mut gl_desc = wgpu::InstanceDescriptor::new_without_display_handle();
        gl_desc.backends = wgpu::Backends::GL;
        gl_desc.display = Some(Box::new(WebDisplay));
        let gl_instance = wgpu::Instance::new(gl_desc);

        let document = web_sys::window()
            .and_then(|w| w.document())
            .ok_or(GpuError::AdapterUnavailable)?;
        let canvas: web_sys::HtmlCanvasElement = document
            .create_element("canvas")
            .map_err(|_| GpuError::AdapterUnavailable)?
            .unchecked_into();
        canvas.set_width(1);
        canvas.set_height(1);
        let surface = gl_instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))?;

        let (adapter, device, queue) =
            Self::try_request_device(&gl_instance, Some(&surface)).await?;
        Ok((gl_instance, adapter, device, queue, canvas))
    }

    #[cfg(not(all(feature = "wasm", target_arch = "wasm32")))]
    async fn try_gl_fallback()
    -> Result<(wgpu::Instance, wgpu::Adapter, wgpu::Device, wgpu::Queue), GpuError> {
        Err(GpuError::AdapterUnavailable)
    }

    async fn try_request_device(
        instance: &wgpu::Instance,
        compatible_surface: Option<&wgpu::Surface<'_>>,
    ) -> Result<(wgpu::Adapter, wgpu::Device, wgpu::Queue), GpuError> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface,
                force_fallback_adapter: false,
            })
            .await
            .map_err(|_| GpuError::AdapterUnavailable)?;

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("gpu-device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                trace: wgpu::Trace::Off,
            })
            .await?;

        Ok((adapter, device, queue))
    }

    /// The texture an upload of this size should write into, reusing `existing`
    /// when it is already the right shape.
    ///
    /// An upload used to allocate every time, so a video layer freed and
    /// reallocated its whole texture on every rendered frame — a couple of
    /// megabytes of driver-side allocation per layer per frame for a surface
    /// whose size only changes when the layer is resized. A `wgpu::Texture` is a
    /// handle, so keeping one costs a refcount bump and the pixels are replaced
    /// by the write that follows either way.
    ///
    /// The store still bumps the id's generation on every upload, so anything
    /// caching work derived from a texture — the mask feather cache — sees the
    /// new contents rather than the recycled handle.
    pub fn render_texture_for(
        &self,
        existing: Option<&wgpu::Texture>,
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        if let Some(texture) = existing {
            if texture.width() == width
                && texture.height() == height
                && texture.format() == self.texture_format
            {
                return texture.clone();
            }
        }
        self.create_render_texture(width, height, label)
    }

    pub fn create_render_texture(
        &self,
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.texture_format,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
    }

    pub fn instance(&self) -> &wgpu::Instance {
        &self.instance
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    pub fn texture_format(&self) -> wgpu::TextureFormat {
        self.texture_format
    }

    pub fn linear_sampler(&self) -> &wgpu::Sampler {
        &self.linear_sampler
    }

    pub fn nearest_sampler(&self) -> &wgpu::Sampler {
        &self.nearest_sampler
    }

    pub fn texture_sampler_bind_group_layout(&self) -> &wgpu::BindGroupLayout {
        &self.texture_sampler_bind_group_layout
    }

    /// Layout for [`Self::create_uniform_bind_group`]: one fragment-visible
    /// uniform buffer at binding 0. Shared so every pass that takes parameters
    /// describes them the same way instead of declaring its own copy.
    pub fn uniform_bind_group_layout(&self) -> &wgpu::BindGroupLayout {
        &self.uniform_bind_group_layout
    }

    /// Whether the GPU backend can render to arbitrary canvas surfaces.
    /// True for WebGPU, false for WebGL which can only surface-render to
    /// the specific canvas its GL context was originally created on.
    pub fn supports_surface_rendering(&self) -> bool {
        self.supports_external_texture_copies
    }

    /// The HTML canvas that owns the backing WebGL context, if running on the
    /// WebGL fallback. Callers on that path can mount this canvas directly
    /// instead of copying pixels out of it every frame.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn gl_canvas(&self) -> Option<&web_sys::HtmlCanvasElement> {
        self.gl_canvas.as_ref()
    }

    pub fn create_pipeline_layout(
        &self,
        label: &str,
        bind_group_layouts: &[Option<&wgpu::BindGroupLayout>],
    ) -> wgpu::PipelineLayout {
        self.device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts,
                immediate_size: 0,
            })
    }

    /// A pipeline that runs `fragment_entry_point` over the fullscreen quad.
    /// Every pass in the renderer has that shape, so the vertex stage, primitive
    /// state, and colour target are fixed here rather than restated per pass.
    pub fn create_fullscreen_pipeline(
        &self,
        label: &str,
        layout: &wgpu::PipelineLayout,
        fragment_module: &wgpu::ShaderModule,
        fragment_entry_point: &str,
    ) -> wgpu::RenderPipeline {
        create_fullscreen_pipeline(
            &self.device,
            label,
            layout,
            &self.fullscreen_vertex_module,
            fragment_module,
            fragment_entry_point,
            self.texture_format,
            None,
        )
    }

    /// [`Self::create_fullscreen_pipeline`] with straight-alpha "over" blending
    /// against whatever is already in the target.
    ///
    /// The renderer's textures are all non-premultiplied, and the target this
    /// draws onto is always opaque, so `src.a * src + (1 - src.a) * dst` is
    /// exactly the composite the blend shader computes for `normal` — see
    /// `Compositor::draw_layer_onto_scene`. Pair it with
    /// [`Self::draw_fullscreen_pass_over`], which loads the target instead of
    /// clearing it.
    pub fn create_fullscreen_pipeline_blended(
        &self,
        label: &str,
        layout: &wgpu::PipelineLayout,
        fragment_module: &wgpu::ShaderModule,
        fragment_entry_point: &str,
    ) -> wgpu::RenderPipeline {
        create_fullscreen_pipeline(
            &self.device,
            label,
            layout,
            &self.fullscreen_vertex_module,
            fragment_module,
            fragment_entry_point,
            self.texture_format,
            Some(wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::SrcAlpha,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                    operation: wgpu::BlendOperation::Add,
                },
            }),
        )
    }

    /// Binds `texture` and `sampler` for [`Self::texture_sampler_bind_group_layout`].
    pub fn create_texture_sampler_bind_group(
        &self,
        label: &str,
        texture: &wgpu::Texture,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.texture_sampler_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    /// A uniform buffer holding `contents`, bound at binding 0 of
    /// [`Self::uniform_bind_group_layout`]. The bind group keeps the buffer
    /// alive, so callers that never write to it again can drop the handle.
    pub fn create_uniform_bind_group(&self, label: &str, contents: &[u8]) -> wgpu::BindGroup {
        let buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
        self.create_uniform_bind_group_for_buffer(label, &buffer)
    }

    /// [`Self::create_uniform_bind_group`] against a buffer the caller keeps and
    /// rewrites — a uniform ring, for instance, where the bind group has to
    /// outlive any one frame's contents.
    pub fn create_uniform_bind_group_for_buffer(
        &self,
        label: &str,
        buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &self.uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        })
    }

    /// Runs one fullscreen pass: clear `target` to `clear`, then draw the quad
    /// with `pipeline` and `bind_groups` bound in order from group 0.
    pub fn draw_fullscreen_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        target: &wgpu::TextureView,
        clear: wgpu::Color,
        pipeline: &wgpu::RenderPipeline,
        bind_groups: &[&wgpu::BindGroup],
    ) {
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(pipeline);
        render_pass.set_vertex_buffer(0, self.fullscreen_quad.slice(..));
        for (index, bind_group) in bind_groups.iter().enumerate() {
            render_pass.set_bind_group(index as u32, *bind_group, &[]);
        }
        render_pass.draw(0..6, 0..1);
    }

    /// [`Self::draw_fullscreen_pass`] without the clear: the target keeps what
    /// it already holds and the pass blends onto it. Only meaningful with a
    /// pipeline from [`Self::create_fullscreen_pipeline_blended`] — with an
    /// unblended one the draw simply overwrites every pixel it covers.
    pub fn draw_fullscreen_pass_over(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        target: &wgpu::TextureView,
        pipeline: &wgpu::RenderPipeline,
        bind_groups: &[&wgpu::BindGroup],
    ) {
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(pipeline);
        render_pass.set_vertex_buffer(0, self.fullscreen_quad.slice(..));
        for (index, bind_group) in bind_groups.iter().enumerate() {
            render_pass.set_bind_group(index as u32, *bind_group, &[]);
        }
        render_pass.draw(0..6, 0..1);
    }

    /// Clears `target` and draws it as a render pass with no attachments bound
    /// beyond the target itself. Used to blank a texture the caller then
    /// composites into.
    pub fn clear_texture_view(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        target: &wgpu::TextureView,
        clear: wgpu::Color,
    ) {
        encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: None,
            multiview_mask: None,
        });
    }

    pub fn render_texture_to_surface(
        &self,
        texture: &wgpu::Texture,
        surface: &wgpu::Surface<'_>,
        width: u32,
        height: u32,
    ) -> Result<(), GpuError> {
        self.configure_surface(surface, width, height)?;
        self.present_texture_to_surface(texture, surface)
    }

    pub fn present_texture_to_surface(
        &self,
        texture: &wgpu::Texture,
        surface: &wgpu::Surface<'_>,
    ) -> Result<(), GpuError> {
        let surface_texture = self.acquire_surface_texture(surface)?;
        let target_view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gpu-surface-blit-encoder"),
            });
        self.encode_texture_blit_to_view(&mut encoder, texture, &target_view, "gpu-surface-blit");
        self.queue.submit([encoder.finish()]);
        surface_texture.present();
        Ok(())
    }

    pub fn configure_surface(
        &self,
        surface: &wgpu::Surface<'_>,
        width: u32,
        height: u32,
    ) -> Result<(), GpuError> {
        let caps = surface.get_capabilities(&self.adapter);
        if !caps.formats.contains(&self.texture_format) {
            return Err(GpuError::UnsupportedSurfaceFormat);
        }

        surface.configure(
            &self.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: self.texture_format,
                width,
                height,
                present_mode: wgpu::PresentMode::Fifo,
                alpha_mode: caps
                    .alpha_modes
                    .first()
                    .copied()
                    .unwrap_or(wgpu::CompositeAlphaMode::Auto),
                view_formats: vec![],
                desired_maximum_frame_latency: 2,
            },
        );
        Ok(())
    }

    pub fn acquire_surface_texture(
        &self,
        surface: &wgpu::Surface<'_>,
    ) -> Result<wgpu::SurfaceTexture, GpuError> {
        match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(surface_texture)
            | wgpu::CurrentSurfaceTexture::Suboptimal(surface_texture) => Ok(surface_texture),
            wgpu::CurrentSurfaceTexture::Timeout
            | wgpu::CurrentSurfaceTexture::Occluded
            | wgpu::CurrentSurfaceTexture::Outdated
            | wgpu::CurrentSurfaceTexture::Lost
            | wgpu::CurrentSurfaceTexture::Validation => Err(GpuError::UnsupportedSurfaceFormat),
        }
    }

    pub fn encode_texture_blit_to_view(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture,
        target_view: &wgpu::TextureView,
        label: &str,
    ) {
        let bind_group =
            self.create_texture_sampler_bind_group("gpu-blit-bind-group", texture, &self.linear_sampler);
        self.draw_fullscreen_pass(
            encoder,
            label,
            target_view,
            wgpu::Color::TRANSPARENT,
            &self.blit_pipeline,
            &[&bind_group],
        );
    }

    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn import_offscreen_canvas_texture(
        &self,
        canvas: &wgpu::web_sys::OffscreenCanvas,
        existing: Option<&wgpu::Texture>,
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        let texture = self.render_texture_for(existing, width, height, label);

        if self.supports_external_texture_copies {
            self.queue.copy_external_image_to_texture(
                &wgpu::CopyExternalImageSourceInfo {
                    source: wgpu::ExternalImageSource::OffscreenCanvas(canvas.clone()),
                    origin: wgpu::Origin2d::ZERO,
                    flip_y: false,
                },
                wgpu::CopyExternalImageDestInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                    color_space: wgpu::PredefinedColorSpace::Srgb,
                    premultiplied_alpha: false,
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
        } else {
            let ctx = offscreen_2d_context(canvas, "texture import");
            self.upload_context_pixels(&texture, &ctx, width, height);
        }

        texture
    }

    /// The staging context for a `width` x `height` upload, grown to cover the
    /// largest one asked for so far.
    ///
    /// The context is handed back by clone, which for a `web_sys` handle is a
    /// reference bump rather than a copy of the canvas.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    fn video_staging_context(
        &self,
        width: u32,
        height: u32,
    ) -> web_sys::OffscreenCanvasRenderingContext2d {
        let mut slot = self.video_staging.borrow_mut();
        if let Some(staging) = slot
            .as_ref()
            .filter(|staging| staging.width >= width && staging.height >= height)
        {
            return staging.context.clone();
        }

        // Covers what is asked for *and* what the outgoing canvas covered, per
        // axis: a run of layers whose sizes differ settles on one canvas instead
        // of trading places with each other. See [`StagingCanvas`].
        let (width, height) = match slot.as_ref() {
            Some(staging) => (staging.width.max(width), staging.height.max(height)),
            None => (width, height),
        };

        let canvas = wgpu::web_sys::OffscreenCanvas::new(width, height)
            .expect("Failed to create staging OffscreenCanvas");
        let context = offscreen_2d_context(&canvas, "VideoFrame staging");
        self.video_staging_allocations
            .set(self.video_staging_allocations.get() + 1);
        let handed_out = context.clone();
        *slot = Some(StagingCanvas {
            width,
            height,
            canvas,
            context,
        });
        handed_out
    }

    /// How many staging canvases have been built. See
    /// [`GpuContext::video_staging_allocations`].
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn video_staging_allocations(&self) -> u32 {
        self.video_staging_allocations.get()
    }

    /// Imports a `VideoFrame` into a GPU texture.
    ///
    /// The path is: draw the WebCodecs frame into an `OffscreenCanvas`, read
    /// the pixels out, then `write_texture` the bytes to the GPU. The draw
    /// is GPU-accelerated in every browser that has WebCodecs, so the only
    /// CPU cost here is the `getImageData` readback — the same shape as the
    /// existing `import_offscreen_canvas_texture` fallback for backends
    /// that lack `copyExternalImageToTexture`.
    ///
    /// We intentionally don't use `copyExternalImageToTexture` with a
    /// `VideoFrame` source even when `supports_external_texture_copies`
    /// reports success: the underlying browser validation is stricter than
    /// the downlevel flag suggests, and the call panics with a
    /// `UNRESTRICTED_EXTERNAL_TEXTURE_COPIES` validation error on devices
    /// where the flag check passes but the WebGPU `VideoFrame` source isn't
    /// accepted. The unwrap would surface as a console error each frame, so
    /// the safe path runs every time and we trade a `getImageData` round
    /// trip for correctness.
    ///
    /// `width` and `height` are a *target* size, not the frame's own: the draw
    /// scales the frame into them. Since the readback is per pixel and this
    /// path runs on every platform, a caller that knows the layer is only a
    /// few hundred pixels on screen can ask for that size and pay a fraction
    /// of the cost for a picture that is no different once composited. Passing
    /// the frame's native size keeps the old behaviour exactly.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn import_video_frame_texture(
        &self,
        video_frame: &wgpu::web_sys::VideoFrame,
        existing: Option<&wgpu::Texture>,
        width: u32,
        height: u32,
        label: &str,
    ) -> wgpu::Texture {
        let texture = self.render_texture_for(existing, width, height, label);
        let ctx = self.video_staging_context(width, height);
        ctx.clear_rect(0.0, 0.0, width as f64, height as f64);
        // The destination-size form, so a target smaller than the frame scales
        // it down rather than cropping it to the staging canvas. WebKitGTK is
        // known to ignore `drawImage`'s *source* rectangle for a VideoFrame
        // (see `drawCropped`, which is why the kept-region crop is expressed as
        // a negative destination offset instead) — the destination size is a
        // different argument and is honoured. The "A scaled VideoFrame draw
        // fills the staging canvas" desktop check holds that claim down.
        ctx.draw_image_with_video_frame_and_dw_and_dh(
            video_frame,
            0.0,
            0.0,
            width as f64,
            height as f64,
        )
        .expect("Failed to draw VideoFrame to staging canvas");
        self.upload_context_pixels(&texture, &ctx, width, height);
        texture
    }

    /// Reads a 2D context back with `getImageData` and uploads it to `texture`.
    ///
    /// `getImageData` always answers in RGBA order, so a BGRA target needs red
    /// and blue swapped on the way through. This is the CPU fallback for both
    /// import paths — the readback is the expensive part, not the swizzle.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    fn upload_context_pixels(
        &self,
        texture: &wgpu::Texture,
        ctx: &web_sys::OffscreenCanvasRenderingContext2d,
        width: u32,
        height: u32,
    ) {
        let image_data = ctx
            .get_image_data(0_i32, 0_i32, width as i32, height as i32)
            .expect("Failed to read pixel data from canvas");
        // `data()` already copies the canvas out of JS into a `Vec` here, so the
        // `to_vec()` this used to end with copied the whole frame a second time —
        // 6.2MB per upload at 1440x1080, per layer, per frame. Unwrapping the
        // `Clamped` takes the `Vec` that was already made.
        let wasm_bindgen::Clamped(mut pixels) = image_data.data();
        if self.texture_format == wgpu::TextureFormat::Bgra8Unorm {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
    }

    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn render_texture_to_offscreen_canvas(
        &self,
        texture: &wgpu::Texture,
        canvas: &wgpu::web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<(), GpuError> {
        if self.supports_external_texture_copies {
            let surface = self
                .instance
                .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))?;
            return self.render_texture_to_surface(texture, &surface, width, height);
        }

        // WebGL can only surface-render to the canvas its GL context was created
        // on, so render there and `drawImage` the result across.
        let gl_canvas = self.render_texture_to_gl_canvas_surface(texture, width, height)?;
        let ctx: web_sys::OffscreenCanvasRenderingContext2d = canvas
            .get_context("2d")
            .ok()
            .flatten()
            .ok_or(GpuError::AdapterUnavailable)?
            .unchecked_into();
        ctx.clear_rect(0.0, 0.0, width as f64, height as f64);
        ctx.draw_image_with_html_canvas_element(gl_canvas, 0.0, 0.0)
            .map_err(|_| GpuError::AdapterUnavailable)?;

        Ok(())
    }

    /// Renders `texture` to the canvas the WebGL context is bound to and returns
    /// it, so a caller on that path can mount or copy from it. The surface is
    /// cached because creating one per frame leaks GL contexts.
    #[cfg(all(feature = "wasm", target_arch = "wasm32"))]
    pub fn render_texture_to_gl_canvas_surface(
        &self,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<&web_sys::HtmlCanvasElement, GpuError> {
        let gl_canvas = self
            .gl_canvas
            .as_ref()
            .ok_or(GpuError::AdapterUnavailable)?;

        gl_canvas.set_width(width);
        gl_canvas.set_height(height);

        let mut cached = self.gl_surface.borrow_mut();
        if cached.is_none() {
            let surface = self
                .instance
                .create_surface(wgpu::SurfaceTarget::Canvas(gl_canvas.clone()))?;
            *cached = Some(CachedCanvasSurface {
                surface,
                size: (0, 0),
            });
        }
        let cached = cached
            .as_mut()
            .expect("gl_surface cache was just populated");

        if cached.size != (width, height) {
            self.configure_surface(&cached.surface, width, height)?;
            cached.size = (width, height);
        }

        self.present_texture_to_surface(texture, &cached.surface)?;

        Ok(gl_canvas)
    }

    /// Starts reading `width * height * 4` bytes of RGBA8 out of `texture`.
    /// The texture must have been created with `COPY_SRC` (the render
    /// textures built by [`Self::create_render_texture`] do).
    ///
    /// This is deliberately not a single blocking call. WebGL2 forbids
    /// blocking on a sync object — `clientWaitSync` is clamped to a zero
    /// timeout — so on the webview's backend a submission only retires once
    /// the caller has returned to the JavaScript event loop. A synchronous
    /// readback there is not slow, it never finishes: WebKit's IPC watchdog
    /// aborts the WebProcess after ten silent seconds. So the work splits
    /// into starting the copy, driving it from wherever the caller can
    /// yield, and taking the bytes once it lands.
    ///
    /// The byte order coming out of `wgpu` is whatever the texture's format
    /// declares: WebGL keeps it as `Rgba8Unorm`, but on the
    /// WebGPU/Metal/Vulkan backends it is `Bgra8Unorm`. [`TextureReadback`]
    /// post-processes on the way out so callers see the same RGBA layout on
    /// every engine.
    pub fn begin_texture_readback(
        &self,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
    ) -> Result<TextureReadback, GpuError> {
        if !texture.usage().contains(wgpu::TextureUsages::COPY_SRC) {
            return Err(GpuError::MissingCopySrc);
        }

        let unpadded_bytes_per_row = width * 4;
        // `copy_texture_to_buffer` requires `bytes_per_row` to be a multiple
        // of 256. Widths the editor actually uses mostly satisfy that already,
        // but a preview at an odd render scale does not, so the padding is
        // stripped in `take` rather than assumed away.
        let row_stride = unpadded_bytes_per_row.div_ceil(256) * 256;

        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-readback-buffer"),
            size: (row_stride * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("gpu-readback-encoder"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row_stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);

        let (sender, receiver) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| {
            // `send` only fails when the receiver was dropped, which happens
            // when the caller abandoned the readback. Nothing to report then.
            let _ = sender.send(result);
        });

        Ok(TextureReadback {
            buffer,
            receiver,
            width,
            height,
            row_stride,
            unpadded_bytes_per_row,
            swap_red_and_blue: texture.format() == wgpu::TextureFormat::Bgra8Unorm,
        })
    }

    /// Drives a readback one step without blocking. `Ok(true)` means the
    /// bytes are ready for [`TextureReadback::take`]; `Ok(false)` means the
    /// caller should yield to its event loop and ask again.
    pub fn poll_texture_readback(
        &self,
        readback: &TextureReadback,
    ) -> Result<bool, GpuError> {
        self.device
            .poll(wgpu::PollType::Poll)
            .map_err(|error| GpuError::BufferMap(format!("polling the readback: {error:?}")))?;
        readback.is_ready()
    }
}

/// A texture copy in flight, from [`GpuContext::begin_texture_readback`].
/// Held by the caller across event-loop turns until
/// [`GpuContext::poll_texture_readback`] reports it ready.
pub struct TextureReadback {
    buffer: wgpu::Buffer,
    receiver: std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
    width: u32,
    height: u32,
    row_stride: u32,
    unpadded_bytes_per_row: u32,
    swap_red_and_blue: bool,
}

impl TextureReadback {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Whether the map callback has run. `try_recv` rather than `recv`: this
    /// is asked from a poll loop, and a blocking wait here is the hang the
    /// split exists to avoid.
    fn is_ready(&self) -> Result<bool, GpuError> {
        match self.receiver.try_recv() {
            Ok(Ok(())) => Ok(true),
            Ok(Err(error)) => Err(GpuError::BufferMap(format!("{error:?}"))),
            Err(std::sync::mpsc::TryRecvError::Empty) => Ok(false),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => Err(GpuError::BufferMap(
                "the readback map callback was dropped without running".to_string(),
            )),
        }
    }

    /// Copies the mapped bytes out as row-major RGBA8, exactly
    /// `width * height * 4` long. Only call this once
    /// [`GpuContext::poll_texture_readback`] has answered `true`.
    pub fn take(self) -> Vec<u8> {
        let view = self.buffer.slice(..).get_mapped_range();
        let padded = view.to_vec();
        drop(view);
        self.buffer.unmap();

        let row_bytes = self.unpadded_bytes_per_row as usize;
        let mut pixels = Vec::with_capacity(row_bytes * self.height as usize);
        for row in 0..self.height as usize {
            let start = row * self.row_stride as usize;
            pixels.extend_from_slice(&padded[start..start + row_bytes]);
        }

        if self.swap_red_and_blue {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
        }

        pixels
    }
}

/// The one pipeline shape the renderer uses. Free-standing so
/// [`GpuContext::new`] can build the blit pipeline before `self` exists.
#[allow(clippy::too_many_arguments)]
fn create_fullscreen_pipeline(
    device: &wgpu::Device,
    label: &str,
    layout: &wgpu::PipelineLayout,
    vertex_module: &wgpu::ShaderModule,
    fragment_module: &wgpu::ShaderModule,
    fragment_entry_point: &str,
    texture_format: wgpu::TextureFormat,
    blend: Option<wgpu::BlendState>,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: vertex_module,
            entry_point: Some("vertex_main"),
            buffers: std::slice::from_ref(&FULLSCREEN_QUAD_VERTEX_LAYOUT),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: fragment_module,
            entry_point: Some(fragment_entry_point),
            targets: &[Some(wgpu::ColorTargetState {
                format: texture_format,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    })
}

/// The 2D context of an `OffscreenCanvas`, which every import path needs and
/// none can proceed without. `purpose` names the caller in the panic message.
///
/// Asked for with `willReadFrequently`, because every caller here reads the
/// canvas straight back with `getImageData`. The hint puts the backing store in
/// CPU memory, where a readback is a copy rather than a GPU-to-CPU sync. The
/// webview's own staging canvases already pass it (see `wasm-compositor.ts`);
/// this side did not, on the path that reads back once per video frame per layer
/// per frame.
///
/// On WebKitGTK it turns out to be load-bearing rather than advisory. Measured
/// by passing it explicitly false: the desktop self-check drops from 45/45 to
/// 43/45, with "a butt-joined cut has a non-black frame at every playhead frame"
/// reporting near-black at *every* tick and three Adjust sliders leaving the
/// frame untouched — i.e. a `VideoFrame` drawn into a GPU-resident canvas reads
/// back as black here. Omitting the option behaves like `true` on this engine,
/// which is why the original code worked; saying it explicitly is what keeps an
/// engine that defaults the other way from rendering black.
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
fn offscreen_2d_context(
    canvas: &wgpu::web_sys::OffscreenCanvas,
    purpose: &str,
) -> web_sys::OffscreenCanvasRenderingContext2d {
    let options = js_sys::Object::new();
    // Ignoring the result: a browser that does not know the key leaves it unset,
    // which is the behaviour this had before.
    let _ = js_sys::Reflect::set(
        &options,
        &JsValue::from_str("willReadFrequently"),
        &JsValue::TRUE,
    );
    canvas
        .get_context_with_context_options("2d", &options)
        .ok()
        .flatten()
        .unwrap_or_else(|| panic!("Failed to get 2d context for {purpose}"))
        .unchecked_into()
}
