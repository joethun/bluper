import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { ScalarAnimationKey } from "@/animation/types";

mock.module("bluper-wasm", () => wasmNative);

const {
	getBezierPoint,
	getDefaultLeftHandle,
	getDefaultRightHandle,
	solveBezierProgressForTime,
} = await import("@/wasm/animation");

/**
 * Bezier segments moved to `editor-core::animation::bezier` in the Rust
 * migration. While both implementations existed they were held to bit-exact
 * agreement over 20,000 generated inputs; that comparison is gone with the
 * TypeScript, so these are the values it produced, recorded before it was
 * removed.
 *
 * Exact equality, not `toBeCloseTo`. The point of the numbers below is that they
 * are the same bits the old code returned — a version that agreed to twelve
 * digits would be a behaviour change that a preview cannot show you and an
 * export keeps.
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

test("getBezierPoint returns what the TypeScript returned", () => {
	expect(
		getBezierPoint({ progress: 0.25, p0: 0, p1: 10, p2: 20, p3: 30 }),
	).toBe(7.5);
	expect(
		getBezierPoint({ progress: 0.37, p0: -5, p1: 12.5, p2: 100, p3: 3 }),
	).toBe(30.2828115);
});

test("the curve passes through its endpoints", () => {
	expect(getBezierPoint({ progress: 0, p0: 10, p1: 20, p2: 30, p3: 40 })).toBe(
		10,
	);
	expect(getBezierPoint({ progress: 1, p0: 10, p1: 20, p2: 30, p3: 40 })).toBe(
		40,
	);
});

test("default handles keep their fractional tick offset", () => {
	// 100 / 3. Rounding this to whole ticks would move the curve off where the
	// editor drew it, which is why the offset is not a `MediaTime`.
	const pair = {
		leftKey: key({ time: 0, value: 0 }),
		rightKey: key({ time: 100, value: 30 }),
	};
	expect(getDefaultRightHandle(pair)).toEqual({
		dt: 33.333333333333336,
		dv: 10,
	});
	expect(getDefaultLeftHandle(pair)).toEqual({
		dt: -33.333333333333336,
		dv: -10,
	});
});

test("solveBezierProgressForTime returns what the TypeScript returned", () => {
	// Not 0.25: the solver runs a fixed 20 bisections and returns the midpoint
	// of the surviving interval, so the residual is part of the contract.
	expect(
		solveBezierProgressForTime({
			time: 25,
			leftKey: key({ time: 0, value: 0 }),
			rightKey: key({ time: 100, value: 1 }),
		}),
	).toBe(0.2499995231628418);

	expect(
		solveBezierProgressForTime({
			time: 37,
			leftKey: key({ time: -500, value: 2 }),
			rightKey: key({ time: 4321, value: -3 }),
		}),
	).toBe(0.11138772964477539);
});

test("a stored handle displaces the curve from its default", () => {
	const leftKey = key({ time: 0, value: 0 });
	const rightKey = key({ time: 100, value: 1 });
	const withStored = {
		time: 25,
		leftKey: {
			...leftKey,
			// A dragged handle is a whole number of ticks, so these are real
			// `CurveHandle`s rather than the fractional defaults.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			rightHandle: { dt: 90, dv: 0 } as ScalarAnimationKey["rightHandle"],
		},
		rightKey: {
			...rightKey,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			leftHandle: { dt: -90, dv: 0 } as ScalarAnimationKey["leftHandle"],
		},
	};
	expect(solveBezierProgressForTime(withStored)).not.toBe(
		solveBezierProgressForTime({ time: 25, leftKey, rightKey }),
	);
});
