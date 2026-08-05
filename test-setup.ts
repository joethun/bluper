import { readFileSync } from "node:fs";
import { mock } from "bun:test";
import * as bindings from "opencut-wasm/opencut_wasm_bg.js";

/**
 * `opencut-wasm` is built with wasm-pack's `bundler` target, whose entry does
 * `import * as wasm from "./opencut_wasm_bg.wasm"` and expects the bundler to
 * hand back the instance exports. Bun's `.wasm` import returns `{ default }`
 * instead, so the entry throws on `__wbindgen_start` and every test that
 * touches `MediaTime` dies at import time.
 *
 * Instantiating the module ourselves and standing it in for the package gives
 * the tests the real Rust implementation — the same arithmetic the app runs,
 * not a stub that could drift from it.
 */
const wasmPath = import.meta
	.resolveSync("opencut-wasm/opencut_wasm_bg.wasm")
	.replace(/^file:\/\//, "");

const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {
	"./opencut_wasm_bg.js": bindings,
});

const exports = instance.exports as Record<string, unknown> & {
	__wbindgen_start?: () => void;
};
(bindings as unknown as { __wbg_set_wasm: (value: unknown) => void }).__wbg_set_wasm(
	exports,
);
exports.__wbindgen_start?.();

mock.module("opencut-wasm", () => bindings);
