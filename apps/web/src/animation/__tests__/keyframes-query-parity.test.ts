import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { describeParityMismatch, findParityMismatch } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const { hasKeyframesForPath, getElementLocalTime } = await import(
	"@/wasm/animation"
);
const { getKeyframeAtTime, getKeyframeById } = await import(
	"@/animation/keyframe-query"
);

/**
 * Two of the queries over an element's animation channels and timeline time,
 * owned by `editor-core::animation::keyframes_query`.
 *
 * The TS-side originals lived in `apps/web/src/animation/{keyframe-query,resolve}.ts`
 * and were deleted alongside this port; these tests pin the values they
 * produced.
 */

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

function makeCompositeChannel({
	components,
}: {
	components: Record<string, ReturnType<typeof makeScalarChannel>>;
}) {
	return components;
}

test("hasKeyframesForPath pins every shape", () => {
	expect(
		hasKeyframesForPath({ animations: undefined, propertyPath: "opacity" }),
	).toBe(false);
	expect(
		hasKeyframesForPath({
			animations: {
				opacity: makeScalarChannel({ keys: [] }),
			},
			propertyPath: "opacity",
		}),
	).toBe(false);
	expect(
		hasKeyframesForPath({
			animations: {
				opacity: makeScalarChannel({
					keys: [makeKey({ time: 0, value: 1 })],
				}),
			},
			propertyPath: "opacity",
		}),
	).toBe(true);
	// A composite with one populated component is keyframed.
	expect(
		hasKeyframesForPath({
			animations: {
				"background.color": makeCompositeChannel({
					components: {
						r: makeScalarChannel({
							keys: [makeKey({ time: 0, value: 0.5 })],
						}),
						g: makeScalarChannel({ keys: [] }),
						b: makeScalarChannel({ keys: [] }),
						a: makeScalarChannel({ keys: [] }),
					},
				}),
			},
			propertyPath: "background.color",
		}),
	).toBe(true);
	// A composite with no populated components is not.
	expect(
		hasKeyframesForPath({
			animations: {
				"background.color": makeCompositeChannel({
					components: {
						r: makeScalarChannel({ keys: [] }),
						g: makeScalarChannel({ keys: [] }),
						b: makeScalarChannel({ keys: [] }),
						a: makeScalarChannel({ keys: [] }),
					},
				}),
			},
			propertyPath: "background.color",
		}),
	).toBe(false);
	// A path that is not in the map is not keyframed.
	expect(
		hasKeyframesForPath({
			animations: {
				opacity: makeScalarChannel({
					keys: [makeKey({ time: 0, value: 1 })],
				}),
			},
			propertyPath: "transform.rotate",
		}),
	).toBe(false);
});

