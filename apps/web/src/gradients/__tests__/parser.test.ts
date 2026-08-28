import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { createRng, type Rng } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const { parseGradient: parseGradientRust } = await import("@/wasm/gradients");

/**
 * CSS gradient parsing, owned by `editor-core::gradients::parser`.
 *
 * The AST is a wire format — `gradients/canvas.ts` switches on every tag in it —
 * so the comparison is exact and structural, including which keys exist. A node
 * whose `style` is `undefined` and one with no `style` key at all are different
 * objects to `equalsExact`, and the port has to reproduce whichever the vendored
 * JavaScript produced. The extent-keyword node is the one that omits a key.
 *
 * Rejections count as agreement only when both sides reject: `findParityMismatch`
 * treats one throw against one success as a mismatch, which is what keeps a
 * port that quietly accepts malformed CSS from passing.
 */

const VENDOR_PREFIXES = ["", "", "", "-webkit-", "-o-", "-ms-", "-moz-"];

const GRADIENT_NAMES = [
	"linear-gradient",
	"repeating-linear-gradient",
	"radial-gradient",
	"repeating-radial-gradient",
];

/** The extent keywords, plus one miscased one — this is the only token in the
 * table without an `i` flag, so the wrong case has to route somewhere else. */
const EXTENT_KEYWORDS = [
	"closest-side",
	"closest-side",
	"closest-corner",
	"closest-corner",
	"farthest-side",
	"farthest-corner",
	"contain",
	"cover",
	"cover",
	"COVER",
];

const POSITION_KEYWORDS = [
	"left",
	"center",
	"right",
	"top",
	"bottom",
	"LEFT",
	"Center",
];

const SIDES_AND_CORNERS = [
	"to left",
	"to right",
	"to top",
	"to bottom",
	"to left top",
	"to left bottom",
	"to right top",
	"to right bottom",
	"to top left",
	"to top right",
	"to bottom left",
	"to bottom right",
	"TO RIGHT",
	// Malformed on purpose: the alternation wants exactly one space, and has no
	// `middle`.
	"to  left",
	"to middle",
];

const LITERAL_COLORS = [
	"red",
	"blue",
	"green",
	"white",
	"black",
	"transparent",
	"rebeccapurple",
	"notacolour",
];

const HEX_DIGITS = [
	"fff",
	"ffff",
	"ffffff",
	"A0B1C2",
	"f",
	"abcdef12",
	"0f0f",
	"123456",
	"789abc",
	// Neither of these is a hex colour, and neither falls back to a literal.
	"xyz",
	"",
];

const VARIABLE_NAMES = [
	"--brand",
	"--brand, #fff",
	"--a-b-c",
	"--Surface-2",
	"--muted",
	"--accent-9",
	// Rejections: no leading dashes, and no name after them.
	"brand",
	"--",
];

const SPACERS = ["", " ", "  ", "\n", "\t", " \n "];

function gap({ rng }: { rng: Rng }): string {
	return rng.pick({ from: SPACERS });
}

/** Every shape the number token can take, including the ones that only parse
 * because the engine backtracks: a trailing dot, and a leading one. */
function numberText({ rng }: { rng: Rng }): string {
	const whole = rng.int({ min: 0, max: 360 });
	const fraction = rng.int({ min: 0, max: 999 });
	switch (rng.int({ min: 0, max: 6 })) {
		case 0:
			return `${whole}`;
		case 1:
			return `${whole}.${fraction}`;
		case 2:
			return `${whole}.`;
		case 3:
			return `.${fraction}`;
		case 4:
			return `-${whole}`;
		case 5:
			return `-${whole}.${fraction}`;
		default:
			return `-.${fraction}`;
	}
}

/**
 * The bare number token carries no sign, unlike every unit-suffixed one, so a
 * hue or an `rgb()` component is unsigned and `rgb(-1, 0, 0)` is a rejection.
 * Signed components are generated deliberately, from the malformed branch of
 * {@link colorText}, rather than by accident here.
 */
