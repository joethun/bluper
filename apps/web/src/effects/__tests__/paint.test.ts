import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Canvas } from "@napi-rs/canvas";
import {
	EFFECT_GROUPS,
	effectsRegistry,
	paintEffectedLayer,
	registerDefaultEffects,
} from "..";
import { buildDefaultParamValues } from "@/params/registry";
import type { ParamDefinition, ParamValue } from "@/params";

/**
 * The effects paint on a canvas rather than through a shader, so they can be
 * exercised outside a browser: Skia stands in for `OffscreenCanvas`, including
 * the CSS filter chain and the blend modes the effects lean on.
 */
/* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
   The shim below has to reach the global object; there is no typed route to it. */
const scope = globalThis as unknown as { OffscreenCanvas: unknown };
const withoutShim = scope.OffscreenCanvas;

beforeAll(() => {
	scope.OffscreenCanvas = Canvas;
});

// Put back what was there. Whether a bun run has an `OffscreenCanvas` at all is
// something other suites notice, and it is not this suite's business to decide.
afterAll(() => {
	scope.OffscreenCanvas = withoutShim;
});

const WIDTH = 96;
const HEIGHT = 72;
/** Matches the panel's thumbnail sample point, so the tests judge what is shown. */
const PREVIEW_TIME = 0.12;

type Pixels = Uint8ClampedArray;

/**
 * Skia implements the slice of the canvas API the effects use, but under its own
 * types. The bridge is asserted here, once, rather than at every call site.
 */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion --
   See above: Skia stands in for the DOM canvas and TS cannot know it. */
function asContext({ canvas }: { canvas: Canvas }): CanvasRenderingContext2D {
	return canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
}

function asImageSource({ canvas }: { canvas: Canvas }): CanvasImageSource {
	return canvas as unknown as CanvasImageSource;
}
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

/**
 * A frame with something for every effect to bite on: a colour ramp for the
 * grades, a bright spot for the blooms, a near-black block for the luma key, and a
 * saturated green field for the chroma key.
 */
function buildSource(): Canvas {
	const canvas = new Canvas(WIDTH, HEIGHT);
	const ctx = canvas.getContext("2d");

	const ramp = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
	ramp.addColorStop(0, "#1b2a6b");
	ramp.addColorStop(0.5, "#c8552b");
	ramp.addColorStop(1, "#f2e9d0");
	ctx.fillStyle = ramp;
	ctx.fillRect(0, 0, WIDTH, HEIGHT);

	ctx.fillStyle = "#00d21e";
	ctx.fillRect(0, 0, WIDTH / 3, HEIGHT);
	ctx.fillStyle = "#0b0b0b";
	ctx.fillRect(WIDTH / 3, HEIGHT / 2, WIDTH / 4, HEIGHT / 3);
	ctx.fillStyle = "#ffffff";
	ctx.beginPath();
	ctx.arc(WIDTH * 0.72, HEIGHT * 0.3, HEIGHT * 0.16, 0, Math.PI * 2);
	ctx.fill();

	return canvas;
}

function paint({
	type,
	params,
	time,
	progress,
}: {
	type: string;
	params?: Record<string, ParamValue>;
	time?: number;
	progress?: number;
}): Pixels {
	const definition = effectsRegistry.get(type);
	const target = new Canvas(WIDTH, HEIGHT);
	const ctx = target.getContext("2d");
	paintEffectedLayer({
		ctx: asContext({ canvas: target }),
		source: asImageSource({ canvas: buildSource() }),
		width: WIDTH,
		height: HEIGHT,
		effects: [
			{
				type,
				params: {
					...buildDefaultParamValues(definition.params),
					...params,
				},
				time: time ?? PREVIEW_TIME,
				progress: progress ?? 1,
				animated: definition.animated === true,
			},
		],
	});
	return ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
}

function plainDraw(): Pixels {
	const target = new Canvas(WIDTH, HEIGHT);
	const ctx = target.getContext("2d");
	ctx.drawImage(buildSource(), 0, 0, WIDTH, HEIGHT);
	return ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
}

/**
 * The values to sweep a control through. Three points rather than two for
 * numbers, because a cyclic range such as a hue lands back where it started at
 * its own maximum.
 */
function sweepOf({ param }: { param: ParamDefinition }): ParamValue[] {
	switch (param.type) {
		case "number": {
			const max = param.max ?? param.min + 1;
			return [param.min, (param.min + max) / 2, max];
		}
		case "boolean":
			return [false, true];
		case "select":
			return param.options.map((option) => option.value);
		case "color":
			// The three primaries, because the sweep has to vary *hue*. Black and white
			// would not do: a chroma key compares colour rather than brightness, so both
			// sit at the same point in the UV plane and the key cannot tell them apart.
			return ["#ff0000", "#00ff00", "#0000ff"];
		default:
			return [param.default];
	}
}

/** Mean absolute per-channel difference, 0..255. */
function difference({ a, b }: { a: Pixels; b: Pixels }): number {
	let total = 0;
	for (let index = 0; index < a.length; index++) {
		total += Math.abs(a[index] - b[index]);
	}
	return total / a.length;
}

registerDefaultEffects();

const ALL_TYPES = effectsRegistry.getAll().map((definition) => definition.type);

