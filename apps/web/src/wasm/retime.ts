import {
	MAX_CURVE_POINTS_VALUE,
	MAX_CURVE_RATE_VALUE,
	MAX_RETIME_RATE_VALUE,
	MIN_CURVE_RATE_VALUE,
	MIN_RETIME_RATE_VALUE,
	DEFAULT_RETIME_RATE_VALUE,
	buildConstantRetime as _buildConstantRetime,
	buildCurveRetime as _buildCurveRetime,
	buildRetimeCurvePreset as _buildRetimeCurvePreset,
	canMaintainPitchAt as _canMaintainPitchAt,
	clampCurveRateValue as _clampCurveRateValue,
	clampRetimeRateValue as _clampRetimeRateValue,
	getClipTimeAtSourceTime as _getClipTimeAtSourceTime,
	getCurveRateAtPosition as _getCurveRateAtPosition,
	getRetimeCurveOf as _getRetimeCurveOf,
	getRetimeCurvePresets as _getRetimeCurvePresets,
	getSourceSpanAtClipTime as _getSourceSpanAtClipTime,
	getSourceTimeAtClipTime as _getSourceTimeAtClipTime,
	getTimelineDurationForSourceSpan as _getTimelineDurationForSourceSpan,
	hasRetimeCurve as _hasRetimeCurve,
	sampleCurveRateSeries as _sampleCurveRateSeries,
	sanitizeCurve as _sanitizeCurve,
	scaleCurveRates as _scaleCurveRates,
	sliceCurve as _sliceCurve,
	splitRetimeAtClipTime as _splitRetimeAtClipTime,
} from "bluper-wasm";
import type {
	RetimeConfig,
	RetimeCurve,
	RetimeCurvePresetId,
} from "@/timeline";

/**
 * Speed curves, now owned by `editor-core::retime`.
 *
 * The uniform-rate paths were held to bit-exact agreement with the TypeScript
 * they replace. The curved ones agree to a relative 1e-12 and no closer, because
 * the spline interpolates in log space and V8 ships its own `Math.log`/
 * `Math.exp` rather than calling the platform's — measured at one ulp on 8 of 65
 * spline samples, before any integration. That is the whole of the difference.
 */

export const DEFAULT_RETIME_RATE = DEFAULT_RETIME_RATE_VALUE();
export const MIN_RETIME_RATE = MIN_RETIME_RATE_VALUE();
export const MAX_RETIME_RATE = MAX_RETIME_RATE_VALUE();
export const MIN_CURVE_RATE = MIN_CURVE_RATE_VALUE();
export const MAX_CURVE_RATE = MAX_CURVE_RATE_VALUE();
export const MAX_CURVE_POINTS = MAX_CURVE_POINTS_VALUE();

export function clampRetimeRate({ rate }: { rate: number }): number {
	return _clampRetimeRateValue({ rate });
}

export function clampCurveRate({ rate }: { rate: number }): number {
	return _clampCurveRateValue({ rate });
}

export function canMaintainPitch({ rate }: { rate: number }): boolean {
	return _canMaintainPitchAt({ rate });
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

export function getRetimeCurve({
	retime,
}: {
	retime?: RetimeConfig;
}): RetimeCurve | undefined {
	return _getRetimeCurveOf({ retime }) ?? undefined;
}

export function hasRetimeCurve({ retime }: { retime?: RetimeConfig }): boolean {
	return _hasRetimeCurve({ retime });
}

export function sanitizeRetimeCurve({
	curve,
}: {
	curve: RetimeCurve;
}): RetimeCurve {
	return _sanitizeCurve({ curve });
}

export function getCurveRateAtPosition({
	curve,
	position,
}: {
	curve: RetimeCurve;
	position: number;
}): number {
	return _getCurveRateAtPosition({ curve, position });
}

/**
 * Rust returns the samples wrapped, because a bare sequence crosses as an object
 * with numeric keys rather than a JS array.
 */
export function sampleCurveRates({
	curve,
	sampleCount,
}: {
	curve: RetimeCurve;
	sampleCount: number;
}): number[] {
	return _sampleCurveRateSeries({ curve, sampleCount }).rates;
}

export function sliceRetimeCurve({
	curve,
	fromFraction,
	toFraction,
}: {
	curve: RetimeCurve;
	fromFraction: number;
	toFraction: number;
}): RetimeCurve {
	return _sliceCurve({ curve, fromFraction, toFraction });
}

export function scaleRetimeCurveRates({
	curve,
	factor,
}: {
	curve: RetimeCurve;
	factor: number;
}): RetimeCurve {
	return _scaleCurveRates({ curve, factor });
}

export function buildConstantRetime({
	rate,
	maintainPitch = false,
}: {
	rate: number;
	maintainPitch?: boolean;
}): RetimeConfig {
	return _buildConstantRetime({ rate, maintainPitch });
}

export function buildCurveRetime({
	curve,
	maintainPitch = false,
}: {
	curve: RetimeCurve;
	maintainPitch?: boolean;
}): RetimeConfig {
	return _buildCurveRetime({ curve, maintainPitch });
}

export function buildRetimeCurvePreset({
	presetId,
}: {
	presetId: RetimeCurvePresetId;
}): RetimeCurve {
	return _buildRetimeCurvePreset({ presetId });
}

export const RETIME_CURVE_PRESETS = _getRetimeCurvePresets().presets;

export function getSourceTimeAtClipTime({
	clipTime,
	clipDuration,
	retime,
}: {
	clipTime: number;
	clipDuration?: number;
	retime?: RetimeConfig;
}): number {
	return _getSourceTimeAtClipTime({ clipTime, clipDuration, retime });
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
	return _getClipTimeAtSourceTime({ sourceTime, clipDuration, retime });
}

export function getTimelineDurationForSourceSpan({
	sourceSpan,
	retime,
}: {
	sourceSpan: number;
	retime?: RetimeConfig;
}): number {
	return _getTimelineDurationForSourceSpan({ sourceSpan, retime });
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
	return _getSourceSpanAtClipTime({ clipTime, clipDuration, retime });
}

export function splitRetimeAtClipTime({
	retime,
	splitClipTime,
	clipDuration,
}: {
	retime?: RetimeConfig;
	splitClipTime: number;
	clipDuration?: number;
}): { left: RetimeConfig | undefined; right: RetimeConfig | undefined } {
	const split = _splitRetimeAtClipTime({ retime, splitClipTime, clipDuration });
	return { left: split.left ?? undefined, right: split.right ?? undefined };
}
