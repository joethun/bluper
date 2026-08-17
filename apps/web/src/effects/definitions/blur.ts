// The blur effect preset was removed, but the renderer still uses these
// gaussian-blur helpers for the project background blur (see
// services/renderer/resolve.ts).
import type { EffectPass } from "@/effects/types";

const GAUSSIAN_BLUR_SHADER = "gaussian-blur";

const MAX_SINGLE_PASS_SIGMA = 10;
const MAX_STEP = 4;
const MAX_EFFECTIVE_SIGMA = MAX_SINGLE_PASS_SIGMA * MAX_STEP;
const MAX_ITERATIONS = 8;

export function buildGaussianBlurPasses({
	sigmaX,
	sigmaY,
}: {
	sigmaX: number;
	sigmaY: number;
}): EffectPass[] {
	const maxSigma = Math.max(sigmaX, sigmaY);
	if (maxSigma < 0.001) return [];

	const iterations = Math.min(
		MAX_ITERATIONS,
		Math.max(
			1,
			Math.ceil(
				(maxSigma * maxSigma) / (MAX_EFFECTIVE_SIGMA * MAX_EFFECTIVE_SIGMA),
			),
		),
	);
	const perPassSigmaX = sigmaX / Math.sqrt(iterations);
	const perPassSigmaY = sigmaY / Math.sqrt(iterations);
	const stepX = Math.max(1, perPassSigmaX / MAX_SINGLE_PASS_SIGMA);
	const stepY = Math.max(1, perPassSigmaY / MAX_SINGLE_PASS_SIGMA);

	const passes: EffectPass[] = [];
	for (let i = 0; i < iterations; i++) {
		passes.push({
			shader: GAUSSIAN_BLUR_SHADER,
			uniforms: {
				u_sigma: perPassSigmaX,
				u_step: stepX,
				u_direction: [1, 0],
			},
		});
		passes.push({
			shader: GAUSSIAN_BLUR_SHADER,
			uniforms: {
				u_sigma: perPassSigmaY,
				u_step: stepY,
				u_direction: [0, 1],
			},
		});
	}
	return passes;
}

const INTENSITY_TO_SIGMA_DIVISOR = 5;

export function intensityToSigma({
	intensity,
	resolution,
	reference,
}: {
	intensity: number;
	resolution: number;
	reference: number;
}): number {
	return (intensity / INTENSITY_TO_SIGMA_DIVISOR) * (resolution / reference);
}
