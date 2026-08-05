import { describe, expect, test } from "bun:test";
import { v7ToV8 } from "../v7-to-v8";

function buildState({
	keybindings,
}: {
	keybindings: Record<string, string>;
}) {
	return { keybindings, isCustomized: true };
}

describe("v7ToV8", () => {
	test("gives freeze-frame its default key to bindings saved without it", () => {
		const result = v7ToV8({ state: buildState({ keybindings: { s: "split" } }) });

		expect(result).toEqual(
			buildState({ keybindings: { s: "split", "shift+f": "freeze-frame" } }),
		);
	});

	test("leaves a key the user has already claimed alone", () => {
		const state = buildState({ keybindings: { "shift+f": "split-left" } });

		expect(v7ToV8({ state })).toEqual(state);
	});

	test("does not add a second binding when one already exists", () => {
		const state = buildState({ keybindings: { g: "freeze-frame" } });

		expect(v7ToV8({ state })).toEqual(state);
	});

	test("passes through state it does not recognise", () => {
		expect(v7ToV8({ state: null })).toBeNull();
		expect(v7ToV8({ state: { nope: true } })).toEqual({ nope: true });
	});
});
