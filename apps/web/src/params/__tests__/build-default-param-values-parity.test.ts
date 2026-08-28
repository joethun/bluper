import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { ParamDefinition, ParamValues } from "@/params";
import {
	describeParityMismatch,
	findParityMismatch,
} from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const { buildDefaultParamValues } = await import("@/wasm/params");

/**
 * The `{ key: default }` bag a freshly created element starts with, now owned
 * by `editor-core::params::registry`.
 *
 * The Rust side is the same algorithm as the deleted TypeScript, so the
 * generator at the bottom checks every shape `ParamDefinition.default` can
 * take: numbers, booleans, and the four string-typed forms (color, select,
 * text, font). A drift in either direction would surface as a key/value
 * disagreement on one of the generated cases.
 */
function referenceBuildDefaultParamValues({
	params,
}: {
	params: readonly ParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

test("empty params yields an empty bag", () => {
	expect(buildDefaultParamValues({ params: [] })).toEqual({});
	expect(buildDefaultParamValues({ params: [] })).toEqual(
		referenceBuildDefaultParamValues({ params: [] }),
	);
});

test("a single param of each default type round-trips", () => {
	const number: ParamDefinition = {
		type: "number",
		key: "opacity",
		label: "Opacity",
		default: 1,
		min: 0,
		max: 1,
		step: 0.01,
	};
	const boolean: ParamDefinition = {
		type: "boolean",
		key: "muted",
		label: "Muted",
		default: false,
	};
	const color: ParamDefinition = {
		type: "color",
		key: "color",
		label: "Color",
		default: "#ff8800",
	};
	const select: ParamDefinition = {
		type: "select",
		key: "blendMode",
		label: "Blend",
		default: "normal",
		options: [{ value: "normal", label: "Normal" }],
	};
	const text: ParamDefinition = {
		type: "text",
		key: "content",
		label: "Content",
		default: "Hello",
	};
	const font: ParamDefinition = {
		type: "font",
		key: "fontFamily",
		label: "Font",
		default: "Arial",
	};

	for (const param of [number, boolean, color, select, text, font]) {
		const result = buildDefaultParamValues({ params: [param] });
		expect(result).toEqual({ [param.key]: param.default });
		expect(result).toEqual(referenceBuildDefaultParamValues({ params: [param] }));
	}
});

test("a generated mix of types matches the reference exactly", () => {
	const types = ["number", "boolean", "color", "select", "text", "font"] as const;
	const mismatch = findParityMismatch({
		seed: 0xd3f4,
		iterations: 20,
		generate: ({ rng }) => {
			const count = 20;
			const params: ParamDefinition[] = [];
			for (let index = 0; index < count; index += 1) {
				const type = rng.pick({ from: types });
				const key = `p.${index}`;
				if (type === "number") {
					params.push({
						type: "number",
						key,
						label: key,
						default: rng.range({ min: -10, max: 10 }),
						min: -10,
						max: 10,
						step: 0.01,
					});
				} else if (type === "boolean") {
					params.push({
						type: "boolean",
						key,
						label: key,
						default: rng.bool(),
					});
				} else {
					const defaultValue = `s-${rng.int({ min: 0, max: 999 })}`;
					if (type === "color") {
						params.push({ type: "color", key, label: key, default: defaultValue });
					} else if (type === "select") {
						params.push({
							type: "select",
							key,
							label: key,
							default: defaultValue,
							options: [{ value: defaultValue, label: defaultValue }],
						});
					} else if (type === "text") {
						params.push({ type: "text", key, label: key, default: defaultValue });
					} else {
						params.push({ type: "font", key, label: key, default: defaultValue });
					}
				}
			}
			return { params };
		},
		ts: ({ input }) => referenceBuildDefaultParamValues(input),
		rust: ({ input }) => buildDefaultParamValues(input),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});
