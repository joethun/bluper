//! Effect-side helpers: the per-frame numerics that the canvas drawing layer
//! calls. Drawing itself stays TypeScript — the canvas context is a browser
//! API and nothing here would buy anything by crossing the bridge with it.

pub mod canvas;
pub mod gaussian_blur;
