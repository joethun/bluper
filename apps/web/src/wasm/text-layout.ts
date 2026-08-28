import {
	resolveTextLayoutValue as _resolveTextLayoutValue,
	textBackgroundCornerRadiusValue as _textBackgroundCornerRadiusValue,
} from "bluper-wasm";

/**
 * Resolving a text element's declared style into the numbers a renderer draws
 * with — canvas-scaled font size, the CSS `font` shorthand, line height in
 * pixels, the padding ratio. Owned by `editor-core::text::layout`.
 *
 * Measurement deliberately stays in TypeScript. `measureTextLayout` in
 * `@/text/primitives` needs a live `CanvasRenderingContext2D` to shape glyphs,
 * and a measurement callback is behaviour-as-data that cannot serialise — the
 * same thing that keeps `ParamChannelLayout` on this side. It calls into here
 * for the arithmetic and keeps the canvas work local.
 *
 * The declared `content` is not part of the payload: resolution never reads it,
 * and a caption changes on every keystroke, so sending it would be the whole
 * string across the boundary for nothing.
 *
 * The four style enums below are narrower than what a stored project may hold —
 * an older file can carry `fontWeight: "600"` — and Rust *rejects* a value
 * outside the union rather than coercing it, which the TypeScript did silently.
 * That is safe only because every caller reaches this through
 * `buildTextLayoutParamsFromElement`, which already runs each field through a
 * `value: unknown` guard (`readFontWeight` and friends in
 * `@/text/measure-element`) and substitutes the default. A new caller that
 * passes `element.params` straight in would throw where the old code drew
 * something; go through the builder.
 */

export type TextAlign = "left" | "center" | "right";
export type TextFontWeight = "normal" | "bold";
export type TextFontStyle = "normal" | "italic";
export type TextDecoration = "none" | "underline" | "line-through";

export interface TextLayoutParams {
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
}

export interface TextResolvedLayout {
	scaledFontSize: number;
	fontString: string;
	letterSpacing: number;
	lineHeightPx: number;
	fontSizeRatio: number;
	textAlign: TextAlign;
	textDecoration: TextDecoration;
}

/**
 * Canvas height a declared font size is authored against. Mirrors
 * `FONT_SIZE_SCALE_REFERENCE` in the Rust module, which is the source of truth;
 * repeated here rather than read through the generated getter so importing this
 * module does not call into wasm.
 */
export const FONT_SIZE_SCALE_REFERENCE = 90;

/** Corner radius is a percentage, so it has percentage bounds. */
export const TEXT_CORNER_RADIUS_MIN = 0;
export const TEXT_CORNER_RADIUS_MAX = 100;

export function resolveTextLayout({
	text,
	canvasHeight,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
}): TextResolvedLayout {
	return _resolveTextLayoutValue({ text, canvasHeight });
}

/**
 * Pixel corner radius for a background box, from the percentage the project
 * stores. Taken of half the shorter side, so 100 is a pill and out-of-range
 * values from an older build clamp instead of overflowing.
 */
export function textBackgroundCornerRadius({
	cornerRadius,
	width,
	height,
}: {
	cornerRadius: number;
	width: number;
	height: number;
}): number {
	return _textBackgroundCornerRadiusValue({ cornerRadius, width, height });
}
