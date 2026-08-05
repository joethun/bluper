import { describe, expect, test } from "bun:test";
import {
	buildCurveRetime,
	buildRetimeCurvePreset,
	getClipTimeAtSourceTime,
	getCurveClipPerSource,
	getCurveRateAtPosition,
	getEffectiveRateAt,
	getRetimeCurve,
	getSourceTimeAtClipTime,
	getTimelineDurationForSourceSpan,
	sanitizeRetimeCurve,
	sliceRetimeCurve,
	splitRetimeAtClipTime,
} from "@/retime";
import type { RetimeCurve, RetimeCurvePoint } from "@/timeline";

function curveOf({ points }: { points: RetimeCurvePoint[] }): RetimeCurve {
	return sanitizeRetimeCurve({ curve: { preset: "custom", points } });
}

/** Two handles interpolate to a straight line in log space: rate = 4^position. */
const RAMP_TO_4X = curveOf({
	points: [
		{ position: 0, rate: 1 },
		{ position: 1, rate: 4 },
	],
});
const CONSTANT_2X = curveOf({
	points: [
		{ position: 0, rate: 2 },
		{ position: 1, rate: 2 },
	],
});

describe("sanitizeRetimeCurve", () => {
	test("sorts handles and pins one to each end of the clip", () => {
		const curve = curveOf({
			points: [
				{ position: 0.6, rate: 3 },
				{ position: 0.2, rate: 0.5 },
			],
		});

		expect(curve.points.map((point) => point.position)).toEqual([
			0, 0.2, 0.6, 1,
		]);
		expect(curve.points[0].rate).toBe(0.5);
		expect(curve.points[3].rate).toBe(3);
	});

	test("clamps speeds to the curve's own range", () => {
		const curve = curveOf({
			points: [
				{ position: 0, rate: 500 },
				{ position: 1, rate: 0.001 },
			],
		});

		expect(curve.points[0].rate).toBe(10);
		expect(curve.points[1].rate).toBe(0.1);
	});

	test("collapses handles dragged on top of one another", () => {
		const curve = curveOf({
			points: [
				{ position: 0, rate: 1 },
				{ position: 0.5, rate: 2 },
				{ position: 0.5001, rate: 3 },
				{ position: 1, rate: 1 },
			],
		});

		expect(curve.points).toHaveLength(3);
		// The later handle wins: while dragging, that is the one under the pointer.
		expect(curve.points[1].rate).toBe(3);
	});
});

describe("getCurveRateAtPosition", () => {
	test("passes through its handles", () => {
		expect(getCurveRateAtPosition({ curve: RAMP_TO_4X, position: 0 })).toBe(1);
		expect(getCurveRateAtPosition({ curve: RAMP_TO_4X, position: 1 })).toBe(4);
	});

	test("interpolates geometrically between two handles", () => {
		expect(
			getCurveRateAtPosition({ curve: RAMP_TO_4X, position: 0.5 }),
		).toBeCloseTo(2, 6);
	});

	test("holds a single speed across a flat curve", () => {
		for (const position of [0, 0.25, 0.5, 0.75, 1]) {
			expect(getCurveRateAtPosition({ curve: CONSTANT_2X, position })).toBe(2);
		}
	});

	test("allows speeds a uniform rate cannot reach", () => {
		const curve = curveOf({
			points: [
				{ position: 0, rate: 10 },
				{ position: 1, rate: 10 },
			],
		});
		expect(getCurveRateAtPosition({ curve, position: 0.5 })).toBe(10);
	});
});

