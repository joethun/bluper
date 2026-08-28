use std::collections::HashMap;

use gpu::wgpu;

struct StoredTexture {
    texture: wgpu::Texture,
    /// Bumped on every upload to this id. Anything that derives a texture from
    /// this one and caches the result across frames compares generations to
    /// know whether its cached copy is still current.
    generation: u64,
}

/// The textures the webview has uploaded, keyed by the id it refers to them by.
/// A `wgpu::Texture` is a cheap handle, so cloning one out to render with costs
/// a refcount bump rather than a copy.
#[derive(Default)]
pub struct TextureStore {
    textures: HashMap<String, StoredTexture>,
}

impl TextureStore {
    pub fn upsert(&mut self, id: String, texture: wgpu::Texture) {
        match self.textures.get_mut(&id) {
            Some(stored) => {
                stored.texture = texture;
                stored.generation = stored.generation.wrapping_add(1);
            }
            None => {
                self.textures.insert(
                    id,
                    StoredTexture {
                        texture,
                        generation: 0,
                    },
                );
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<&wgpu::Texture> {
        self.textures.get(id).map(|stored| &stored.texture)
    }

    /// How many times `id` has been uploaded. `None` for an id the store has
    /// never held, which no cache entry can match.
    pub fn generation(&self, id: &str) -> Option<u64> {
        self.textures.get(id).map(|stored| stored.generation)
    }

    pub fn remove(&mut self, id: &str) {
        self.textures.remove(id);
    }
}
