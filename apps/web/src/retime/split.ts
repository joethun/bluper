import type { RetimeConfig, RetimeCurve } from "@/timeline";
import { getSourceTimeAtClipTime } from "./resolve";
import {
	getCurveClipPerSource,
	getCurveSourceFractionAtClipFraction,
	getRetimeCurve,
	scaleRetimeCurveRates,
	sliceRetimeCurve,
} from "./curve";
import { buildCurveRetime } from "./presets";

/**
 * A cut stretch of curve, retimed so it still takes exactly as long as the half
 * it belongs to.
 *
 * Slicing recomputes the spline's tangents from the handles that survived, so
 * the shape over the kept span comes out very slightly different — enough that
 * the half's own length and the length its curve implies would disagree by a
 * fraction of a percent, and disagree again on every later cut. Nudging the
 * whole slice by one constant factor puts the two back in step without moving
 * any handle relative to its neighbours.
 */
function fitCurveToSpan({
	curve,
	clipSpan,
	sourceSpan,
}: {
	curve: RetimeCurve;
	clipSpan: number;
	sourceSpan: number;
}): RetimeCurve {
	if (clipSpan <= 0 || sourceSpan <= 0) {
		return curve;
	}

	const requiredClipPerSource = clipSpan / sourceSpan;
	const actualClipPerSource = getCurveClipPerSource({ curve });
	if (requiredClipPerSource <= 0 || actualClipPerSource <= 0) {
		return curve;
	}

	return scaleRetimeCurveRates({
		curve,
		factor: actualClipPerSource / requiredClipPerSource,
	});
}

export function getSourceSpanAtClipTime({
	clipTime,
	clipDuration,
	retime,
}: {
	clipTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): number {
	return Math.max(
		0,
		getSourceTimeAtClipTime({ clipTime, clipDuration, retime }),
	);
}

/**
 * The retime each half of a cut clip keeps.
 *
 * A single rate splits into itself — both halves still run at that speed. A
 * curve has to be cut where the clip was: each half keeps only the stretch of
 * shape over the material it still holds, renormalised across its own span, so
 * a cut through a speed ramp does not restart the ramp in both halves.
 */
export function splitRetimeAtClipTime({
	retime,
	splitClipTime,
	clipDuration,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
	clipDuration?: number;
}): {
	left: RetimeConfig | undefined;
	right: RetimeConfig | undefined;
} {
	const curve = getRetimeCurve({ retime });
	if (!curve || clipDuration === undefined || clipDuration <= 0) {
		return { left: retime, right: retime };
	}

	const clipSpan = Math.min(clipDuration, Math.max(0, splitClipTime));
	const sourceFraction = getCurveSourceFractionAtClipFraction({
		curve,
		clipFraction: clipSpan / clipDuration,
	});
	const totalSourceSpan = clipDuration / getCurveClipPerSource({ curve });
	const leftSourceSpan = totalSourceSpan * sourceFraction;

	return {
		left: buildCurveRetime({
			curve: fitCurveToSpan({
				curve: sliceRetimeCurve({
					curve,
					fromFraction: 0,
					toFraction: sourceFraction,
				}),
				clipSpan,
				sourceSpan: leftSourceSpan,
			}),
			maintainPitch: retime?.maintainPitch,
		}),
		right: buildCurveRetime({
			curve: fitCurveToSpan({
				curve: sliceRetimeCurve({
					curve,
					fromFraction: sourceFraction,
					toFraction: 1,
				}),
				clipSpan: clipDuration - clipSpan,
				sourceSpan: totalSourceSpan - leftSourceSpan,
			}),
			maintainPitch: retime?.maintainPitch,
		}),
	};
}


