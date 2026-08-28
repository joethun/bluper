//! Per-frame gaussian blur pass planning. The effect itself is no longer in the
//! library, but the project background blur (and the transition-side defocus)
//! still use these helpers, so the maths runs every frame the blur is on screen.

use bridge::export;
use serde::{Deserialize, Serialize};

const GAUSSIAN_BLUR_SHADER: &str = "gaussian-blur";
const MAX_SINGLE_PASS_SIGMA: f64 = 10.0;
const MAX_STEP: f64 = 4.0;
const MAX_EFFECTIVE_SIGMA: f64 = MAX_SINGLE_PASS_SIGMA * MAX_STEP;
const MAX_ITERATIONS: u32 = 8;

const INTENSITY_TO_SIGMA_DIVISOR: f64 = 5.0;

/// A 2-component vector uniform value. The TypeScript source used a bare
/// `[number, number]`, which `serde_wasm_bindgen` would emit as an object with
/// numeric keys — every read on the host side comes back `undefined`. A named
/// struct avoids that and survives the bridge as a plain object.
#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Vector2D {
    pub x: f64,
    pub y: f64,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlurUniforms {
    pub u_sigma: f64,
    pub u_step: f64,
    pub u_direction: Vector2D,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlurPass {
    pub shader: &'static str,
    pub uniforms: BlurUniforms,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(into_wasm_abi, hashmap_as_object))]
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlurPasses {
    pub passes: Vec<BlurPass>,
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GaussianBlurOptions {
    pub sigma_x: f64,
    pub sigma_y: f64,
}

/// Decomposes a blur radius into separable horizontal and vertical passes. A
/// single shader pass tops out at `MAX_SINGLE_PASS_SIGMA`, so a larger radius
/// has to be repeated — each repeat halves the per-pass sigma — until the
/// whole radius has been applied.
#[export]
pub fn build_gaussian_blur_passes(
    GaussianBlurOptions {
        sigma_x,
        sigma_y,
    }: GaussianBlurOptions,
) -> BlurPasses {
    let max_sigma = sigma_x.max(sigma_y);
    if max_sigma < 0.001 {
        return BlurPasses { passes: Vec::new() };
    }

    let iterations = MAX_ITERATIONS.min(
        1u32.max(
            (max_sigma * max_sigma / (MAX_EFFECTIVE_SIGMA * MAX_EFFECTIVE_SIGMA))
                .ceil() as u32,
        ),
    );
    let per_pass_sigma_x = sigma_x / (iterations as f64).sqrt();
    let per_pass_sigma_y = sigma_y / (iterations as f64).sqrt();
    let step_x = 1.0_f64.max(per_pass_sigma_x / MAX_SINGLE_PASS_SIGMA);
    let step_y = 1.0_f64.max(per_pass_sigma_y / MAX_SINGLE_PASS_SIGMA);

    let mut passes = Vec::with_capacity((iterations as usize) * 2);
    for _ in 0..iterations {
        passes.push(BlurPass {
            shader: GAUSSIAN_BLUR_SHADER,
            uniforms: BlurUniforms {
                u_sigma: per_pass_sigma_x,
                u_step: step_x,
                u_direction: Vector2D { x: 1.0, y: 0.0 },
            },
        });
        passes.push(BlurPass {
            shader: GAUSSIAN_BLUR_SHADER,
            uniforms: BlurUniforms {
                u_sigma: per_pass_sigma_y,
                u_step: step_y,
                u_direction: Vector2D { x: 0.0, y: 1.0 },
            },
        });
    }
    BlurPasses { passes }
}

#[cfg_attr(feature = "wasm", derive(tsify_next::Tsify))]
#[cfg_attr(feature = "wasm", tsify(from_wasm_abi, hashmap_as_object))]
#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IntensityToSigmaOptions {
    pub intensity: f64,
    pub resolution: f64,
    pub reference: f64,
}

/// Maps a user-facing blur intensity (0..N) to the sigma the gpu pass uses,
/// scaled against a reference resolution so the same intensity looks the same
/// on a 720p clip and a 4K one.
#[export]
pub fn intensity_to_sigma(
    IntensityToSigmaOptions {
        intensity,
        resolution,
        reference,
    }: IntensityToSigmaOptions,
) -> f64 {
    (intensity / INTENSITY_TO_SIGMA_DIVISOR) * (resolution / reference)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_radius_returns_no_passes() {
        assert!(
            build_gaussian_blur_passes(GaussianBlurOptions {
                sigma_x: 0.0,
                sigma_y: 0.0,
            })
            .passes
            .is_empty()
        );
    }

    #[test]
    fn a_small_radius_runs_one_iteration() {
        let passes = build_gaussian_blur_passes(GaussianBlurOptions {
            sigma_x: 5.0,
            sigma_y: 5.0,
        });
        // One iteration → horizontal then vertical.
        assert_eq!(passes.passes.len(), 2);
        assert_eq!(passes.passes[0].uniforms.u_direction.x, 1.0);
        assert_eq!(passes.passes[0].uniforms.u_direction.y, 0.0);
        assert_eq!(passes.passes[1].uniforms.u_direction.x, 0.0);
        assert_eq!(passes.passes[1].uniforms.u_direction.y, 1.0);
    }

    #[test]
    fn intensity_scales_with_resolution() {
        let sigma_720 = intensity_to_sigma(IntensityToSigmaOptions {
            intensity: 5.0,
            resolution: 1280.0,
            reference: 1920.0,
        });
        let sigma_4k = intensity_to_sigma(IntensityToSigmaOptions {
            intensity: 5.0,
            resolution: 3840.0,
            reference: 1920.0,
        });
        // 4K should be exactly 3× the 720p sigma.
        assert!((sigma_4k - sigma_720 * 3.0).abs() < 1e-9);
    }
}