function unsignedNumberText({ rng }: { rng: Rng }): string {
	const whole = rng.int({ min: 0, max: 360 });
	const fraction = rng.int({ min: 0, max: 999 });
	switch (rng.int({ min: 0, max: 3 })) {
		case 0:
			return `${whole}`;
		case 1:
			return `${whole}.${fraction}`;
		case 2:
			return `${whole}.`;
		default:
			return `.${fraction}`;
	}
}

function calcText({ rng }: { rng: Rng }): string {
	if (rng.bool()) {
		return `calc(${numberText({ rng })}% - ${numberText({ rng })}px)`;
	}
	// A nested call, which the paren counter has to walk rather than match.
	return `calc(100% - calc(${numberText({ rng })}px + 1px))`;
}

function distanceText({ rng }: { rng: Rng }): string {
	switch (rng.int({ min: 0, max: 24 })) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5:
			return `${numberText({ rng })}%`;
		case 6:
		case 7:
		case 8:
		case 9:
		case 10:
		case 11:
			return `${numberText({ rng })}px`;
		case 12:
		case 13:
		case 14:
			return `${numberText({ rng })}em`;
		case 15:
		case 16:
		case 17:
		case 18:
		case 19:
		case 20:
			return rng.pick({ from: POSITION_KEYWORDS });
		case 21:
		case 22:
		case 23:
			return calcText({ rng });
		default:
			// Units are matched case-sensitively, so this one is a rejection.
			return `${numberText({ rng })}PX`;
	}
}

/**
 * Deliberately lopsided: malformed colours are the cheapest way to make a whole
 * declaration fail, and a run that rejects almost everything compares almost
 * nothing. The named malformations still appear, and `PINNED_DECLARATIONS`
 * carries one of each unconditionally.
 */
function colorText({ rng }: { rng: Rng }): string {
	// Components are unsigned; percentages carry a sign of their own.
	const number = () => unsignedNumberText({ rng });
	const percentage = () => numberText({ rng });
	switch (rng.int({ min: 0, max: 23 })) {
		case 0:
		case 1:
		case 2:
			return `#${rng.pick({ from: HEX_DIGITS })}`;
		case 3:
		case 4:
		case 5:
		case 6:
		case 7:
		case 8:
			return rng.pick({ from: LITERAL_COLORS });
		case 9:
		case 10:
		case 11:
			return `rgb(${number()},${gap({ rng })}${number()}, ${number()})`;
		case 12:
		case 13:
		case 14:
			return `rgba(${number()}, ${number()}, ${number()}, 0.${rng.int({ min: 0, max: 999 })})`;
		case 15:
		case 16:
			return `hsl(${number()}, ${percentage()}%, ${percentage()}%)`;
		case 17:
			// The commas are optional; the blank skip alone gets this through.
			return `hsl(${number()} ${percentage()}% ${percentage()}%)`;
		case 18:
		case 19:
			return `hsla(${number()}, ${percentage()}%, ${percentage()}%, ${number()})`;
		case 20:
		case 21:
			return `var(${rng.pick({ from: VARIABLE_NAMES })})`;
		case 22:
			// A percentage hue: the one malformed HSL the parser names.
			return `hsl(${percentage()}%, ${percentage()}%, ${percentage()}%)`;
		default:
			return rng.pick({
				from: [
					// Components are unsigned.
					`rgb(-${number()}, ${number()}, ${number()})`,
					// Saturation and lightness have to be percentages.
					`hsl(${number()}, ${number()}, ${number()})`,
					// `hsla` wants four components.
					`hsla(${number()}, ${percentage()}%, ${percentage()}%)`,
					// No components at all.
					"rgb()",
					"rgba()",
					"hsl()",
					"hsla()",
				],
			});
	}
}

function colorStopText({ rng }: { rng: Rng }): string {
	const color = colorText({ rng });
	if (rng.int({ min: 0, max: 2 }) === 0) {
		return color;
	}
	return `${color}${gap({ rng })}${distanceText({ rng })}`;
}

function linearOrientationText({ rng }: { rng: Rng }): string | null {
	switch (rng.int({ min: 0, max: 4 })) {
		case 0:
			return null;
		case 1:
			return rng.pick({ from: SIDES_AND_CORNERS });
		case 2:
			return rng.pick({ from: POSITION_KEYWORDS });
		case 3:
			return `${numberText({ rng })}deg`;
		default:
			return `${numberText({ rng })}rad`;
	}
}

