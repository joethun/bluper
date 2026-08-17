use std::collections::HashMap;

use gpu::wgpu;

/// The textures the webview has uploaded, keyed by the id it refers to them by.
/// A `wgpu::Texture` is a cheap handle, so cloning one out to render with costs
/// a refcount bump rather than a copy.
#[derive(Default)]
pub struct TextureStore {
    textures: HashMap<String, wgpu::Texture>,
}

impl TextureStore {
    pub fn upsert(&mut self, id: String, texture: wgpu::Texture) {
        self.textures.insert(id, texture);
    }

    pub fn get(&self, id: &str) -> Option<&wgpu::Texture> {
        self.textures.get(id)
    }

    pub fn remove(&mut self, id: &str) {
        self.textures.remove(id);
    }
}
