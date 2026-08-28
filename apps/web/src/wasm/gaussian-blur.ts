import {
	buildGaussianBlurPasses as _buildGaussianBlurPasses,
	intensityToSigma as _intensityToSigma,
} from "bluper-wasm";
import type { EffectPass } from "@/effects/types";

/**
 * Per-frame gaussian blur pass planning, now owned by
 * `editor-core::gaussian_blur`.
 *
 * The renderer still speaks `EffectPass` shape on the TS side; Rust produces
 * `{x, y}` for `u_direction` (a bare `[number, number]` would cross as an
 * object with numeric keys and lose every field on the host), so the wrapper
 * rebuilds the tuple.
 */
export function buildGaussianBlurPasses({
	sigmaX,
	sigmaY,
}: {
	sigmaX: number;
	sigmaY: number;
}): EffectPass[] {
	const { passes } = _buildGaussianBlurPasses({ sigmaX, sigmaY });
	return passes.map(({ shader, uniforms }) => ({
		shader,
		uniforms: {
			u_sigma: uniforms.uSigma,
			u_step: uniforms.uStep,
			u_direction: [uniforms.uDirection.x, uniforms.uDirection.y],
		},
	}));
}

export function intensityToSigma({
	intensity,
	resolution,
	reference,
}: {
	intensity: number;
	resolution: number;
	reference: number;
}): number {
	return _intensityToSigma({ intensity, resolution, reference });
}
