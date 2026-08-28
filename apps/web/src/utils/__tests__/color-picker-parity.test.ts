import { converter, formatHex, formatHex8, parse } from "culori";
import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const {
	appendAlpha,
	extractColorFromText,
	formatColorValue,
	hexToHsv,
	hsvToHex,
	parseColorInput,
	parseHexAlpha,
} = await import("@/wasm/color");
type ColorFormat = import("@/wasm/color").ColorFormat;

import { createRng } from "@/testing/parity";

/**
 * The colour picker's conversions moved to Rust; culori is what they used to be.
 * This compares the two on the inputs a picker actually produces — a dragged
 * hue, a typed field, a pasted declaration — and is the reason culori could be
 * dropped from the bundle.
 */

const toHsv = converter("hsv");
const toHsl = converter("hsl");
const toRgb = converter("rgb");

function culoriHexToHsv({ hex }: { hex: string }): [number, number, number] {
	const color = toHsv(`#${hex}`);
	if (!color) return [0, 0, 0];
	return [color.h ?? 0, color.s ?? 0, color.v ?? 0];
}

function culoriHsvToHex({
	h,
	s,
	v,
}: {
	h: number;
	s: number;
	v: number;
}): string {
	return formatHex({ mode: "hsv", h, s, v }).slice(1);
}

function culoriParseHexAlpha({ hex }: { hex: string }): {
	rgb: string;
	alpha: number;
} {
	const color = parse(`#${hex}`);
	return {
		rgb: color ? formatHex(color).slice(1) : hex.slice(0, 6).toLowerCase(),
		alpha: color?.alpha ?? 1,
	};
}

function culoriAppendAlpha({
	rgbHex,
	alpha,
}: {
	rgbHex: string;
	alpha: number;
}): string {
	if (alpha >= 1) return rgbHex;
	return rgbHex + formatHex8({ mode: "rgb", r: 0, g: 0, b: 0, alpha }).slice(7, 9);
}

function culoriFormatColorValue({
	hex,
	format,
}: {
	hex: string;
	format: ColorFormat;
}): string {
	switch (format) {
		case "hex":
			return hex;
		case "rgb": {
			const color = toRgb(`#${hex}`);
			if (!color) return hex;
			return `${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}`;
		}
		case "hsl": {
			const color = toHsl(`#${hex}`);
			if (!color) return hex;
			return `${Math.round(color.h ?? 0)}, ${Math.round((color.s ?? 0) * 100)}%, ${Math.round((color.l ?? 0) * 100)}%`;
		}
		case "hsv": {
			const color = toHsv(`#${hex}`);
			if (!color) return hex;
			return `${Math.round(color.h ?? 0)}, ${Math.round((color.s ?? 0) * 100)}%, ${Math.round((color.v ?? 0) * 100)}%`;
		}
	}
}

function culoriParseColorInput({
	input,
	format,
}: {
	input: string;
	format: ColorFormat;
}): string | null {
	switch (format) {
		case "hex": {
			const cleaned = input.replace("#", "");
			return /^[0-9a-fA-F]{3,8}$/.test(cleaned) ? cleaned : null;
		}
		case "rgb": {
			const parts = input.split(",").map((part) => parseInt(part.trim(), 10));
			if (parts.length < 3 || parts.some(Number.isNaN)) return null;
			return formatHex({
				mode: "rgb",
				r: parts[0] / 255,
				g: parts[1] / 255,
				b: parts[2] / 255,
			}).slice(1);
		}
		case "hsl": {
			const parts = input.split(",").map((part) => parseFloat(part.trim()));
			if (parts.length < 3 || parts.some(Number.isNaN)) return null;
			return formatHex({
				mode: "hsl",
				h: parts[0],
				s: parts[1] / 100,
				l: parts[2] / 100,
			}).slice(1);
		}
		case "hsv": {
			const parts = input.split(",").map((part) => parseFloat(part.trim()));
			if (parts.length < 3 || parts.some(Number.isNaN)) return null;
			return formatHex({
				mode: "hsv",
				h: parts[0],
				s: parts[1] / 100,
				v: parts[2] / 100,
			}).slice(1);
		}
	}
}

const FORMATS: ColorFormat[] = ["hex", "rgb", "hsl", "hsv"];

function randomHexes({ count }: { count: number }): string[] {
	const rng = createRng({ seed: 0x5eed });
	const hexes: string[] = [];
	const byte = (): string =>
		rng.int({ min: 0, max: 255 }).toString(16).padStart(2, "0");
	for (let index = 0; index < count; index += 1) {
		hexes.push(`${byte()}${byte()}${byte()}`);
	}
	return hexes;
}

