use std::collections::HashMap;

use crate::{GpuContext, wgpu};

type TextureKey = (u32, u32);

/// Render targets recycled between frames, keyed by size.
///
/// Every intermediate a frame draws into — the scene, a layer, an effect pass'
/// output — is a full-size render texture, and a frame needs several per layer.
/// Allocating them per frame means the driver is handing out and reclaiming tens
/// of megabytes sixty times a second, which on the WebGL backend shows up as
/// stalls rather than as memory growth.
///
/// [`Self::acquire`] never returns a texture that has already been handed out
/// this frame, so a pass can read one and write another without aliasing.
/// [`Self::recycle_frame`] is what makes them available again, and must only be
/// called once the frame's commands have been submitted.
#[derive(Default)]
pub struct TexturePool {
    available: HashMap<TextureKey, Vec<wgpu::Texture>>,
    in_use: Vec<(TextureKey, wgpu::Texture)>,
}

impl TexturePool {
    pub fn recycle_frame(&mut self) {
        for (key, texture) in self.in_use.drain(..) {
            self.available.entry(key).or_default().push(texture);
        }
    }

    pub fn acquire(
        &mut self,
        context: &GpuContext,
        width: u32,
        height: u32,
        label: &'static str,
    ) -> wgpu::Texture {
        let key = (width, height);
        let texture = self
            .available
            .get_mut(&key)
            .and_then(Vec::pop)
            .unwrap_or_else(|| context.create_render_texture(width, height, label));
        self.in_use.push((key, texture.clone()));
        texture
    }
}