test("hasKeyframesForPath parity over generated channels", () => {
	const rng = (() => {
		let state = 0xc0ffee >>> 0;
		const next = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		return {
			next,
			int: ({ min, max }: { min: number; max: number }) =>
				min + Math.floor(next() * (max - min + 1)),
			pick: <T>({ from }: { from: T[] }) =>
				from[Math.floor(next() * from.length)] as T,
		};
	})();
	const PATHS = ["opacity", "transform.scaleX", "volume", "background.color"];

	const generate = () => {
		const componentCount = rng.int({ min: 0, max: 4 });
		const components: Record<string, ReturnType<typeof makeScalarChannel>> = {};
		const COMPONENT_NAMES = ["r", "g", "b", "a"];
		for (let i = 0; i < componentCount; i += 1) {
			const key = COMPONENT_NAMES[i] ?? "x";
			const keyCount = rng.int({ min: 0, max: 3 });
			components[key] = makeScalarChannel({
				keys: Array.from({ length: keyCount }, (_, j) =>
					makeKey({ time: j * 100, value: rng.next() }),
				),
			});
		}
		return {
			propertyPath: rng.pick({ from: PATHS }),
			shape: rng.pick({ from: ["leaf", "composite", "missing"] }) as
				| "leaf"
				| "composite"
				| "missing",
			components,
		};
	};

	const tsReference = ({
		input,
	}: {
		input: ReturnType<typeof generate>;
	}): boolean => {
		if (input.shape === "missing") return false;
		return Object.values(input.components).some(
			(c) => (c.keys as unknown[]).length > 0,
		);
	};

	const mismatch = findParityMismatch({
		seed: 0x1a1ce,
		iterations: 1_500,
		generate,
		ts: tsReference,
		rust: ({ input }) =>
			hasKeyframesForPath({
				animations:
					input.shape === "missing"
						? undefined
						: input.shape === "leaf"
							? {
									[input.propertyPath]: makeScalarChannel({
										keys: Object.values(input.components).flatMap(
											(c) => c.keys,
										),
									}),
								}
							: {
									[input.propertyPath]: makeCompositeChannel({
										components: input.components,
									}),
								},
				propertyPath: input.propertyPath,
			}),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("getElementLocalTime pins the edges", () => {
	// Before the clip's start: clamped to 0.
	expect(
		getElementLocalTime({
			timelineTime: -100,
			elementStartTime: 0,
			elementDuration: 1000,
		}),
	).toBe(0);
	// At the clip's start: 0.
	expect(
		getElementLocalTime({
			timelineTime: 1000,
			elementStartTime: 1000,
			elementDuration: 2000,
		}),
	).toBe(0);
	// Inside the clip: passes through.
	expect(
		getElementLocalTime({
			timelineTime: 1500,
			elementStartTime: 1000,
			elementDuration: 2000,
		}),
	).toBe(500);
	// Past the clip's end: clamped to duration.
	expect(
		getElementLocalTime({
			timelineTime: 5000,
			elementStartTime: 1000,
			elementDuration: 2000,
		}),
	).toBe(2000);
});

test("getElementLocalTime parity over generated times", () => {
	const rng = (() => {
		let state = 0x10ca1e >>> 0;
		const next = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		return {
			next,
			int: ({ min, max }: { min: number; max: number }) =>
				min + Math.floor(next() * (max - min + 1)),
		};
	})();

	const mismatch = findParityMismatch({
		seed: 0x10ca1e,
		iterations: 4_000,
		generate: () => {
			const duration = rng.int({ min: 0, max: 10_000 });
			const startTime = rng.int({ min: -500, max: 1_500 });
			const timelineTime = rng.int({ min: -2_000, max: 3_000 });
			return { duration, startTime, timelineTime };
		},
		ts: ({ input }) => {
			const local = input.timelineTime - input.startTime;
			if (local <= 0) return 0;
			if (local >= input.duration) return input.duration;
			return local;
		},
		rust: ({ input }) =>
			getElementLocalTime({
				timelineTime: input.timelineTime,
				elementStartTime: input.startTime,
				elementDuration: input.duration,
			}),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});
/**
 * A Rust `Option::None` arrives from wasm as `undefined`, and the wrapper's
 * declared return type is `| null`. Callers that spell the absent case as
 * `=== null` / `!== null` — the properties panel's keyframe diamond does —
 * read `undefined` as a hit, which is why this pins the exact value rather
 * than just its falsiness.
 */
test("the keyframe lookups return null, not undefined, when there is no hit", () => {
	const animations = {
		opacity: makeScalarChannel({ keys: [makeKey({ time: 12, value: 1 })] }),
	};

	expect(
		getKeyframeAtTime({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			animations: animations as never,
			propertyPath: "opacity",
			time: 5,
		}),
	).toBeNull();
	expect(
		getKeyframeAtTime({
			animations: undefined,
			propertyPath: "opacity",
			time: 0,
		}),
	).toBeNull();
	expect(
		getKeyframeById({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			animations: animations as never,
			propertyPath: "opacity",
			keyframeId: "nope",
		}),
	).toBeNull();

	// The present case still comes back, so the normalisation is not swallowing
	// hits along with misses.
	expect(
		getKeyframeAtTime({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			animations: animations as never,
			propertyPath: "opacity",
			time: 12,
		})?.id,
	).toBe("k12");
});
