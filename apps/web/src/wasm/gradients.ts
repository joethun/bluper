import {
	type GradientAst,
	parseGradientValue as _parseGradientValue,
} from "bluper-wasm";

/**
 * CSS gradient parsing, owned by `editor-core::gradients::parser`. A port of the
 * vendored `gradient-parser`, kept faithful down to which malformed inputs it
 * rejects — the AST is a wire format that `gradients/canvas.ts` switches on.
 */

/**
 * The AST node types `gradients/canvas.ts` names, re-exported so a consumer
 * needs one import rather than two. They come out of `#[export]`'s generated
 * `.d.ts`, not from here — the constituent types the union is built from are
 * reachable there directly, and are not repeated here while nothing imports
 * them.
 */
export type {
	GradientAst,
	GradientColor,
	GradientColorStop,
	GradientOrientation,
} from "bluper-wasm";

/**
 * Parse one or more comma-separated CSS gradient functions.
 *
 * Throws on anything the parser will not accept, which is what the vendored
 * JavaScript did and what the callers are written against. A `Result` cannot
 * cross the wasm boundary, so Rust hands back the message and the throw happens
 * here.
 */
export function parseGradient({ code }: { code: string }): GradientAst[] {
	const result = _parseGradientValue({ code });
	if (result.error !== undefined) {
		throw new Error(result.error);
	}
	return result.gradients;
}