describe("retime curve timing", () => {
	test("a flat curve matches the equivalent uniform rate", () => {
		const retime = buildCurveRetime({ curve: CONSTANT_2X });

		expect(
			getTimelineDurationForSourceSpan({ sourceSpan: 10, retime }),
		).toBeCloseTo(5, 6);
		expect(
			getSourceTimeAtClipTime({ clipTime: 2, clipDuration: 5, retime }),
		).toBeCloseTo(4, 6);
	});

	test("integrates a ramp rather than averaging its speeds", () => {
		// rate(p) = 4^p, so the clip runs for (1 - 1/4) / ln 4 of the source span.
		const expected = (1 - 1 / 4) / Math.log(4);
		expect(getCurveClipPerSource({ curve: RAMP_TO_4X })).toBeCloseTo(
			expected,
			5,
		);
	});

	test("lands exactly on the clip's ends", () => {
		const retime = buildCurveRetime({ curve: RAMP_TO_4X });
		const clipDuration = 6;
		const sourceSpan = getSourceTimeAtClipTime({
			clipTime: clipDuration,
			clipDuration,
			retime,
		});

		expect(
			getTimelineDurationForSourceSpan({ sourceSpan, retime }),
		).toBeCloseTo(clipDuration, 6);
		expect(
			getSourceTimeAtClipTime({ clipTime: 0, clipDuration, retime }),
		).toBe(0);
	});

	test("maps clip time and source time back onto each other", () => {
		const retime = buildCurveRetime({
			curve: curveOf({
				points: [
					{ position: 0, rate: 1 },
					{ position: 0.4, rate: 6 },
					{ position: 0.7, rate: 0.4 },
					{ position: 1, rate: 1 },
				],
			}),
		});
		const clipDuration = 8;

		for (const clipTime of [0.5, 2, 4, 6, 7.5]) {
			const sourceTime = getSourceTimeAtClipTime({
				clipTime,
				clipDuration,
				retime,
			});
			expect(
				getClipTimeAtSourceTime({ sourceTime, clipDuration, retime }),
			).toBeCloseTo(clipTime, 4);
		}
	});

	test("keeps walking the source past the clip's edges", () => {
		const retime = buildCurveRetime({ curve: CONSTANT_2X });
		const clipDuration = 4;

		// A transition asks a clip to keep playing outside its own span.
		expect(
			getSourceTimeAtClipTime({ clipTime: -1, clipDuration, retime }),
		).toBeCloseTo(-2, 6);
		expect(
			getSourceTimeAtClipTime({ clipTime: 5, clipDuration, retime }),
		).toBeCloseTo(10, 6);
	});

	test("follows the curve even where the average speed is clamped", () => {
		// The average of a 10x curve is above the uniform rate ceiling, so `rate`
		// is clamped — the curve itself still has to drive the timing.
		const retime = buildCurveRetime({
			curve: curveOf({
				points: [
					{ position: 0, rate: 10 },
					{ position: 1, rate: 10 },
				],
			}),
		});

		expect(retime.rate).toBe(5);
		expect(
			getTimelineDurationForSourceSpan({ sourceSpan: 10, retime }),
		).toBeCloseTo(1, 6);
	});

	test("reports the speed at a point inside the clip", () => {
		const retime = buildCurveRetime({ curve: RAMP_TO_4X });
		const clipDuration = 4;

		expect(getEffectiveRateAt({ clipTime: 0, clipDuration, retime })).toBeCloseTo(
			1,
			5,
		);
		expect(
			getEffectiveRateAt({ clipTime: clipDuration, clipDuration, retime }),
		).toBeCloseTo(4, 5);
	});

	test("falls back to the average speed with no clip length to anchor to", () => {
		const retime = buildCurveRetime({ curve: RAMP_TO_4X });
		const clipPerSource = getCurveClipPerSource({ curve: RAMP_TO_4X });

		// Exact at the ends whether or not the caller can supply a length.
		expect(getSourceTimeAtClipTime({ clipTime: 1, retime })).toBeCloseTo(
			1 / clipPerSource,
			6,
		);
	});

	test("treats a curve with no handles as no curve", () => {
		const retime = { rate: 2, curve: { preset: "custom" as const, points: [] } };

		expect(getRetimeCurve({ retime })).toBeUndefined();
		expect(getSourceTimeAtClipTime({ clipTime: 3, retime })).toBe(6);
	});
});

