#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;

use compositor::{Compositor, FrameDescriptor, RenderFrameOptions};
use gpu::wgpu;
use js_sys::Object;
use wasm_bindgen::{JsCast, JsValue, prelude::wasm_bindgen};

use crate::gpu::{
    read_offscreen_canvas_property, read_serde_property, read_u32_property,
    read_video_frame_property, with_gpu_runtime,
};
use crate::perf;

struct CompositorRuntime {
    canvas: web_sys::HtmlCanvasElement,
    compositor: Compositor,
    surface: wgpu::Surface<'static>,
    surface_size: (u32, u32),
}

thread_local! {
    static COMPOSITOR_RUNTIME: RefCell<Option<CompositorRuntime>> = const { RefCell::new(None) };
}

#[wasm_bindgen(js_name = initCompositor)]
pub fn init_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        // On WebGL, wgpu is bound to a specific canvas; reuse it so the UI
        // can mount the output directly instead of copying pixels through
        // an intermediate 2D canvas every frame. On WebGPU, surface rendering
        // works against any canvas so we create a fresh one.
        let canvas = if let Some(gl_canvas) = gpu_runtime.context.gl_canvas() {
            gl_canvas.clone()
        } else {
            let document = web_sys::window()
                .and_then(|window| window.document())
                .ok_or_else(|| JsValue::from_str("Document is not available"))?;
            document
                .create_element("canvas")?
                .dyn_into::<web_sys::HtmlCanvasElement>()
                .map_err(|_| JsValue::from_str("Failed to create compositor canvas"))?
        };
        canvas.set_width(width);
        canvas.set_height(height);

        let compositor = Compositor::new(&gpu_runtime.context);
        let surface = gpu_runtime
            .context
            .instance()
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        gpu_runtime
            .context
            .configure_surface(&surface, width, height)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;

        COMPOSITOR_RUNTIME.with(|runtime| {
            runtime.replace(Some(CompositorRuntime {
                canvas,
                compositor,
                surface,
                surface_size: (width, height),
            }));
        });

        Ok(())
    })
}

#[wasm_bindgen(js_name = resizeCompositor)]
pub fn resize_compositor(width: u32, height: u32) -> Result<(), JsValue> {
    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };
            runtime.canvas.set_width(width);
            runtime.canvas.set_height(height);
            if runtime.surface_size != (width, height) {
                gpu_runtime
                    .context
                    .configure_surface(&runtime.surface, width, height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                runtime.surface_size = (width, height);
            }
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = getCompositorCanvas)]
pub fn get_compositor_canvas() -> Result<web_sys::HtmlCanvasElement, JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let borrow = runtime.borrow();
        let Some(runtime) = borrow.as_ref() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        Ok(runtime.canvas.clone())
    })
}

#[wasm_bindgen(js_name = uploadTexture)]
pub fn upload_texture(options: JsValue) -> Result<(), JsValue> {
    let UploadTextureOptions {
        id,
        source,
        width,
        height,
    } = parse_upload_texture_options(options)?;

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            let texture = gpu_runtime.context.import_offscreen_canvas_texture(
                &source,
                width,
                height,
                "compositor-upload-texture",
            );
            runtime.compositor.upsert_texture(id, texture);
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = uploadVideoFrame)]
pub fn upload_video_frame(options: JsValue) -> Result<(), JsValue> {
    let UploadVideoFrameOptions {
        id,
        source,
        width,
        height,
    } = parse_upload_video_frame_options(options)?;

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            let texture = gpu_runtime.context.import_video_frame_texture(
                &source,
                width,
                height,
                "compositor-upload-video-frame",
            );
            runtime.compositor.upsert_texture(id, texture);
            Ok(())
        })
    })
}

#[wasm_bindgen(js_name = releaseTexture)]
pub fn release_texture(id: String) -> Result<(), JsValue> {
    COMPOSITOR_RUNTIME.with(|runtime| {
        let mut borrow = runtime.borrow_mut();
        let Some(runtime) = borrow.as_mut() else {
            return Err(JsValue::from_str(
                "Compositor is not initialized. Call initCompositor() first.",
            ));
        };
        runtime.compositor.release_texture(&id);
        Ok(())
    })
}

