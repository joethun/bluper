import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import {
	createRng,
	describeParityMismatch,
	findParityMismatch,
} from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const {
	isAnimationPath,
	isEffectParamPath,
	isGraphicParamPath,
	isAnimationPropertyPath,
	isAnimationStorageKey,
	graphicParamPath,
	parseGraphicParamPath,
	effectParamPath,
	parseEffectParamPath,
} = await import("@/wasm/path");

/**
 * Path construction and recognition, owned by `editor-core::animation::path`.
 *
 * The first tests pin specific cases; the parity tests at the bottom run a
 * generated differential against a hand-rolled reference, so a drift in the
 * Rust lands on the Rust side first rather than going out as a behavioural
 * change.
 */

test("isAnimationPropertyPath matches its fixed list", () => {
	for (const path of [
		"transform.scaleX",
		"transform.scaleY",
		"transform.positionX",
		"transform.positionY",
		"transform.rotate",
		"opacity",
		"volume",
		"fontSize",
		"letterSpacing",
		"lineHeight",
		"color",
		"background.color",
		"background.paddingX",
		"background.paddingY",
		"background.offsetX",
		"background.offsetY",
		"background.cornerRadius",
		"adjust.saturation",
		"adjust.temperature",
		"adjust.hue",
		"adjust.brightness",
		"adjust.contrast",
		"adjust.highlight",
		"adjust.shadow",
		"adjust.sharpness",
		"adjust.vignette",
		"adjust.grain",
	]) {
		expect(isAnimationPropertyPath({ propertyPath: path })).toBe(true);
	}
	for (const path of [
		"",
		"transform",
		"effects.foo.params.amount",
		"params.bar",
		"unknown",
	]) {
		expect(isAnimationPropertyPath({ propertyPath: path })).toBe(false);
	}
});

test("isGraphicParamPath recognises the prefix", () => {
	for (const path of ["params.opacity", "params.amount", "params."]) {
		expect(isGraphicParamPath({ propertyPath: path })).toBe(true);
	}
	for (const path of ["", "opacity", "effects.x.params.amount"]) {
		expect(isGraphicParamPath({ propertyPath: path })).toBe(false);
	}
});

test("isEffectParamPath requires both prefix and separator", () => {
	for (const path of [
		"effects.abc.params.amount",
		"effects.x.params.intensity",
	]) {
		expect(isEffectParamPath({ propertyPath: path })).toBe(true);
	}
	for (const path of [
		"",
		"effects.abc.enabled",
		"effects.abc",
		"params.amount",
	]) {
		expect(isEffectParamPath({ propertyPath: path })).toBe(false);
	}
});

test("isAnimationPath is the union of the three forms", () => {
	const YES = [
		"opacity",
		"transform.scaleX",
		"adjust.grain",
		"params.opacity",
		"effects.abc.params.amount",
	];
	for (const path of YES) {
		expect(isAnimationPath({ propertyPath: path })).toBe(true);
	}
	for (const path of [
		"",
		"effects.abc.enabled",
		"unknown",
		"transform",
	]) {
		expect(isAnimationPath({ propertyPath: path })).toBe(false);
	}
});

test("isAnimationStorageKey rejects the legacy keys", () => {
	for (const key of ["bindings", "channels"]) {
		expect(isAnimationStorageKey({ key })).toBe(false);
	}
	for (const key of ["opacity", "transform.scaleX", "params.amount", ""]) {
		expect(isAnimationStorageKey({ key })).toBe(true);
	}
});

test("graphicParamPath and parseGraphicParamPath round-trip", () => {
	expect(graphicParamPath({ paramKey: "opacity" })).toBe("params.opacity");
	expect(graphicParamPath({ paramKey: "amount" })).toBe("params.amount");
	expect(parseGraphicParamPath({ propertyPath: "params.opacity" })).toEqual({
		paramKey: "opacity",
	});
	expect(parseGraphicParamPath({ propertyPath: "params." })).toBeNull();
	expect(parseGraphicParamPath({ propertyPath: "opacity" })).toBeNull();
	expect(parseGraphicParamPath({ propertyPath: "" })).toBeNull();
});

test("effectParamPath and parseEffectParamPath round-trip", () => {
	expect(
		effectParamPath({ effectId: "abc", paramKey: "amount" }),
	).toBe("effects.abc.params.amount");
	expect(
		parseEffectParamPath({ propertyPath: "effects.abc.params.amount" }),
	).toEqual({ effectId: "abc", paramKey: "amount" });
	// The id is everything before the *first* `.params.`, so an id containing
	// that literal would split at the wrong place — ids are generated, so none
	// does.
	expect(
		parseEffectParamPath({ propertyPath: "effects..params.amount" }),
	).toBeNull();
	expect(
		parseEffectParamPath({ propertyPath: "effects.abc.params." }),
	).toBeNull();
	expect(
		parseEffectParamPath({ propertyPath: "params.amount" }),
	).toBeNull();
});

