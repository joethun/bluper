import {
	appendAlphaValue as _appendAlphaValue,
	extractColorFromTextValue as _extractColorFromTextValue,
	formatColorValueString as _formatColorValueString,
	hexToHsvValue as _hexToHsvValue,
	hsvToHexValue as _hsvToHexValue,
	parseColorInputValue as _parseColorInputValue,
	parseHexAlphaValue as _parseHexAlphaValue,
} from "bluper-wasm";

/**
 * The colour picker's conversions, owned by `editor-core::params::picker`.
 *
 * These work in sRGB rather than linear light — a picker manipulates the numbers
 * a user sees, so the hue ring, the saturation square and the hex field have to
 * agree digit for digit. `@/wasm/params` is the linear-light side, for
 * interpolation.
 *
 * Hex strings here carry no leading `#`; that is the form the picker's field
 * holds.
 */

export type ColorFormat = "hex" | "rgb" | "hsl" | "hsv";

export function hexToHsv({ hex }: { hex: string }): [number, number, number] {
	const { h, s, v } = _hexToHsvValue({ hex });
	return [h, s, v];
}

export function hsvToHex({
	h,
	s,
	v,
}: {
	h: number;
	s: number;
	v: number;
}): string {
	return _hsvToHexValue({ h, s, v });
}

export function parseHexAlpha({ hex }: { hex: string }): {
	rgb: string;
	alpha: number;
} {
	return _parseHexAlphaValue({ hex });
}

export function appendAlpha({
	rgbHex,
	alpha,
}: {
	rgbHex: string;
	alpha: number;
}): string {
	return _appendAlphaValue({ rgbHex, alpha });
}

/** A colour out of pasted text, or `null` when there is no colour in it. */
export function extractColorFromText({
	text,
}: {
	text: string;
}): string | null {
	return _extractColorFromTextValue({ text }).hex ?? null;
}

export function formatColorValue({
	hex,
	format,
}: {
	hex: string;
	format: ColorFormat;
}): string {
	return _formatColorValueString({ hex, format });
}

export function parseColorInput({
	input,
	format,
}: {
	input: string;
	format: ColorFormat;
}): string | null {
	return _parseColorInputValue({ input, format }).hex ?? null;
}