#[wasm_bindgen(js_name = renderFrame)]
pub fn render_frame(options: JsValue) -> Result<(), JsValue> {
    perf::reset();

    let t_deserialize = perf::now_ms();
    let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;
    perf::record("wasm.deserialize", perf::now_ms() - t_deserialize);

    with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };

            // The canvas is sized to the pixels the frame is actually drawn at,
            // which below full render scale is smaller than the project's
            // canvas. The preview stretches it back with CSS, so dropping the
            // scale during playback costs a reconfigure here and nothing else.
            let (target_width, target_height) = frame.target_size();
            if runtime.surface_size != (target_width, target_height) {
                runtime.canvas.set_width(target_width);
                runtime.canvas.set_height(target_height);
                let t_surface = perf::now_ms();
                gpu_runtime
                    .context
                    .configure_surface(&runtime.surface, target_width, target_height)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.surfaceConfigure", perf::now_ms() - t_surface);
                runtime.surface_size = (target_width, target_height);
            }

            if gpu_runtime.context.supports_surface_rendering() {
                let t_render = perf::now_ms();
                let result = runtime
                    .compositor
                    .render_frame(
                        &gpu_runtime.context,
                        RenderFrameOptions {
                            frame: &frame,
                            surface: &runtime.surface,
                        },
                    )
                    .map_err(|error| JsValue::from_str(&error.to_string()));
                perf::record("wasm.renderFrameToSurface", perf::now_ms() - t_render);
                result
            } else {
                // WebGL still needs a separate composition pass, but the output
                // surface is now persistent just like the WebGPU path.
                let t_composite = perf::now_ms();
                let texture = runtime
                    .compositor
                    .render_frame_to_texture(&gpu_runtime.context, &frame)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.compositeToTexture", perf::now_ms() - t_composite);

                let t_present = perf::now_ms();
                gpu_runtime
                    .context
                    .present_texture_to_surface(&texture, &runtime.surface)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?;
                perf::record("wasm.presentToSurface", perf::now_ms() - t_present);

                Ok(())
            }
        })
    })
}

/// Renders `frame` and reads the result back as a row-major RGBA8 byte
/// buffer, sized `width * height * 4` in the canonical RGBA order. Width and
/// height are returned as a plain object — `Uint8Array::length` alone does
/// not pin the shape, since the buffer could come back at a non-square
/// resolution and the bytes-only handoff would lose that.
///
/// The bytes cross as one `memcpy` of `width * height * 4`. Step 3's ffmpeg
/// encoder consumes them inside the same Rust process so this copy
/// disappears in the production path; the current shape exists for the
/// parity harness (step 5) and any JS caller that wants to inspect the
/// pixels directly.
///
/// The call is asynchronous because it has to be: WebGL2 refuses to block on
/// a sync object, so the GPU copy only retires once the caller has returned
/// to the event loop.
///
/// The `Compositor` is reused across calls to amortise its pipelines. A
/// concurrent call would race on the runtime lock and fail the same way a
/// future `renderFrame` does under re-entry — see `CanvasRenderer` on the JS
/// side for the lock story.
#[wasm_bindgen(typescript_custom_section)]
const READBACK_FRAME_TYPE: &'static str = r#"
export interface ReadbackFrame {
    pixels: Uint8Array;
    width: number;
    height: number;
}
"#;

#[wasm_bindgen]
extern "C" {
    /// The object `readbackFrame` hands back. Declared as an imported
    /// type rather than a `tsify` struct because `pixels` has to stay a
    /// `Uint8Array`: serialising a `Vec<u8>` through serde would turn an
    /// 8 MB frame into eight million JS numbers, which is the boundary
    /// rule AGENTS.md forbids. This way the bytes still cross as one
    /// `memcpy` and the generated `.d.ts` still names the shape, so a
    /// field the Rust side stops setting is a type error on the JS side
    /// rather than an `undefined` nobody notices.
    #[wasm_bindgen(typescript_type = "ReadbackFrame")]
    pub type JsReadbackFrame;
}

