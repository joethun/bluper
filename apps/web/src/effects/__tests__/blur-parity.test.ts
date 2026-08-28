import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { EffectPass } from "@/effects/types";

mock.module("bluper-wasm", () => wasmNative);

const { buildGaussianBlurPasses, intensityToSigma } = await import(
	"@/wasm/gaussian-blur"
);

/**
 * `buildGaussianBlurPasses` and `intensityToSigma` moved to
 * `editor-core::gaussian_blur`. The TypeScript reference implementations
 * stay here as long as both exist; this exercises a fixed set of inputs so
 * the harness catches a typo before the TS goes away.
 */

interface BlurInput {
	sigmaX: number;
	sigmaY: number;
}

function referenceBuildGaussianBlurPasses({
	sigmaX,
	sigmaY,
}: BlurInput): EffectPass[] {
	const MAX_SINGLE_PASS_SIGMA = 10;
	const MAX_STEP = 4;
	const MAX_EFFECTIVE_SIGMA = MAX_SINGLE_PASS_SIGMA * MAX_STEP;
	const MAX_ITERATIONS = 8;

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
			shader: "gaussian-blur",
			uniforms: {
				u_sigma: perPassSigmaX,
				u_step: stepX,
				u_direction: [1, 0],
			},
		});
		passes.push({
			shader: "gaussian-blur",
			uniforms: {
				u_sigma: perPassSigmaY,
				u_step: stepY,
				u_direction: [0, 1],
			},
		});
	}
	return passes;
}

function referenceIntensityToSigma({
	intensity,
	resolution,
	reference,
}: {
	intensity: number;
	resolution: number;
	reference: number;
}): number {
	return (intensity / 5) * (resolution / reference);
}

const cases: BlurInput[] = [
	{ sigmaX: 0, sigmaY: 0 },
	{ sigmaX: 5, sigmaY: 5 },
	{ sigmaX: 25, sigmaY: 25 },
	{ sigmaX: 100, sigmaY: 25 },
	{ sigmaX: 7.5, sigmaY: 3.2 },
	{ sigmaX: 1.5, sigmaY: 1.5 },
];

test("each blur input reproduces the reference", () => {
	for (const input of cases) {
		expect(buildGaussianBlurPasses(input)).toEqual(
			referenceBuildGaussianBlurPasses(input),
		);
	}
});

test("intensity to sigma scales linearly", () => {
	expect(
		intensityToSigma({ intensity: 5, resolution: 1920, reference: 1920 }),
	).toBeCloseTo(referenceIntensityToSigma({ intensity: 5, resolution: 1920, reference: 1920 }), 12);
});