/**
 * Differential parity over generated paths. The reference is a hand-rolled
 * TypeScript implementation that mirrors the algorithm in the Rust tests, so
 * any drift between the two lands on the Rust side first — which is what we
 * want, because the next port would otherwise reinvent the answer.
 */
function referenceRandomPath({
	rng,
}: {
	rng: ReturnType<typeof createRng>;
}): string {
	return [
		rng.pick({
			from: ["transform.scaleX", "opacity", "effects.", "params.", ""],
		}),
		rng.pick({
			from: ["foo", "abc123", "a-b", "x", "very-long", ""],
		}),
		rng.pick({ from: [".params.amount", ".params.", "", ".x", ".params.."] }),
	].join("");
}

test("isAnimationPath parity over generated paths", () => {
	const mismatch = findParityMismatch({
		seed: 0xa11ce,
		iterations: 4_000,
		generate: ({ rng }) => referenceRandomPath({ rng }),
		ts: ({ input }) => {
			if (
				input === "transform.scaleX" ||
				input === "opacity" ||
				input.startsWith("adjust.")
			) {
				return true;
			}
			if (input.startsWith("effects.") && input.includes(".params.")) {
				return true;
			}
			if (input.startsWith("params.")) {
				return true;
			}
			return false;
		},
		rust: ({ input }) => isAnimationPath({ propertyPath: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("isGraphicParamPath parity over generated paths", () => {
	const mismatch = findParityMismatch({
		seed: 0xb20fa,
		iterations: 4_000,
		generate: ({ rng }) => referenceRandomPath({ rng }),
		ts: ({ input }) => input.startsWith("params."),
		rust: ({ input }) => isGraphicParamPath({ propertyPath: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("isEffectParamPath parity over generated paths", () => {
	const mismatch = findParityMismatch({
		seed: 0xeffe7,
		iterations: 4_000,
		generate: ({ rng }) => referenceRandomPath({ rng }),
		ts: ({ input }) =>
			input.startsWith("effects.") && input.includes(".params."),
		rust: ({ input }) => isEffectParamPath({ propertyPath: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("isAnimationStorageKey parity over generated keys", () => {
	const mismatch = findParityMismatch({
		seed: 0x57a4,
		iterations: 4_000,
		generate: ({ rng }) =>
			rng.pick({
				from: ["bindings", "channels", "opacity", "", "transform.scaleX"],
			}),
		ts: ({ input }) => input !== "bindings" && input !== "channels",
		rust: ({ input }) => isAnimationStorageKey({ key: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("graphicParamPath and parseGraphicParamPath parity", () => {
	const mismatch = findParityMismatch({
		seed: 0x90ad1,
		iterations: 4_000,
		generate: ({ rng }) => ({
			build: rng.pick({ from: ["opacity", "amount", "x", "color.r"] }),
			parse: rng.pick({
				from: [
					"params.opacity",
					"params.amount",
					"params.color.r",
					"params.",
					"not-params",
					"",
				],
			}),
		}),
		ts: ({ input }) => {
			const built = `params.${input.build}`;
			const parsed =
				input.parse.startsWith("params.") && input.parse.length > "params.".length
					? input.parse.slice("params.".length)
					: null;
			return { built, parsed };
		},
		rust: ({ input }) => ({
			built: graphicParamPath({ paramKey: input.build }),
			parsed: parseGraphicParamPath({ propertyPath: input.parse })?.paramKey ?? null,
		}),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("effectParamPath and parseEffectParamPath parity", () => {
	const mismatch = findParityMismatch({
		seed: 0xeff02,
		iterations: 4_000,
		generate: ({ rng }) => ({
			effectId: rng.pick({
				from: ["abc", "fx-1", "very-long-effect-id", ""],
			}),
			paramKey: rng.pick({ from: ["amount", "x", "", "radius"] }),
		}),
		ts: ({ input }) => {
			const { effectId, paramKey } = input;
			if (!effectId || !paramKey) return null;
			return `effects.${effectId}.params.${paramKey}`;
		},
		rust: ({ input }) => {
			const { effectId, paramKey } = input;
			if (!effectId || !paramKey) return null;
			return effectParamPath({ effectId, paramKey });
		},
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("parseEffectParamPath parity over generated paths", () => {
	const mismatch = findParityMismatch({
		seed: 0xeff03,
		iterations: 4_000,
		generate: ({ rng }) => referenceRandomPath({ rng }),
		ts: ({ input }) => {
			if (!input.startsWith("effects.") || !input.includes(".params.")) {
				return null;
			}
			const rest = input.slice("effects.".length);
			const idx = rest.indexOf(".params.");
			if (idx <= 0) return null;
			const effectId = rest.slice(0, idx);
			const paramKey = rest.slice(idx + ".params.".length);
			if (!effectId || !paramKey) return null;
			return { effectId, paramKey };
		},
		rust: ({ input }) => parseEffectParamPath({ propertyPath: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});