import type {
	RetimeConfig,
	RetimeCurve,
	RetimeCurvePoint,
} from "@/timeline";
import { clampCurveRate } from "@/retime/rate";

/**
 * Handles closer together than this collapse into one. Two handles at the same
 * position would make the curve vertical — an instant speed jump the time
 * integral cannot resolve — and dragging one on top of another is easy to do by
 * accident, so the near-miss is treated as the same miss.
 */
const MIN_POINT_SPACING = 0.005;

export const MAX_CURVE_POINTS = 12;

/**
 * Segments the curve is diced into to integrate it. The speed at a point is
 * cheap to evaluate but the clip's own clock is the integral of 1/speed, which
 * has no closed form for a spline — so it is summed numerically once per curve
 * and cached. Trapezoid error falls off as 1/N², so this is far finer than the
 * millisecond the timeline rounds to.
 */
const TABLE_RESOLUTION = 512;

interface RetimeCurveTable {
	/** Speed sampled at evenly spaced source positions. */
	rates: Float64Array;
	/**
	 * Clip time elapsed at each of those source positions, in units of the
	 * clip's visible source span. Monotonically increasing.
	 */
	clipAtSource: Float64Array;
	/** Source position reached at each evenly spaced fraction of clip time. */
	sourceAtClip: Float64Array;
	/** Clip seconds the curve yields per source second: the whole integral. */
	clipPerSource: number;
}

const tableCache = new WeakMap<RetimeCurve, RetimeCurveTable>();

/**
 * The clip's speed curve, or nothing if it plays at one speed. A curve with no
 * handles left is treated as no curve, so an emptied one cannot silently freeze
 * a clip at some leftover speed.
 */
export function getRetimeCurve({
	retime,
}: {
	retime?: RetimeConfig;
}): RetimeCurve | undefined {
	const curve = retime?.curve;
	return curve && curve.points.length > 0 ? curve : undefined;
}

export function hasRetimeCurve({ retime }: { retime?: RetimeConfig }): boolean {
	return getRetimeCurve({ retime }) !== undefined;
}

/**
 * Puts a curve into the shape the maths assumes: handles in order, no two on top
 * of each other, speeds inside the axis, and a handle pinned at each end so the
 * curve spans the whole clip. Everything that stores or evaluates a curve goes
 * through here, so a curve loaded from an old project or built by hand is as
 * safe as one dragged in the editor.
 */
export function sanitizeRetimeCurve({
	curve,
}: {
	curve: RetimeCurve;
}): RetimeCurve {
	const sorted = curve.points
		.filter((point) => Number.isFinite(point.position))
		.map((point) => ({
			position: Math.min(1, Math.max(0, point.position)),
			rate: clampCurveRate({ rate: point.rate }),
		}))
		.sort((a, b) => a.position - b.position);

	const spaced: RetimeCurvePoint[] = [];
	for (const point of sorted) {
		const previous = spaced[spaced.length - 1];
		if (previous && point.position - previous.position < MIN_POINT_SPACING) {
			// Keep the later handle's speed: while dragging, the handle under the
			// pointer is the one the user means.
			spaced[spaced.length - 1] = point;
			continue;
		}
		spaced.push(point);
	}

	const points = spaced;

	if (points.length === 0) {
		points.push({ position: 0, rate: 1 });
	}
	if (points[0].position > 0) {
		points.unshift({ position: 0, rate: points[0].rate });
	}
	const last = points[points.length - 1];
	if (last.position < 1) {
		points.push({ position: 1, rate: last.rate });
	}

	// Capped after the ends are pinned, so the cap is the real handle count and
	// the curve still reaches both ends of the clip.
	return {
		preset: curve.preset,
		points:
			points.length <= MAX_CURVE_POINTS
				? points
				: [
						...points.slice(0, MAX_CURVE_POINTS - 1),
						points[points.length - 1],
					],
	};
}

/**
 * The speed at a fraction of the way through the clip's source.
 *
 * Interpolation runs on log speed, not speed: the graph's axis is logarithmic,
 * so a spline drawn straight through the handles on screen is a spline through
 * their logs, and going up an octave then down one lands back where it started
 * instead of drifting high. It also cannot undershoot into zero or negative
 * speed, which linear interpolation of a steep drop can.
 */
