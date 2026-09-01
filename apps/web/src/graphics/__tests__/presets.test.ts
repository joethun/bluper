import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { SHAPE_PRESETS } = await import("@/graphics/presets");
const { getGraphicDefinition } = await import("@/graphics");

/**
 * A preset names its definition and its overrides as bare strings, and nothing
 * reads either one until a user clicks the tile — so a renamed definition or a
 * retired param would ship as a shape that throws, or as one that silently
 * ignores what made it that shape.
 */
describe("shape presets", () => {
	it("names a registered definition", () => {
		for (const preset of SHAPE_PRESETS) {
			expect(() =>
				getGraphicDefinition({ definitionId: preset.definitionId }),
			).not.toThrow();
		}
	});

	it("overrides only params its definition declares", () => {
		for (const preset of SHAPE_PRESETS) {
			const declared = getGraphicDefinition({
				definitionId: preset.definitionId,
			}).params.map((param) => param.key);

			for (const key of Object.keys(preset.params ?? {})) {
				expect(declared).toContain(key);
			}
		}
	});

	it("gives each tile its own identity", () => {
		const ids = SHAPE_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