function atClauseText({ rng }: { rng: Rng }): string {
	const x = distanceText({ rng });
	if (rng.bool()) {
		return `at ${x}`;
	}
	return `at ${x} ${distanceText({ rng })}`;
}

function radialNodeText({ rng }: { rng: Rng }): string {
	switch (rng.int({ min: 0, max: 7 })) {
		case 0:
			return `circle${gap({ rng })}${distanceText({ rng })}`;
		case 1:
			return `circle ${rng.pick({ from: EXTENT_KEYWORDS })}`;
		case 2:
			return `ellipse ${distanceText({ rng })} ${distanceText({ rng })}`;
		case 3:
			return `ellipse ${rng.pick({ from: EXTENT_KEYWORDS })}`;
		case 4:
			return rng.pick({ from: EXTENT_KEYWORDS });
		case 5:
			// The implicit ellipse: two lengths and an `at`, no shape keyword.
			return `${distanceText({ rng })} ${distanceText({ rng })} ${atClauseText({ rng })}`;
		case 6:
			return atClauseText({ rng });
		default:
			return `${distanceText({ rng })} ${distanceText({ rng })}`;
	}
}

function radialOrientationText({ rng }: { rng: Rng }): string | null {
	switch (rng.int({ min: 0, max: 3 })) {
		case 0:
			return null;
		case 1:
		case 2:
			return radialNodeText({ rng });
		default:
			// The list holds at most two nodes; a third is left for the stops,
			// which then fail to be colours.
			return `${radialNodeText({ rng })}, ${radialNodeText({ rng })}`;
	}
}

function gradientText({ rng }: { rng: Rng }): string {
	const name = rng.pick({ from: GRADIENT_NAMES });
	const prefix = rng.pick({ from: VENDOR_PREFIXES });
	const isRadial = name.endsWith("radial-gradient");
	const orientation = isRadial
		? radialOrientationText({ rng })
		: linearOrientationText({ rng });

	// Zero stops is always a rejection, so it stays in `PINNED_DECLARATIONS`
	// rather than eating a twentieth of every run here.
	const stopCount = rng.int({ min: 1, max: 4 });
	const stops: string[] = [];
	for (let index = 0; index < stopCount; index += 1) {
		stops.push(colorStopText({ rng }));
	}

	const parts = orientation === null ? stops : [orientation, ...stops];

	// A missing comma between the orientation and the stops is the other error
	// the grammar reports by name, so it is worth generating.
	const joined =
		orientation !== null && rng.int({ min: 0, max: 19 }) === 0
			? parts.join(" ")
			: parts.join(`${gap({ rng })},${gap({ rng })}`);

	return `${prefix}${name}(${gap({ rng })}${joined}${gap({ rng })})`;
}

function declarationText({ rng }: { rng: Rng }): string {
	const count = rng.int({ min: 1, max: 2 });
	const gradients: string[] = [];
	for (let index = 0; index < count; index += 1) {
		gradients.push(gradientText({ rng }));
	}

	let declaration = gradients.join(", ");
	if (rng.int({ min: 0, max: 9 }) === 0) {
		declaration += ";";
	}
	if (rng.int({ min: 0, max: 9 }) === 0) {
		declaration = `  ${declaration}\n`;
	}
	if (rng.int({ min: 0, max: 39 }) === 0) {
		// Trailing junk: a complete gradient followed by something that is not.
		declaration += " leftovers";
	}
	return declaration;
}

/** Declarations worth pinning: one per branch of the grammar, so the generated
 * run cannot pass by rejecting everything. */
