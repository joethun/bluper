import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { describeParityMismatch, findParityMismatch } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const { resolveTransformAtTime, resolveAnimationPathValueAtTime } = await import(
	"@/wasm/animation"
);

/**
 * The per-frame transform resolver, owned by
 * `editor-core::animation::keyframes_query`.
 *
 * The TS original in `apps/web/src/rendering/animation-values.ts` made five
 * `resolveAnimationPathValueAtTime` calls and stitched the answers together;
 * the port does those five reads inside Rust so the renderer crosses the wasm
 * boundary once per element instead of six times. There is no TypeScript
 * implementation left to diff against — `animation-values.ts` is now a façade
 * over this call — so the differential below is against the *decomposition*:
 * the five separate calls the consolidated one replaced. That is what the
 * consolidation could plausibly break, and it also exercises the boundary,
 * since the animations object has to deserialise into `ElementAnimations` for
 * either side to see a keyframe at all.
 */

const TRANSFORM_PATHS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
] as const;

interface BaseTransform {
	position: { x: number; y: number };
	scaleX: number;
	scaleY: number;
	rotate: number;
}

function makeKey({ time, value }: { time: number; value: number }) {
	return {
		id: `k${time}`,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		time: time as never,
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function makeScalarChannel({
	keys,
}: {
	keys: ReturnType<typeof makeKey>[];
}) {
	return { keys };
}

/** The five separate reads the consolidated call replaced. */
function resolveViaSeparateCalls({
	animations,
	baseTransform,
	localTime,
}: {
	animations: Record<string, unknown> | undefined;
	baseTransform: BaseTransform;
	localTime: number;
}): BaseTransform {
	const read = ({
		propertyPath,
		fallbackValue,
	}: {
		propertyPath: string;
		fallbackValue: number;
	}) =>
		// The façade answers `unknown` because a path can resolve to text or a
		// bool; every `transform.*` path is number-typed.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		resolveAnimationPathValueAtTime({
			animations,
			propertyPath,
			localTime: Math.max(0, localTime),
			fallbackValue,
		}) as number;

	return {
		position: {
			x: read({
				propertyPath: "transform.positionX",
				fallbackValue: baseTransform.position.x,
			}),
			y: read({
				propertyPath: "transform.positionY",
				fallbackValue: baseTransform.position.y,
			}),
		},
		scaleX: read({
			propertyPath: "transform.scaleX",
			fallbackValue: baseTransform.scaleX,
		}),
		scaleY: read({
			propertyPath: "transform.scaleY",
			fallbackValue: baseTransform.scaleY,
		}),
		rotate: read({
			propertyPath: "transform.rotate",
			fallbackValue: baseTransform.rotate,
		}),
	};
}

test("resolveTransformAtTime returns the base transform when nothing is animated", () => {
	const base: BaseTransform = {
		position: { x: 100, y: 200 },
		scaleX: 1.5,
		scaleY: 0.5,
		rotate: 45,
	};

	expect(
		resolveTransformAtTime({
			animations: undefined,
			baseTransform: base,
			localTime: 0,
		}),
	).toEqual(base);
	expect(
		resolveTransformAtTime({
			animations: {},
			baseTransform: base,
			localTime: 1000,
		}),
	).toEqual(base);
	// A channel with no keys is not an animation either.
	expect(
		resolveTransformAtTime({
			animations: { "transform.rotate": makeScalarChannel({ keys: [] }) },
			baseTransform: base,
			localTime: 1000,
		}),
	).toEqual(base);
});

test("resolveTransformAtTime reads each transform path independently", () => {
	const base: BaseTransform = {
		position: { x: 0, y: 0 },
		scaleX: 1,
		scaleY: 1,
		rotate: 0,
	};

	// One path animated at a time: every other component must stay on its base,
	// which is what catches a wire-up that reads the wrong path.
	for (const [index, propertyPath] of TRANSFORM_PATHS.entries()) {
		const animated = 7 + index;
		expect(
			resolveTransformAtTime({
				animations: {
					[propertyPath]: makeScalarChannel({
						keys: [makeKey({ time: 0, value: animated })],
					}),
				},
				baseTransform: base,
				localTime: 0,
			}),
		).toEqual({
			position: {
				x: propertyPath === "transform.positionX" ? animated : 0,
				y: propertyPath === "transform.positionY" ? animated : 0,
			},
			scaleX: propertyPath === "transform.scaleX" ? animated : 1,
			scaleY: propertyPath === "transform.scaleY" ? animated : 1,
			rotate: propertyPath === "transform.rotate" ? animated : 0,
		});
	}
});

test("resolveTransformAtTime clamps a negative local time to zero", () => {
	const base: BaseTransform = {
		position: { x: 0, y: 0 },
		scaleX: 1,
		scaleY: 1,
		rotate: 0,
	};
	const animations = {
		"transform.rotate": makeScalarChannel({
			keys: [makeKey({ time: 0, value: 90 }), makeKey({ time: 100, value: 180 })],
		}),
	};

	// Before the first key reads as the first key, not as the base transform.
	expect(
		resolveTransformAtTime({
			animations,
			baseTransform: base,
			localTime: -1000,
		}),
	).toEqual(
		resolveTransformAtTime({ animations, baseTransform: base, localTime: 0 }),
	);
});

test("resolveTransformAtTime matches the five separate reads it replaced", () => {
	// Guards against a vacuous run: if the animations stopped deserialising, both
	// sides would fall back to the base transform and agree on every iteration.
	let animatedAnswers = 0;

	const mismatch = findParityMismatch({
		iterations: 1_500,
		seed: 0x7a17e,
		generate: ({ rng }) => {
			const animations: Record<string, ReturnType<typeof makeScalarChannel>> =
				{};
			for (const propertyPath of TRANSFORM_PATHS) {
				if (rng.bool()) {
					continue;
				}
				const keyCount = rng.int({ min: 1, max: 4 });
				animations[propertyPath] = makeScalarChannel({
					keys: Array.from({ length: keyCount }, (_unused, index) =>
						makeKey({
							time: index * 100,
							value: rng.range({ min: -5, max: 5 }),
						}),
					),
				});
			}

			return {
				baseTransform: {
					position: {
						x: rng.range({ min: -500, max: 500 }),
						y: rng.range({ min: -500, max: 500 }),
					},
					scaleX: rng.range({ min: 0, max: 4 }),
					scaleY: rng.range({ min: 0, max: 4 }),
					rotate: rng.range({ min: 0, max: 360 }),
				} satisfies BaseTransform,
				animations,
				localTime: rng.int({ min: -100, max: 500 }),
			};
		},
		ts: ({ input }) => resolveViaSeparateCalls(input),
		rust: ({ input }) => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const resolved = resolveTransformAtTime(input) as BaseTransform;
			if (resolved.rotate !== input.baseTransform.rotate) {
				animatedAnswers += 1;
			}
			return resolved;
		},
	});

	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
	expect(animatedAnswers).toBeGreaterThan(0);
});