describe("colour picker parity with culori", () => {
	const hexes = [
		...randomHexes({ count: 200 }),
		"000000",
		"ffffff",
		"808080",
		"ff0000",
		"00ff00",
		"0000ff",
		"010203",
		"fefefe",
	];

	it("reads the same hue, saturation and value out of a hex", () => {
		for (const hex of hexes) {
			expect(hexToHsv({ hex })).toEqual(culoriHexToHsv({ hex }));
		}
	});

	it("writes the same hex back from a dragged hue and square", () => {
		const rng = createRng({ seed: 0xc010 });
		for (let index = 0; index < 500; index += 1) {
			const h = rng.range({ min: 0, max: 360 });
			const s = rng.float();
			const v = rng.float();
			expect(hsvToHex({ h, s, v })).toBe(culoriHsvToHex({ h, s, v }));
		}
	});

	it("round-trips a hue past either end of the ring", () => {
		for (const h of [-720, -361, -360, -0.5, 0, 359.9, 360, 361, 1080]) {
			expect(hsvToHex({ h, s: 0.6, v: 0.7 })).toBe(
				culoriHsvToHex({ h, s: 0.6, v: 0.7 }),
			);
		}
	});

	it("splits alpha off a hex of every length, and off a half-typed one", () => {
		const cases = [
			"c93",
			"c931",
			"336699",
			"33669980",
			"ff000000",
			"",
			"f",
			"ff",
			"fffff",
			"ff00zz",
			"NOTAHEX",
			"AABBCC",
		];
		for (const hex of cases) {
			expect(parseHexAlpha({ hex })).toEqual(culoriParseHexAlpha({ hex }));
		}
	});

	it("appends the same alpha pair", () => {
		for (const alpha of [0, 0.004, 0.25, 0.5, 0.501, 0.999, 1, 1.5, -1]) {
			expect(appendAlpha({ rgbHex: "336699", alpha })).toBe(
				culoriAppendAlpha({ rgbHex: "336699", alpha }),
			);
		}
	});

	it("formats a hex into every field the picker offers", () => {
		for (const hex of hexes) {
			for (const format of FORMATS) {
				expect(formatColorValue({ hex, format })).toBe(
					culoriFormatColorValue({ hex, format }),
				);
			}
		}
	});

	it("refuses a field it cannot read, the same way", () => {
		for (const hex of ["", "zzz", "12345", "#336699"]) {
			for (const format of FORMATS) {
				expect(formatColorValue({ hex, format })).toBe(
					culoriFormatColorValue({ hex, format }),
				);
			}
		}
	});

	it("parses what the user types back into a hex", () => {
		const inputs = [
			"#336699",
			"336699",
			"c93",
			"nope",
			"12345",
			"255, 136, 0",
			"255,136,0",
			" 255 , 136 , 0 ",
			"255, 136",
			"a, b, c",
			"255, 136, 0, 99",
			"300, 400, 500",
			"-10, -10, -10",
			"210, 50%, 40%",
			"210.5, 50.25, 40.75",
			"12px, 34px, 56px",
			"1.5e2, 50, 50",
		];
		for (const input of inputs) {
			for (const format of FORMATS) {
				expect(parseColorInput({ input, format })).toBe(
					culoriParseColorInput({ input, format }),
				);
			}
		}
	});
});

describe("reading a colour out of pasted text", () => {
	/**
	 * culori parses colour spaces this editor never writes — `oklch()`, `lab()`.
	 * The Rust parser covers what the editor produces and accepts, so these cases
	 * are checked against the values themselves rather than against culori.
	 */
	it("takes the value out of a copied declaration", () => {
		expect(
			extractColorFromText({ text: "  background-color: #ff8800 !important; " }),
		).toBe("ff8800");
		expect(extractColorFromText({ text: "color:red" })).toBe("ff0000");
		expect(extractColorFromText({ text: "--brand: #336699;;  " })).toBe("336699");
	});

	it("keeps a function's own parentheses", () => {
		expect(extractColorFromText({ text: "rgb(255, 136, 0)" })).toBe("ff8800");
		expect(extractColorFromText({ text: "hsl(210, 50%, 40%)" })).toBe("336699");
		expect(extractColorFromText({ text: "rgba(255, 0, 0, 0.5)" })).toBe("ff000080");
	});

	it("accepts a hex without its hash", () => {
		expect(extractColorFromText({ text: "ff8800" })).toBe("ff8800");
		expect(extractColorFromText({ text: "c93" })).toBe("cc9933");
	});

	it("finds a hex buried in a sentence", () => {
		expect(extractColorFromText({ text: "the border is #ff8800 today" })).toBe(
			"ff8800",
		);
	});

	it("refuses what is not a colour", () => {
		expect(extractColorFromText({ text: "" })).toBeNull();
		expect(extractColorFromText({ text: "hsl(var(--background))" })).toBeNull();
		expect(extractColorFromText({ text: "#abcz" })).toBeNull();
		expect(extractColorFromText({ text: "#abcde" })).toBeNull();
	});
});
