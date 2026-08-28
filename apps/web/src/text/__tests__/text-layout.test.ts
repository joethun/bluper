import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

// Imported after the mock, not statically at the top: a top-level `import` is
// hoisted above `mock.module` and would load the bundler-target package, which
// `bun test` cannot initialise.
const {
	FONT_SIZE_SCALE_REFERENCE,
	TEXT_CORNER_RADIUS_MAX,
	TEXT_CORNER_RADIUS_MIN,
	resolveTextLayout,
	textBackgroundCornerRadius,
} = await import("@/wasm/text-layout");

/**
 * Resolving a text element's declared style into the numbers a renderer draws
 * with, owned by `editor-core::text::layout`.
 *
 * The resolution half of `apps/web/src/text/primitives.ts` was deleted at the
 * switchover; measurement stayed behind, because it needs a live canvas. These
 * pin what the two implementations were proven identical on over 4,000
 * generated styles while both existed.
 */

test("the scale reference and clamp bounds are the ones the drawing code assumes", () => {
	expect(FONT_SIZE_SCALE_REFERENCE).toBe(90);
	expect(TEXT_CORNER_RADIUS_MIN).toBe(0);
	expect(TEXT_CORNER_RADIUS_MAX).toBe(100);
});

test("a style resolves to the font shorthand and the derived pixel sizes", () => {
	// Font size is declared against a 90px-tall canvas, so a 1080px canvas
	// scales it 12x. `lineHeightPx` is the scaled size times the line height,
	// and `fontSizeRatio` is against the 15px design baseline.
	expect(
		resolveTextLayout({
			text: {
				fontSize: 30,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "italic",
				textAlign: "center",
			},
			canvasHeight: 1080,
		}),
	).toEqual({
		scaledFontSize: 360,
		fontString: 'italic bold 360px "Inter", sans-serif',
		letterSpacing: 0,
		lineHeightPx: 432,
		fontSizeRatio: 2,
		textAlign: "center",
		textDecoration: "none",
	});
});

test("supplied optionals win over the defaults, and a spaced family is quoted", () => {
	expect(
		resolveTextLayout({
			text: {
				fontSize: 15,
				fontFamily: "Times New Roman",
				fontWeight: "normal",
				fontStyle: "normal",
				textAlign: "left",
				textDecoration: "underline",
				letterSpacing: 2.5,
				lineHeight: 1.75,
			},
			canvasHeight: 90,
		}),
	).toEqual({
		scaledFontSize: 15,
		fontString: 'normal normal 15px "Times New Roman", sans-serif',
		letterSpacing: 2.5,
		lineHeightPx: 26.25,
		fontSizeRatio: 1,
		textAlign: "left",
		textDecoration: "underline",
	});
});

test("the font size reaches the shorthand with JavaScript's digits, not Rust's", () => {
	// This is the case the port needed a hand-written number formatter for.
	// Rust's `Display` for f64 agrees here but diverges elsewhere — it never
	// switches to exponential and prints `-0` where JS prints `0` — and either
	// would emit a `font` shorthand the canvas silently fails to parse.
	const resolved = resolveTextLayout({
		text: {
			fontSize: 0.1 + 0.2,
			fontFamily: "A B",
			fontWeight: "normal",
			fontStyle: "normal",
			textAlign: "right",
		},
		canvasHeight: FONT_SIZE_SCALE_REFERENCE,
	});
	expect(resolved.scaledFontSize).toBe(0.30000000000000004);
	expect(resolved.fontString).toBe(
		'normal normal 0.30000000000000004px "A B", sans-serif',
	);
});

test("the background corner radius is clamped, then scaled to the smaller side", () => {
	// The radius is a percentage of half the shorter side, so 100 on a
	// 100 x 80 box is 40 — a fully rounded end cap, not a 100px radius.
	expect(
		textBackgroundCornerRadius({ cornerRadius: 25, width: 100, height: 80 }),
	).toBe(10);
	expect(
		textBackgroundCornerRadius({ cornerRadius: -50, width: 100, height: 80 }),
	).toBe(0);
	expect(
		textBackgroundCornerRadius({ cornerRadius: 500, width: 100, height: 80 }),
	).toBe(40);
});
