import type { RetimeConfig, RetimeCurve } from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import {
	getCurveClipFractionAtSourceFraction,
	getCurveClipPerSource,
	getCurveRateAtPosition,
	getCurveSourceFractionAtClipFraction,
	getRetimeCurve,
} from "@/retime/curve";

function getSafeRate({ rate }: { rate: number }): number {
	return clampRetimeRate({ rate });
}

/**
 * The source span a curved clip covers, from the length it occupies. A curve
 * keeps the material the trim exposes and changes how long the clip runs, so
 * dividing the clip's length by the curve's own stretch factor recovers the span.
 */
function getCurveSourceSpan({
	curve,
	clipDuration,
}: {
	curve: RetimeCurve;
	clipDuration: number;
}): number {
	const clipPerSource = getCurveClipPerSource({ curve });
	return clipPerSource > 0 ? clipDuration / clipPerSource : clipDuration;
}

/**
 * A curve's average speed. Used wherever a curved clip has to be described by a
 * single number — including callers that cannot supply the clip's length, where
 * it is exact at the clip's ends and an approximation in between.
 */
function getCurveAverageRate({ curve }: { curve: RetimeCurve }): number {
	const clipPerSource = getCurveClipPerSource({ curve });
	return clipPerSource > 0 ? 1 / clipPerSource : 1;
}

/**
 * Where in the source a clip is at `clipTime`.
 *
 * `clipDuration` is what anchors a speed curve: the curve's handles sit at
 * fractions of the clip rather than at times, so the clip's own length is what
 * turns them back into seconds. Without it a curved clip falls back to its
 * average speed, which still lands exactly on the clip's ends.
 *
 * Times outside the clip's span are answered by continuing at the speed of the
 * nearest end — transitions ask both clips to keep playing past their own edges.
 */
export function getSourceTimeAtClipTime({
	clipTime,
	clipDuration,
	retime,
}: {
	clipTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): number {
	const curve = getRetimeCurve({ retime });
	if (!curve) {
		return clipTime * getSafeRate({ rate: retime?.rate ?? 1 });
	}

	if (clipDuration === undefined || clipDuration <= 0) {
		return clipTime * getCurveAverageRate({ curve });
	}

	const sourceSpan = getCurveSourceSpan({ curve, clipDuration });

	if (clipTime <= 0) {
		return clipTime * getCurveRateAtPosition({ curve, position: 0 });
	}
	if (clipTime >= clipDuration) {
		return (
			sourceSpan +
			(clipTime - clipDuration) * getCurveRateAtPosition({ curve, position: 1 })
		);
	}

	return (
		sourceSpan *
		getCurveSourceFractionAtClipFraction({
			curve,
			clipFraction: clipTime / clipDuration,
		})
	);
}

export function getClipTimeAtSourceTime({
	sourceTime,
	clipDuration,
	retime,
}: {
	sourceTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): number {
	const curve = getRetimeCurve({ retime });
	if (!curve) {
		return sourceTime / getSafeRate({ rate: retime?.rate ?? 1 });
	}

	if (clipDuration === undefined || clipDuration <= 0) {
		return sourceTime / getCurveAverageRate({ curve });
	}

	const sourceSpan = getCurveSourceSpan({ curve, clipDuration });

	if (sourceTime <= 0) {
		return sourceTime / getCurveRateAtPosition({ curve, position: 0 });
	}
	if (sourceTime >= sourceSpan) {
		return (
			clipDuration +
			(sourceTime - sourceSpan) / getCurveRateAtPosition({ curve, position: 1 })
		);
	}

	return (
		sourceSpan *
		getCurveClipFractionAtSourceFraction({
			curve,
			sourceFraction: sourceTime / sourceSpan,
		})
	);
}

/**
 * How long a clip runs when it has to get through `sourceSpan` of material.
 * This is the whole reason a speed change resizes a clip, and for a curve it is
 * the curve's integral rather than a division.
 */
export function getTimelineDurationForSourceSpan({
	sourceSpan,
	retime,
}: {
	sourceSpan: number;
	retime?: RetimeConfig;
}): number {
	if (sourceSpan <= 0) {
		return 0;
	}

	const curve = getRetimeCurve({ retime });
	if (curve) {
		return sourceSpan * getCurveClipPerSource({ curve });
	}

	return sourceSpan / getSafeRate({ rate: retime?.rate ?? 1 });
}
