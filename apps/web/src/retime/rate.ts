export const DEFAULT_RETIME_RATE = 1;
export const MIN_RETIME_RATE = 0.01;
export const MAX_RETIME_RATE = 5;

/**
 * Speed curves get their own, narrower bounds. A curve handle is dragged on a
 * log axis rather than typed, so the range has to stay readable at a glance —
 * and a decade either side of 1x is the span the graph labels.
 */
export const MIN_CURVE_RATE = 0.1;
export const MAX_CURVE_RATE = 10;

export function clampRetimeRate({ rate }: { rate: number }): number {
	if (!Number.isFinite(rate) || rate <= 0) {
		return DEFAULT_RETIME_RATE;
	}

	return Math.min(Math.max(rate, MIN_RETIME_RATE), MAX_RETIME_RATE);
}

export function clampCurveRate({ rate }: { rate: number }): number {
	if (!Number.isFinite(rate) || rate <= 0) {
		return DEFAULT_RETIME_RATE;
	}

	return Math.min(Math.max(rate, MIN_CURVE_RATE), MAX_CURVE_RATE);
}

export function canMaintainPitch({ rate }: { rate: number }): boolean {
	return Number.isFinite(rate) && rate > 0;
}

export function shouldMaintainPitch({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch?: boolean;
}): boolean {
	return maintainPitch === true && canMaintainPitch({ rate });
}
