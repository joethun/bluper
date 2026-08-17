export interface Point {
	readonly x: number;
	readonly y: number;
}

/**
 * Rotates an offset around the origin. Callers holding an absolute point and a
 * centre want `rotatePointAround`; this is the primitive both build on.
 */
export function rotateOffset({
	dx,
	dy,
	rotationRad,
}: {
	dx: number;
	dy: number;
	rotationRad: number;
}): { x: number; y: number } {
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);

	return {
		x: dx * cos - dy * sin,
		y: dx * sin + dy * cos,
	};
}

export function rotatePointAround({
	x,
	y,
	centerX,
	centerY,
	rotationRad,
}: {
	x: number;
	y: number;
	centerX: number;
	centerY: number;
	rotationRad: number;
}): { x: number; y: number } {
	const rotated = rotateOffset({
		dx: x - centerX,
		dy: y - centerY,
		rotationRad,
	});

	return {
		x: centerX + rotated.x,
		y: centerY + rotated.y,
	};
}

function lerpPoint({
	from,
	to,
	progress,
}: {
	from: Point;
	to: Point;
	progress: number;
}): { x: number; y: number } {
	return {
		x: from.x + (to.x - from.x) * progress,
		y: from.y + (to.y - from.y) * progress,
	};
}

/**
 * One de Casteljau subdivision step of the cubic bezier `p0..p3` at `t`. The
 * intermediate points are what callers need to rebuild the two halves: the
 * left half is `p0, p01, p012, point` and the right is `point, p123, p23, p3`.
 */
export function subdivideCubicBezier({
	p0,
	p1,
	p2,
	p3,
	t,
}: {
	p0: Point;
	p1: Point;
	p2: Point;
	p3: Point;
	t: number;
}): {
	p01: { x: number; y: number };
	p12: { x: number; y: number };
	p23: { x: number; y: number };
	p012: { x: number; y: number };
	p123: { x: number; y: number };
	point: { x: number; y: number };
} {
	const p01 = lerpPoint({ from: p0, to: p1, progress: t });
	const p12 = lerpPoint({ from: p1, to: p2, progress: t });
	const p23 = lerpPoint({ from: p2, to: p3, progress: t });
	const p012 = lerpPoint({ from: p01, to: p12, progress: t });
	const p123 = lerpPoint({ from: p12, to: p23, progress: t });

	return {
		p01,
		p12,
		p23,
		p012,
		p123,
		point: lerpPoint({ from: p012, to: p123, progress: t }),
	};
}

export function exceedsDragThreshold({
	current,
	origin,
	threshold,
}: {
	current: Point;
	origin: Point;
	threshold: number;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > threshold ||
		Math.abs(current.y - origin.y) > threshold
	);
}

export function dimensionToAspectRatio({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	const gcd = ({ a, b }: { a: number; b: number }): number =>
		b === 0 ? a : gcd({ a: b, b: a % b });
	const divisor = gcd({ a: width, b: height });
	const aspectWidth = width / divisor;
	const aspectHeight = height / divisor;
	return `${aspectWidth}:${aspectHeight}`;
}