describe("sliceRetimeCurve", () => {
	test("renormalises the kept handles onto the new span", () => {
		const curve = curveOf({
			points: [
				{ position: 0, rate: 1 },
				{ position: 0.5, rate: 4 },
				{ position: 1, rate: 1 },
			],
		});

		const sliced = sliceRetimeCurve({
			curve,
			fromFraction: 0.5,
			toFraction: 1,
		});

		expect(sliced.points[0].position).toBe(0);
		expect(sliced.points[0].rate).toBeCloseTo(4, 6);
		expect(sliced.points[sliced.points.length - 1].position).toBe(1);
		expect(sliced.points[sliced.points.length - 1].rate).toBeCloseTo(1, 6);
	});

	test("a slice of a flat curve is the same flat curve", () => {
		const sliced = sliceRetimeCurve({
			curve: CONSTANT_2X,
			fromFraction: 0.25,
			toFraction: 0.75,
		});

		for (const point of sliced.points) {
			expect(point.rate).toBeCloseTo(2, 6);
		}
	});
});

describe("splitRetimeAtClipTime with a curve", () => {
	test("gives each half the shape over the material it keeps", () => {
		const retime = buildCurveRetime({
			curve: curveOf({
				points: [
					{ position: 0, rate: 1 },
					{ position: 0.5, rate: 4 },
					{ position: 1, rate: 1 },
				],
			}),
		});
		const clipDuration = 10;
		const splitClipTime = 4;

		const { left, right } = splitRetimeAtClipTime({
			retime,
			splitClipTime,
			clipDuration,
		});

		const totalSourceSpan = getSourceTimeAtClipTime({
			clipTime: clipDuration,
			clipDuration,
			retime,
		});
		const leftSourceSpan = getSourceTimeAtClipTime({
			clipTime: splitClipTime,
			clipDuration,
			retime,
		});

		// Each half still covers exactly the source it inherited, at its own length.
		expect(
			getTimelineDurationForSourceSpan({
				sourceSpan: leftSourceSpan,
				retime: left,
			}),
		).toBeCloseTo(splitClipTime, 5);
		expect(
			getTimelineDurationForSourceSpan({
				sourceSpan: totalSourceSpan - leftSourceSpan,
				retime: right,
			}),
		).toBeCloseTo(clipDuration - splitClipTime, 5);
	});

	test("passes a uniform rate to both halves unchanged", () => {
		const retime = { rate: 1.5 };
		const result = splitRetimeAtClipTime({
			retime,
			splitClipTime: 3,
			clipDuration: 10,
		});

		expect(result.left).toBe(retime);
		expect(result.right).toBe(retime);
	});
});

describe("retime curve presets", () => {
	test("every preset spans the whole clip and stays in range", () => {
		for (const presetId of [
			"custom",
			"montage",
			"hero",
			"bullet",
			"jumpCut",
			"flashIn",
			"flashOut",
		] as const) {
			const curve = buildRetimeCurvePreset({ presetId });

			expect(curve.preset).toBe(presetId);
			expect(curve.points[0].position).toBe(0);
			expect(curve.points[curve.points.length - 1].position).toBe(1);
			for (const point of curve.points) {
				expect(point.rate).toBeGreaterThanOrEqual(0.1);
				expect(point.rate).toBeLessThanOrEqual(10);
			}
		}
	});

	test("a preset gives the clip a length to run for", () => {
		const retime = buildCurveRetime({
			curve: buildRetimeCurvePreset({ presetId: "montage" }),
		});
		const duration = getTimelineDurationForSourceSpan({
			sourceSpan: 10,
			retime,
		});

		expect(duration).toBeGreaterThan(0);
		expect(Number.isFinite(duration)).toBe(true);
	});
});