describe("bundled effects", () => {
	test("every effect is registered once, grouped in library order", () => {
		expect(ALL_TYPES).toEqual([
			"pulse",
			"crash-zoom",
			"slow-zoom",
			"vhs",
			"filmic",
			"color-shift",
			"blur",
			"blur-fill",
			"glow",
			"chromatic-aberration",
			"green-screen",
			"black-white-removal",
		]);
	});

	test("the library's groups account for every effect, once each", () => {
		// The panel only draws what a group lists, so an effect missing from every
		// group would be registered and unreachable.
		const grouped = EFFECT_GROUPS.flatMap((group) => [...group.types]);
		expect([...grouped].sort()).toEqual([...ALL_TYPES].sort());
	});

	test("every effect paints something, and every param is declared", () => {
		for (const type of ALL_TYPES) {
			const definition = effectsRegistry.get(type);
			expect(definition.paint, type).toBeDefined();
			expect(definition.params.length, type).toBeGreaterThan(0);
			const keys = definition.params.map((param) => param.key);
			expect(new Set(keys).size, type).toBe(keys.length);
		}
	});

	test("every control moves the picture", () => {
		// A slider that does nothing is worse than a missing one: it reads as a
		// feature and quietly wastes the time of whoever drags it. Each param is
		// swept across its own range and has to change some pixels somewhere.
		//
		// `time` sits past a full cycle so a `loop` switch has something to differ
		// about, since inside the first cycle looping and not looping agree.
		const time = 3;
		for (const type of ALL_TYPES) {
			for (const param of effectsRegistry.get(type).params) {
				const settings = sweepOf({ param });
				const renders = settings.map((value) =>
					paint({ type, params: { [param.key]: value }, time }),
				);
				const moved = renders.some(
					(render, index) =>
						index > 0 && difference({ a: renders[0], b: render }) > 0.05,
				);
				expect(moved, `${type}.${param.key}`).toBe(true);
			}
		}
	});

	test("every effect changes the frame it is given", () => {
		const base = plainDraw();
		for (const type of ALL_TYPES) {
			expect(difference({ a: paint({ type }), b: base }), type).toBeGreaterThan(
				0.5,
			);
		}
	});

	test("a repeated paint of the same frame is identical", () => {
		// The compositor caches a layer by content hash and an export re-renders every
		// frame from scratch, so anything sampled from a random source would shimmer.
		for (const type of ALL_TYPES) {
			expect(paint({ type }), type).toEqual(paint({ type }));
		}
	});

	test("an amount of zero leaves the frame close to untouched", () => {
		const base = plainDraw();
		// The two whose look does not come from `amount` alone: a fill that always
		// insets, and a film stock whose grain is its own slider.
		const drivenElsewhere = new Set(["blur-fill", "filmic"]);
		for (const type of ALL_TYPES) {
			if (drivenElsewhere.has(type)) continue;
			const definition = effectsRegistry.get(type);
			if (!definition.params.some((param) => param.key === "amount")) continue;
			expect(
				difference({ a: paint({ type, params: { amount: 0 } }), b: base }),
				type,
			).toBeLessThan(6);
		}
	});

	test("an animated effect moves with time; a static one does not", () => {
		for (const type of ALL_TYPES) {
			const definition = effectsRegistry.get(type);
			const early = paint({ type, time: 0.05, progress: 0.05 });
			const late = paint({ type, time: 0.6, progress: 0.9 });
			const moved = difference({ a: early, b: late }) > 0.2;
			expect(moved, type).toBe(definition.animated === true);
		}
	});

	test("a stack applies in order rather than only its last entry", () => {
		const target = new Canvas(WIDTH, HEIGHT);
		const ctx = target.getContext("2d");
		paintEffectedLayer({
			ctx: asContext({ canvas: target }),
			source: asImageSource({ canvas: buildSource() }),
			width: WIDTH,
			height: HEIGHT,
			effects: ["blur", "color-shift"].map((type) => ({
				type,
				params: buildDefaultParamValues(effectsRegistry.get(type).params),
				time: 0,
				progress: 1,
				animated: false,
			})),
		});
		const stacked = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;

		expect(
			difference({ a: stacked, b: paint({ type: "blur" }) }),
		).toBeGreaterThan(0.5);
		expect(
			difference({ a: stacked, b: paint({ type: "color-shift" }) }),
		).toBeGreaterThan(0.5);
	});

	test("an empty stack falls through to a plain draw", () => {
		const target = new Canvas(WIDTH, HEIGHT);
		const ctx = target.getContext("2d");
		paintEffectedLayer({
			ctx: asContext({ canvas: target }),
			source: asImageSource({ canvas: buildSource() }),
			width: WIDTH,
			height: HEIGHT,
			effects: [],
		});
		expect(ctx.getImageData(0, 0, WIDTH, HEIGHT).data).toEqual(plainDraw());
	});

	test("keying makes the keyed field transparent and leaves the rest opaque", () => {
		const pixels = paint({
			type: "green-screen",
			params: { keyColor: "#00d21e", tolerance: 0.25, softness: 0.1 },
		});
		const alphaAt = ({ x, y }: { x: number; y: number }) =>
			pixels[(y * WIDTH + x) * 4 + 3];

		// Inside the green field, and well clear of it.
		expect(alphaAt({ x: 6, y: HEIGHT - 6 })).toBe(0);
		expect(alphaAt({ x: WIDTH - 6, y: HEIGHT - 6 })).toBe(255);
	});
});