/// Hands control back to the host's task queue for one turn.
///
/// A microtask (`Promise.resolve()`) would not do: microtasks drain before
/// the event loop runs again, so a poll loop built on one is a spin that
/// never lets the browser breathe. `setTimeout` is looked up off the global
/// rather than off `window` so this keeps working in a worker.
async fn yield_to_event_loop() -> Result<(), JsValue> {
    let global = js_sys::global();
    let set_timeout = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))?
        .dyn_into::<js_sys::Function>()
        .map_err(|_| JsValue::from_str("the host has no setTimeout to yield through"))?;

    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        // A zero delay is a request to run on the next task, not an
        // instruction to run in zero milliseconds; the host clamps it.
        let _ = set_timeout.call2(&JsValue::UNDEFINED, &resolve, &JsValue::from_f64(0.0));
    });
    wasm_bindgen_futures::JsFuture::from(promise).await?;
    Ok(())
}

/// How many event-loop turns a single frame's readback may take before it is
/// reported as stuck. At one turn per `setTimeout(0)` — around 4 ms once the
/// host's clamp is applied — this is several seconds, far past any real
/// copy, and short of the ten seconds after which WebKit would abort the
/// WebProcess for going quiet.
const READBACK_MAX_TURNS: u32 = 512;

#[wasm_bindgen(js_name = readbackFrame)]
pub async fn readback_frame(options: JsValue) -> Result<JsReadbackFrame, JsValue> {
    let frame: FrameDescriptor = serde_wasm_bindgen::from_value(options)
        .map_err(|error| JsValue::from_str(&format!("Invalid frame descriptor: {error}")))?;

    // The borrows on the two thread-local runtimes are taken and dropped
    // inside each step. Holding one across an `await` would leave the
    // `RefCell` borrowed while other calls run on the same thread, and the
    // next `renderFrame` would panic rather than fail.
    let readback = with_gpu_runtime(|gpu_runtime| {
        COMPOSITOR_RUNTIME.with(|runtime| {
            let mut borrow = runtime.borrow_mut();
            let Some(runtime) = borrow.as_mut() else {
                return Err(JsValue::from_str(
                    "Compositor is not initialized. Call initCompositor() first.",
                ));
            };
            runtime
                .compositor
                .begin_frame_readback(&gpu_runtime.context, &frame)
                .map_err(|error| JsValue::from_str(&error.to_string()))
        })
    })?;

    let mut turns = 0;
    loop {
        let ready = with_gpu_runtime(|gpu_runtime| {
            gpu_runtime
                .context
                .poll_texture_readback(&readback)
                .map_err(|error| JsValue::from_str(&error.to_string()))
        })?;
        if ready {
            break;
        }
        turns += 1;
        if turns > READBACK_MAX_TURNS {
            return Err(JsValue::from_str(
                "the frame readback did not complete; the GPU copy never retired",
            ));
        }
        yield_to_event_loop().await?;
    }

    let width = readback.width();
    let height = readback.height();
    let pixels = readback.take();

    let array = js_sys::Uint8Array::new_with_length(pixels.len() as u32);
    array.copy_from(&pixels);

    let descriptor = js_sys::Object::new();
    js_sys::Reflect::set(&descriptor, &JsValue::from_str("pixels"), &array)?;
    js_sys::Reflect::set(
        &descriptor,
        &JsValue::from_str("width"),
        &JsValue::from(width),
    )?;
    js_sys::Reflect::set(
        &descriptor,
        &JsValue::from_str("height"),
        &JsValue::from(height),
    )?;
    Ok(JsValue::from(descriptor).unchecked_into())
}

#[derive(Debug)]
struct UploadTextureOptions {
    id: String,
    source: wgpu::web_sys::OffscreenCanvas,
    width: u32,
    height: u32,
}

fn parse_upload_texture_options(value: JsValue) -> Result<UploadTextureOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadTexture expects an options object"))?;

    Ok(UploadTextureOptions {
        id: read_serde_property(&object, "id")?,
        source: read_offscreen_canvas_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}

#[derive(Debug)]
struct UploadVideoFrameOptions {
    id: String,
    source: wgpu::web_sys::VideoFrame,
    width: u32,
    height: u32,
}

fn parse_upload_video_frame_options(value: JsValue) -> Result<UploadVideoFrameOptions, JsValue> {
    let object: Object = value
        .dyn_into()
        .map_err(|_| JsValue::from_str("uploadVideoFrame expects an options object"))?;

    Ok(UploadVideoFrameOptions {
        id: read_serde_property(&object, "id")?,
        source: read_video_frame_property(&object, "source")?,
        width: read_u32_property(&object, "width")?,
        height: read_u32_property(&object, "height")?,
    })
}