export function getCurveRateAtPosition({
	curve,
	position,
}: {
	curve: RetimeCurve;
	position: number;
}): number {
	const points = curve.points;
	if (points.length === 0) return 1;
	if (points.length === 1) return points[0].rate;

	const clamped = Math.min(1, Math.max(0, position));

	let index = 0;
	while (index < points.length - 2 && points[index + 1].position < clamped) {
		index++;
	}

	const start = points[index];
	const end = points[index + 1];
	const span = end.position - start.position;
	if (span <= 0) return end.rate;

	const t = Math.min(1, Math.max(0, (clamped - start.position) / span));
	const y0 = Math.log(start.rate);
	const y1 = Math.log(end.rate);

	// Catmull-Rom tangents, which is what gives the curve its swing past a handle
	// on the way to the next one rather than a chain of straight ramps.
	const m0 = tangentAt({ points, index });
	const m1 = tangentAt({ points, index: index + 1 });

	const t2 = t * t;
	const t3 = t2 * t;
	const logRate =
		(2 * t3 - 3 * t2 + 1) * y0 +
		(t3 - 2 * t2 + t) * span * m0 +
		(-2 * t3 + 3 * t2) * y1 +
		(t3 - t2) * span * m1;

	return clampCurveRate({ rate: Math.exp(logRate) });
}

function tangentAt({
	points,
	index,
}: {
	points: RetimeCurvePoint[];
	index: number;
}): number {
	const previous = points[index - 1];
	const next = points[index + 1];
	const current = points[index];

	if (!previous) {
		return (
			(Math.log(next.rate) - Math.log(current.rate)) /
			Math.max(MIN_POINT_SPACING, next.position - current.position)
		);
	}
	if (!next) {
		return (
			(Math.log(current.rate) - Math.log(previous.rate)) /
			Math.max(MIN_POINT_SPACING, current.position - previous.position)
		);
	}

	return (
		(Math.log(next.rate) - Math.log(previous.rate)) /
		Math.max(MIN_POINT_SPACING, next.position - previous.position)
	);
}

function getRetimeCurveTable({
	curve,
}: {
	curve: RetimeCurve;
}): RetimeCurveTable {
	const cached = tableCache.get(curve);
	if (cached) return cached;

	const table = buildRetimeCurveTable({ curve });
	tableCache.set(curve, table);
	return table;
}

function buildRetimeCurveTable({
	curve,
}: {
	curve: RetimeCurve;
}): RetimeCurveTable {
	const sanitized = sanitizeRetimeCurve({ curve });
	const count = TABLE_RESOLUTION + 1;
	const step = 1 / TABLE_RESOLUTION;

	const rates = new Float64Array(count);
	const clipAtSource = new Float64Array(count);

	for (let i = 0; i < count; i++) {
		rates[i] = getCurveRateAtPosition({
			curve: sanitized,
			position: i * step,
		});
	}

	for (let i = 1; i < count; i++) {
		// Trapezoid on 1/rate: the clip time a slice of source takes up.
		clipAtSource[i] =
			clipAtSource[i - 1] + (step * (1 / rates[i - 1] + 1 / rates[i])) / 2;
	}

	const clipPerSource = clipAtSource[count - 1];
	const sourceAtClip = new Float64Array(count);
	sourceAtClip[count - 1] = 1;

	// Invert by walking the two axes together. Both directions read the table as
	// piecewise linear, so a source position mapped forward and back lands on
	// itself instead of drifting by the interpolation error.
	let source = 0;
	for (let i = 1; i < count - 1; i++) {
		const target = i * step * clipPerSource;
		while (source < count - 2 && clipAtSource[source + 1] < target) {
			source++;
		}
		const spanClip = clipAtSource[source + 1] - clipAtSource[source];
		const withinSpan =
			spanClip > 0 ? (target - clipAtSource[source]) / spanClip : 0;
		sourceAtClip[i] = (source + withinSpan) * step;
	}

	return { rates, clipAtSource, sourceAtClip, clipPerSource };
}

