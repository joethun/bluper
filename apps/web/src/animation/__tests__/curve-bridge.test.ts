import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { ScalarAnimationKey } from "@/animation/types";

mock.module("bluper-wasm", () => wasmNative);

const {
	getCurveHandlesForNormalizedCubicBezier,
	getNormalizedCubicBezierForScalarSegment,
} = await import("@/wasm/animation");

/**
 * Curve/handle conversion moved to `editor-core::animation::curve_bridge`. The
 * two implementations were held to bit-exact agreement over 10,000 generated
 * segments before the TypeScript was removed; these are the values it produced,
 * recorded beforehand.
 *
 * The odd-looking `dv` figures below are the point. `-2.999999999999999` is what
 * the arithmetic actually yields, and a port that returned a tidy `-3` would be
 * a behaviour change wearing the appearance of a fix.
 */

function key({
	time,
	value,
}: {
	time: number;
	value: number;
}): ScalarAnimationKey {
	return {
		id: `k${time}`,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		time: time as ScalarAnimationKey["time"],
		value,
		segmentToNext: "bezier",
		tangentMode: "auto",
	};
}

/** Widen the branded `MediaTime` back to a plain number for comparison. */
function plainHandles(
	pair: ReturnType<typeof getCurveHandlesForNormalizedCubicBezier>,
): {
	rightHandle: { dt: number; dv: number };
	leftHandle: { dt: number; dv: number };
} | null {
	if (!pair) return null;
	return {
		rightHandle: { dt: pair.rightHandle.dt, dv: pair.rightHandle.dv },
		leftHandle: { dt: pair.leftHandle.dt, dv: pair.leftHandle.dv },
	};
}

test("default handles normalise to the even-thirds curve", () => {
	expect(
		getNormalizedCubicBezierForScalarSegment({
			leftKey: key({ time: 0, value: 0 }),
			rightKey: key({ time: 300, value: 30 }),
		}),
	).toEqual([
		0.3333333333333333, 0.3333333333333333, 0.6666666666666667,
		0.6666666666666667,
	]);

	// Independent of the span, because both axes are normalised by it.
	expect(
		getNormalizedCubicBezierForScalarSegment({
			leftKey: key({ time: -77, value: 3.5 }),
			rightKey: key({ time: 931, value: -12.25 }),
		}),
	).toEqual([
		0.3333333333333333, 0.3333333333333333, 0.6666666666666667,
		0.6666666666666667,
	]);
});

test("a flat segment needs a reference scale to have a curve at all", () => {
	const flat = {
		leftKey: key({ time: 0, value: 5 }),
		rightKey: key({ time: 300, value: 5 }),
	};
	expect(getNormalizedCubicBezierForScalarSegment(flat)).toBeNull();
	expect(
		getNormalizedCubicBezierForScalarSegment({
			...flat,
			referenceSpanValue: 10,
		}),
	).toEqual([0.3333333333333333, 0, 0.6666666666666667, 1]);
});

test("handles come back on the tick lattice, float residue and all", () => {
	expect(
		plainHandles(
			getCurveHandlesForNormalizedCubicBezier({
				leftKey: key({ time: 0, value: 0 }),
				rightKey: key({ time: 300, value: 30 }),
				cubicBezier: [0.25, 0.1, 0.75, 0.9],
			}),
		),
	).toEqual({
		rightHandle: { dt: 75, dv: 3 },
		leftHandle: { dt: -75, dv: -2.999999999999999 },
	});

	expect(
		plainHandles(
			getCurveHandlesForNormalizedCubicBezier({
				leftKey: key({ time: -77, value: 3.5 }),
				rightKey: key({ time: 931, value: -12.25 }),
				cubicBezier: [0.17, -0.4, 0.83, 1.4],
			}),
		),
	).toEqual({
		rightHandle: { dt: 171, dv: 6.300000000000001 },
		leftHandle: { dt: -171, dv: -6.299999999999999 },
	});
});

test("control points outside the segment are clamped into it", () => {
	expect(
		plainHandles(
			getCurveHandlesForNormalizedCubicBezier({
				leftKey: key({ time: 0, value: 0 }),
				rightKey: key({ time: 300, value: 30 }),
				cubicBezier: [5, 0, -5, 1],
			}),
		),
	).toEqual({
		rightHandle: { dt: 300, dv: 0 },
		leftHandle: { dt: -300, dv: 0 },
	});
});