const PINNED_DECLARATIONS = [
	"linear-gradient(red, blue)",
	"linear-gradient(to left, red, blue)",
	"linear-gradient(to bottom right, #fff 0%, #000 100%)",
	"linear-gradient(top, red, blue)",
	"linear-gradient(45deg, red, blue)",
	"linear-gradient(-0.5rad, red, blue)",
	"linear-gradient(12.deg, red, blue)",
	"-webkit-linear-gradient(left, red, blue)",
	"repeating-linear-gradient(45deg, red 0, blue 10px)",
	"radial-gradient(red, blue)",
	"radial-gradient(circle, red, blue)",
	"radial-gradient(circle 20px, red, blue)",
	"radial-gradient(circle closest-side at 30% 70%, red, blue)",
	"radial-gradient(ellipse 50%, red, blue)",
	"radial-gradient(ellipse farthest-corner at center, red, blue)",
	"radial-gradient(cover, red, blue)",
	"radial-gradient(cover at center, red, blue)",
	"radial-gradient(COVER, red, blue)",
	"radial-gradient(50% 60% at 10% 20%, red, blue)",
	"radial-gradient(at top left, red, blue)",
	"radial-gradient(30px 40px, red, blue)",
	"radial-gradient(circle, closest-side, red, blue)",
	"repeating-radial-gradient(circle at 50% 50%, red 0%, blue 50%)",
	"linear-gradient(rgb(1, 2, 3), rgba(4, 5, 6, 0.5))",
	"linear-gradient(hsl(120, 50%, 25%), hsla(240, 50%, 25%, 0.5))",
	"linear-gradient(hsl(120 50% 25%), blue)",
	"linear-gradient(var(--brand), var(--brand, #fff))",
	"linear-gradient(red 0%, blue 10px, green 2em, black calc(50% - 4px), white)",
	"linear-gradient(red calc(100% - calc(2px + 1px)), blue)",
	"linear-gradient(red, blue), radial-gradient(green, black)",
	"\n  linear-gradient( to left , red , blue ) ;  ",
	"",
	"   ",
	// Rejections.
	"not-a-gradient(red, blue)",
	"linear-gradient red, blue)",
	"linear-gradient(red, blue",
	"linear-gradient()",
	"linear-gradient(red, blue,)",
	"linear-gradient(to left)",
	"linear-gradient(hsl(50%, 50%, 50%), blue)",
	"linear-gradient(hsl(120, 50, 25), blue)",
	"linear-gradient(hsla(120, 50%, 25%), blue)",
	"linear-gradient(rgb(), blue)",
	"linear-gradient(var(brand), blue)",
	"linear-gradient(red calc(100% - 4px, blue)",
	"linear-gradient(red, blue) leftovers",
	"radial-gradient(at, red, blue)",
	"-webkit-nonsense(red, blue)",
];

/**
 * Both outcomes as data. The messages are free to differ — they cross the wasm
 * boundary as strings and are not part of the contract — so only the fact of a
 * rejection is compared.
 */
function attempt<T>({
	parse,
}: {
	parse: () => T;
}): { rejected: true } | { rejected: false; ast: T } {
	try {
		return { rejected: false, ast: parse() };
	} catch {
		return { rejected: true };
	}
}

/**
 * The declarations the parser refuses. Pinned from the run made while the
 * TypeScript still existed and the two agreed on all 49.
 */
const REJECTED = new Set([
	"repeating-linear-gradient(45deg, red 0, blue 10px)",
	"not-a-gradient(red, blue)",
	"linear-gradient red, blue)",
	"linear-gradient(red, blue",
	"linear-gradient()",
	"linear-gradient(red, blue,)",
	"linear-gradient(to left)",
	"linear-gradient(hsl(50%, 50%, 50%), blue)",
	"linear-gradient(hsl(120, 50, 25), blue)",
	"linear-gradient(hsla(120, 50%, 25%), blue)",
	"linear-gradient(rgb(), blue)",
	"linear-gradient(var(brand), blue)",
	"linear-gradient(red calc(100% - 4px, blue)",
	"linear-gradient(red, blue) leftovers",
	"radial-gradient(at, red, blue)",
	"-webkit-nonsense(red, blue)",
]);

test("every pinned declaration is accepted or rejected as pinned", () => {
	for (const code of PINNED_DECLARATIONS) {
		const outcome = attempt({ parse: () => parseGradientRust({ code }) });
		expect(
			outcome.rejected
				? `${JSON.stringify(code)} was rejected`
				: `${JSON.stringify(code)} was accepted`,
		).toBe(
			REJECTED.has(code)
				? `${JSON.stringify(code)} was rejected`
				: `${JSON.stringify(code)} was accepted`,
		);
	}
});

