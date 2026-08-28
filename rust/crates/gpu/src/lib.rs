mod context;
mod texture_pool;

use thiserror::Error;

pub use context::{GpuContext, TextureReadback};
pub use texture_pool::TexturePool;
pub use wgpu;

#[derive(Debug, Error)]
pub enum GpuError {
    #[error("No WebGPU adapter is available")]
    AdapterUnavailable,
    #[error("Failed to request a WebGPU device: {0}")]
    RequestDevice(#[from] wgpu::RequestDeviceError),
    #[error("Failed to create a WebGPU surface: {0}")]
    CreateSurface(#[from] wgpu::CreateSurfaceError),
    #[error("The output surface does not support the required texture format")]
    UnsupportedSurfaceFormat,
    #[error("Failed to map the readback buffer: {0}")]
    BufferMap(String),
    #[error("The output texture is missing the COPY_SRC usage flag")]
    MissingCopySrc,
}