function lookup({
	table,
	fraction,
}: {
	table: Float64Array;
	fraction: number;
}): number {
	const scaled = fraction * TABLE_RESOLUTION;
	const lower = Math.floor(scaled);
	if (lower >= TABLE_RESOLUTION) return table[TABLE_RESOLUTION];
	if (lower < 0) return table[0];
	const within = scaled - lower;
	return table[lower] * (1 - within) + table[lower + 1] * within;
}

/**
 * The clip seconds one second of source takes up across the whole curve. A clip
 * keeps the material its trim exposes and changes length instead, so this is the
 * factor between the two.
 */
export function getCurveClipPerSource({ curve }: { curve: RetimeCurve }): number {
	return getRetimeCurveTable({ curve }).clipPerSource;
}

export function getCurveSourceFractionAtClipFraction({
	curve,
	clipFraction,
}: {
	curve: RetimeCurve;
	clipFraction: number;
}): number {
	return lookup({
		table: getRetimeCurveTable({ curve }).sourceAtClip,
		fraction: clipFraction,
	});
}

export function getCurveClipFractionAtSourceFraction({
	curve,
	sourceFraction,
}: {
	curve: RetimeCurve;
	sourceFraction: number;
}): number {
	return lookup({
		table: getRetimeCurveTable({ curve }).clipAtSource,
		fraction: sourceFraction,
	});
}

/**
 * Speeds sampled evenly across the curve, for drawing it. One call per redraw
 * beats one spline evaluation per pixel from the render path.
 */
export function sampleCurveRates({
	curve,
	sampleCount,
}: {
	curve: RetimeCurve;
	sampleCount: number;
}): number[] {
	const sanitized = sanitizeRetimeCurve({ curve });
	return Array.from({ length: sampleCount + 1 }, (_, index) =>
		getCurveRateAtPosition({
			curve: sanitized,
			position: index / sampleCount,
		}),
	);
}

/**
 * The same shape running a constant factor faster or slower. In log space this
 * is a shift, so every handle keeps its height relative to the others — which is
 * what makes it the right tool for correcting a cut curve's total timing without
 * disturbing the ramps the user drew.
 */
export function scaleRetimeCurveRates({
	curve,
	factor,
}: {
	curve: RetimeCurve;
	factor: number;
}): RetimeCurve {
	if (!Number.isFinite(factor) || factor <= 0) {
		return curve;
	}

	return {
		preset: curve.preset,
		points: curve.points.map((point) => ({
			position: point.position,
			rate: clampCurveRate({ rate: point.rate * factor }),
		})),
	};
}

/**
 * The stretch of curve a trim leaves visible, renormalised back onto 0..1.
 * Handles outside the kept span are dropped and the new ends get handles at the
 * speed the curve actually had there, so the material still on screen plays at
 * exactly the speed it did before the cut.
 */
export function sliceRetimeCurve({
	curve,
	fromFraction,
	toFraction,
}: {
	curve: RetimeCurve;
	fromFraction: number;
	toFraction: number;
}): RetimeCurve {
	const from = Math.min(1, Math.max(0, fromFraction));
	const to = Math.min(1, Math.max(0, toFraction));
	const span = to - from;
	if (span <= MIN_POINT_SPACING) {
		return sanitizeRetimeCurve({
			curve: {
				preset: curve.preset,
				points: [
					{
						position: 0,
						rate: getCurveRateAtPosition({ curve, position: from }),
					},
				],
			},
		});
	}

	const sanitized = sanitizeRetimeCurve({ curve });
	const interior = sanitized.points
		.filter((point) => point.position > from && point.position < to)
		.map((point) => ({
			position: (point.position - from) / span,
			rate: point.rate,
		}));

	return sanitizeRetimeCurve({
		curve: {
			preset: curve.preset,
			points: [
				{
					position: 0,
					rate: getCurveRateAtPosition({ curve: sanitized, position: from }),
				},
				...interior,
				{
					position: 1,
					rate: getCurveRateAtPosition({ curve: sanitized, position: to }),
				},
			],
		},
	});
}