test("the AST is the shape gradients/canvas.ts switches on", () => {
	// `length: undefined` is written out rather than omitted because that is the
	// real wire shape: `serde-wasm-bindgen` renders `None` as a key that is
	// present and `undefined`, not as a missing key.
	//
	// Four declarations spelled out in full, one per branch `canvas.ts` reads:
	// a directional linear with hex stops and lengths, a radial with a shape,
	// extent keyword and position, the functional colour forms, and a
	// declaration carrying two gradients.
	expect(
		parseGradientRust({
			code: "linear-gradient(to bottom right, #fff 0%, #000 100%)",
		}),
	).toEqual([
		{
			type: "linear-gradient",
			orientation: { type: "directional", value: "bottom right" },
			colorStops: [
				{ type: "hex", value: "fff", length: { type: "%", value: "0" } },
				{ type: "hex", value: "000", length: { type: "%", value: "100" } },
			],
		},
	]);

	expect(
		parseGradientRust({
			code: "radial-gradient(circle closest-side at 30% 70%, red, blue)",
		}),
	).toEqual([
		{
			type: "radial-gradient",
			orientation: [
				{
					type: "shape",
					value: "circle",
					style: { type: "extent-keyword", value: "closest-side" },
					at: {
						type: "position",
						value: {
							x: { type: "%", value: "30" },
							y: { type: "%", value: "70" },
						},
					},
				},
			],
			colorStops: [
				{ type: "literal", value: "red", length: undefined },
				{ type: "literal", value: "blue", length: undefined },
			],
		},
	]);

	expect(
		parseGradientRust({ code: "linear-gradient(rgb(1, 2, 3), rgba(4, 5, 6, 0.5))" }),
	).toEqual([
		{
			type: "linear-gradient",
			orientation: undefined,
			colorStops: [
				{ type: "rgb", value: ["1", "2", "3"], length: undefined },
				{ type: "rgba", value: ["4", "5", "6", "0.5"], length: undefined },
			],
		},
	]);

	expect(
		parseGradientRust({
			code: "linear-gradient(red, blue), radial-gradient(green, black)",
		}),
	).toEqual([
		{
			type: "linear-gradient",
			orientation: undefined,
			colorStops: [
				{ type: "literal", value: "red", length: undefined },
				{ type: "literal", value: "blue", length: undefined },
			],
		},
		{
			type: "radial-gradient",
			orientation: undefined,
			colorStops: [
				{ type: "literal", value: "green", length: undefined },
				{ type: "literal", value: "black", length: undefined },
			],
		},
	]);
});

test("a unitless stop length is refused, as the vendored parser refused it", () => {
	// `red 0` rather than `red 0%`. Preserved deliberately: this is the original
	// parser's behaviour, and a caller relying on it would break if the port
	// "fixed" it.
	expect(() =>
		parseGradientRust({
			code: "repeating-linear-gradient(45deg, red 0, blue 10px)",
		}),
	).toThrow();
});

test("no generated declaration escapes as a panic", () => {
	// The generator was written to drive a differential against the TypeScript,
	// which is now deleted. It still earns its place: a Rust panic crossing the
	// wasm boundary is a distinct failure mode from a rejection, and the only way
	// to find one is to throw a lot of nearly-valid CSS at it. Every declaration
	// must either parse into a well-formed AST or be refused with an `Error`.
	const rng = createRng({ seed: 0x67a01e });
	let acceptedCount = 0;

	for (let iteration = 0; iteration < 4_000; iteration += 1) {
		const code = declarationText({ rng });
		const outcome = attempt({ parse: () => parseGradientRust({ code }) });
		if (outcome.rejected) {
			continue;
		}
		acceptedCount += 1;
		expect(Array.isArray(outcome.ast)).toBe(true);
		for (const node of outcome.ast) {
			expect(typeof node.type).toBe("string");
			expect(node.colorStops.length).toBeGreaterThan(0);
			for (const stop of node.colorStops) {
				expect(typeof stop.type).toBe("string");
			}
		}
	}

	// A boundary that had stopped deserialising would refuse everything and the
	// loop above would assert nothing at all.
	expect(acceptedCount).toBeGreaterThan(0);
});
