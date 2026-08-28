import { expect, test } from "bun:test";
import * as wasm from "bluper-wasm-native";
import { parseColorToLinearRgba } from "@/params";
import { formatLinearRgba } from "@/wasm/params";
import {
	createRng,
	describeParityMismatch,
	equalsRelative,
	findParityMismatch,
} from "@/testing/parity";

/**
 * The Rust colour parser replaces `culori` for the formats this editor produces
 * and accepts. Compared here rather than assumed, because a colour that parses
 * to *almost* the right value is invisible until someone keyframes it.
 *
 * A relative tolerance: both sides run the same sRGB transfer function, but
 * `powf` is a transcendental and V8's is not bit-identical to libm's.
 */
const TOLERANCE = 1e-12;

/** Every format that appears in the codebase or that a user can type. */
const FORMATS = [
	"#000000",
	"#ffffff",
	"#00d21e",
	"#C0C0C0",
	"#fff",
	"#f00",
	"#ff000080",
	"#0000",
	"rgba(255,255,255,1)",
	"rgba(255,255,255,0)",
	"rgb(64, 64, 64)",
	"rgb(240, 0, 0)",
	"rgb(255, 0, 0)",
	"rgb(0, 0, 255)",
	"hsl(0, 100%, 50%)",
	"hsl(120, 100%, 50%)",
	"hsla(240, 50%, 25%, 0.5)",
	"red",
	"rebeccapurple",
	"grey",
	"transparent",
];

test("every format the editor uses parses to the same colour", () => {
	for (const color of FORMATS) {
		const ts = parseColorToLinearRgba({ color });
		const rust = wasm.parseColorToLinearRgbaValue({ color }).color ?? null;
		expect(rust).not.toBeNull();
		for (const channel of ["r", "g", "b", "a"] as const) {
			expect(rust?.[channel]).toBeCloseTo(ts?.[channel] ?? -1, 12);
		}
	}
});

test("what culori refuses, Rust refuses too", () => {
	for (const color of [
		"hsl(var(--background))",
		"",
		"not-a-colour",
		"#12345",
	]) {
		expect(parseColorToLinearRgba({ color })).toBeNull();
		expect(
			wasm.parseColorToLinearRgbaValue({ color }).color ?? null,
		).toBeNull();
	}
});

test("formatting agrees exactly, since it produces a string", () => {
	const mismatch = findParityMismatch({
		iterations: 3_000,
		generate: ({ rng }) => ({
			r: rng.float(),
			g: rng.float(),
			b: rng.float(),
			a: rng.pick({ from: [0, 1, rng.float()] }),
		}),
		ts: ({ input }) => formatLinearRgba({ color: input }),
		rust: ({ input }) => wasm.formatLinearRgbaValue({ color: input }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("a colour survives a round trip through both implementations alike", () => {
	const rng = createRng({ seed: 4 });
	const mismatch = findParityMismatch({
		iterations: 2_000,
		seed: 11,
		generate: () => {
			const byte = () => rng.int({ min: 0, max: 255 });
			return `#${[byte(), byte(), byte()]
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("")}`;
		},
		ts: ({ input }) => {
			const parsed = parseColorToLinearRgba({ color: input });
			return parsed ? formatLinearRgba({ color: parsed }) : null;
		},
		rust: ({ input }) => {
			const parsed = wasm.parseColorToLinearRgbaValue({ color: input }).color;
			return parsed ? wasm.formatLinearRgbaValue({ color: parsed }) : null;
		},
		equals: equalsRelative({ epsilon: TOLERANCE }),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});
