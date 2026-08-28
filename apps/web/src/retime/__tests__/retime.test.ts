import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { RetimeCurve } from "@/timeline";

mock.module("bluper-wasm", () => wasmNative);

const {
	buildCurveRetime,
	buildRetimeCurvePreset,
	getClipTimeAtSourceTime,
	getCurveRateAtPosition,
	getSourceTimeAtClipTime,
	getTimelineDurationForSourceSpan,
	sampleCurveRates,
	sanitizeRetimeCurve,
	scaleRetimeCurveRates,
	sliceRetimeCurve,
	splitRetimeAtClipTime,
} = await import("@/wasm/retime");

/**
 * Speed curves moved to `editor-core::retime`. While both implementations
 * existed they were compared over roughly 25,000 generated inputs; these are the
 * values the TypeScript produced, recorded before it was deleted.
 *
 * Two kinds of assertion, and the split is the point:
 *
 * - Anything without a `log`/`exp` in it — sanitising, scaling, the preset
 *   table, a uniform-rate division — is checked for exact equality.
 * - The spline and everything downstream of it is checked to 12 significant
 *   figures, because V8 ships its own `Math.log`/`Math.exp` and Rust calls the
 *   system libm. Measured before accepting it: 8 of 65 spline samples differ,
 *   every one by a single ulp, none by more.
 */

const CURVE: RetimeCurve = {
	preset: "custom",
	points: [
		{ position: 0, rate: 0.7 },
		{ position: 0.3, rate: 4.2 },
		{ position: 0.65, rate: 1.1 },
		{ position: 1, rate: 9.5 },
	],
};

test("sanitising is exact: order, spacing, clamping and pinned ends", () => {
	// Out of order, out of range both ways, and two handles 0.002 apart — which
	// collapse, keeping the later one's speed.
	expect(
		sanitizeRetimeCurve({
			curve: {
				preset: "hero",
				points: [
					{ position: 1.4, rate: 40 },
					{ position: -0.3, rate: 0.001 },
					{ position: 0.502, rate: 3 },
					{ position: 0.5, rate: 7 },
				],
			},
		}),
	).toEqual({
		preset: "hero",
		points: [
			{ position: 0, rate: 0.1 },
			{ position: 0.502, rate: 3 },
			{ position: 1, rate: 10 },
		],
	});
});

test("scaling is exact, and clamps at the curve bounds", () => {
	expect(scaleRetimeCurveRates({ curve: CURVE, factor: 2.5 })).toEqual({
		preset: "custom",
		points: [
			{ position: 0, rate: 1.75 },
			{ position: 0.3, rate: 10 },
			{ position: 0.65, rate: 2.75 },
			{ position: 1, rate: 10 },
		],
	});
});

test("a preset is exact and already spans the clip", () => {
	expect(buildRetimeCurvePreset({ presetId: "hero" })).toEqual({
		preset: "hero",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.2, rate: 1 },
			{ position: 0.4, rate: 0.3 },
			{ position: 0.6, rate: 4 },
			{ position: 0.8, rate: 1 },
			{ position: 1, rate: 1 },
		],
	});
});

test("a uniform rate resizes a clip exactly", () => {
	expect(
		getTimelineDurationForSourceSpan({
			sourceSpan: 5000,
			retime: { rate: 2.5 },
		}),
	).toBe(2000);
});

test("the spline matches to twelve figures", () => {
	expect(getCurveRateAtPosition({ curve: CURVE, position: 0.42 })).toBeCloseTo(
		2.930321727438214,
		12,
	);

	const samples = sampleCurveRates({ curve: CURVE, sampleCount: 4 });
	const expected = [
		0.7, 3.742272363736642, 1.8059012964984582, 1.578558705901768,
		9.500000000000002,
	];
	expect(samples).toHaveLength(expected.length);
	samples.forEach((rate, index) => {
		expect(rate).toBeCloseTo(expected[index], 12);
	});
});

test("slicing renormalises the kept stretch onto its own span", () => {
	const sliced = sliceRetimeCurve({
		curve: CURVE,
		fromFraction: 0.2,
		toFraction: 0.8,
	});
	expect(sliced.preset).toBe("custom");
	expect(sliced.points.map((point) => point.position)).toEqual([
		0, 0.1666666666666666, 0.7499999999999999, 1,
	]);
	const rates = [2.92230372004384, 4.2, 1.1, 2.1699438718946573];
	sliced.points.forEach((point, index) => {
		expect(point.rate).toBeCloseTo(rates[index], 12);
	});
});

test("the source/clip bijection matches to twelve figures", () => {
	const retime = { rate: 1, curve: CURVE };
	expect(
		getSourceTimeAtClipTime({ clipTime: 1234, clipDuration: 4000, retime }),
	).toBeCloseTo(1718.5303141180075, 12);
	expect(
		getClipTimeAtSourceTime({ sourceTime: 987, clipDuration: 4000, retime }),
	).toBeCloseTo(934.0052356691785, 12);
	expect(
		getTimelineDurationForSourceSpan({ sourceSpan: 5000, retime }),
	).toBeCloseTo(2598.699580156989, 12);
	expect(
		buildCurveRetime({ curve: CURVE, maintainPitch: true }).rate,
	).toBeCloseTo(1.9240392533937867, 12);
});

test("a cut curve keeps each half's own timing", () => {
	const split = splitRetimeAtClipTime({
		retime: { rate: 1, maintainPitch: true, curve: CURVE },
		splitClipTime: 1500,
		clipDuration: 4000,
	});
	expect(split.left?.rate).toBeCloseTo(1.8455740774534106, 12);
	expect(split.right?.rate).toBeCloseTo(1.971118358958013, 12);
	expect(split.left?.maintainPitch).toBe(true);
	// Each half's curve is renormalised across its own span, so both start at 0
	// and end at 1 rather than keeping the parent's coordinates.
	expect(split.left?.curve?.points[0].position).toBe(0);
	expect(split.right?.curve?.points.at(-1)?.position).toBe(1);
});

test("a uniform rate splits into itself, unchanged", () => {
	const retime = { rate: 2, maintainPitch: false };
	const split = splitRetimeAtClipTime({
		retime,
		splitClipTime: 500,
		clipDuration: 1000,
	});
	expect(split.left).toEqual(retime);
	expect(split.right).toEqual(retime);
});
