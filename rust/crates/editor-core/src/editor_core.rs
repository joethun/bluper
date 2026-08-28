//! The editor's platform-agnostic domain layer.
//!
//! Nothing here may reference a UI framework, a browser API, or `wasm_bindgen`
//! directly: the `wasm` feature gates the bindings so the same code compiles
//! natively for the desktop shell. See `rust/README.md`.

pub mod adjustments;
pub mod animation;
pub mod audio;
pub mod audio_separation;
pub mod clip;
pub mod effects;
pub mod export;
pub mod freeze;
pub mod gradients;
pub mod graphics;
pub mod masks;
pub mod math;
pub mod media;
pub mod model;
pub mod params;
pub mod preview;
pub mod project;
pub mod retime;
pub mod selection;
pub mod storage;
pub mod text;
pub mod timeline;
pub mod transitions;
