#[cfg(target_arch = "wasm32")]
mod compositor;
#[cfg(target_arch = "wasm32")]
mod effects;
#[cfg(target_arch = "wasm32")]
mod export;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(target_arch = "wasm32")]
mod masks;
#[cfg(target_arch = "wasm32")]
mod perf;

#[cfg(target_arch = "wasm32")]
pub use compositor::*;
#[cfg(target_arch = "wasm32")]
pub use effects::*;
#[cfg(target_arch = "wasm32")]
pub use export::*;
#[cfg(target_arch = "wasm32")]
pub use gpu::*;
#[cfg(target_arch = "wasm32")]
pub use masks::*;
#[cfg(target_arch = "wasm32")]
pub use perf::*;
// Re-exporting the domain crate's modules is what puts their `#[export]`
// bindings on this crate's public surface, which is where `wasm-bindgen`'s glue
// generation looks. Dropping a module here drops every function it exports from
// the built package.
pub use editor_core::adjustments::*;
pub use editor_core::animation::*;
pub use editor_core::audio::*;
pub use editor_core::audio_separation::*;
pub use editor_core::clip::*;
pub use editor_core::effects::*;
pub use editor_core::export::*;
pub use editor_core::freeze::*;
pub use editor_core::gradients::*;
pub use editor_core::graphics::*;
pub use editor_core::math::*;
pub use editor_core::masks::*;
pub use editor_core::media::*;
pub use editor_core::params::*;
pub use editor_core::preview::*;
pub use editor_core::project::*;
pub use editor_core::retime::*;
pub use editor_core::selection::*;
pub use editor_core::storage::*;
pub use editor_core::text::*;
pub use editor_core::timeline::*;
pub use editor_core::transitions::*;
pub use time::*;
