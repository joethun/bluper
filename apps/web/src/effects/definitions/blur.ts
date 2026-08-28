// The blur effect preset was removed, but the renderer still uses these
// gaussian-blur helpers for the project background blur (see
// services/renderer/resolve.ts). Math now owned by `editor-core::gaussian_blur`.
export { buildGaussianBlurPasses, intensityToSigma } from "@/wasm";
