import type {
	RetimeConfig,
	RetimeCurve,
	RetimeCurvePoint,
	RetimeCurvePresetId,
} from "@/timeline";
import { clampRetimeRate } from "@/retime/rate";
import { getCurveClipPerSource, sanitizeRetimeCurve } from "@/retime/curve";

export function buildConstantRetime({
	rate,
	maintainPitch = false,
}: {
	rate: number;
	maintainPitch?: boolean;
}): RetimeConfig {
	return { rate: clampRetimeRate({ rate }), maintainPitch };
}

/**
 * A curved retime. `rate` is filled in with the curve's average speed so that
 * anything describing the clip with one number — a badge on the timeline, a
 * fallback that has no clip length to hand — still says something true about it.
 */
export function buildCurveRetime({
	curve,
	maintainPitch = false,
}: {
	curve: RetimeCurve;
	maintainPitch?: boolean;
}): RetimeConfig {
	const sanitized = sanitizeRetimeCurve({ curve });
	const clipPerSource = getCurveClipPerSource({ curve: sanitized });

	return {
		rate: clampRetimeRate({
			rate: clipPerSource > 0 ? 1 / clipPerSource : 1,
		}),
		maintainPitch,
		curve: sanitized,
	};
}

interface RetimeCurvePreset {
	id: RetimeCurvePresetId;
	label: string;
	points: RetimeCurvePoint[];
}

/**
 * The stock speed shapes, in the order they appear in the panel. Each one is
 * just handles: the same spline the editor draws through them is what plays, so
 * a preset is a starting point you can drag rather than a fixed effect.
 */
export const RETIME_CURVE_PRESETS: RetimeCurvePreset[] = [
	{
		id: "custom",
		label: "Custom",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.5, rate: 1 },
			{ position: 1, rate: 1 },
		],
	},
	{
		id: "montage",
		label: "Montage",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.15, rate: 1 },
			{ position: 0.35, rate: 6 },
			{ position: 0.55, rate: 0.3 },
			{ position: 0.75, rate: 1 },
			{ position: 1, rate: 1 },
		],
	},
	{
		id: "hero",
		label: "Hero",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.2, rate: 1 },
			{ position: 0.4, rate: 0.3 },
			{ position: 0.6, rate: 4 },
			{ position: 0.8, rate: 1 },
			{ position: 1, rate: 1 },
		],
	},
	{
		id: "bullet",
		label: "Bullet",
		points: [
			{ position: 0, rate: 4 },
			{ position: 0.3, rate: 4 },
			{ position: 0.42, rate: 0.2 },
			{ position: 0.58, rate: 0.2 },
			{ position: 0.7, rate: 4 },
			{ position: 1, rate: 4 },
		],
	},
	{
		id: "jumpCut",
		label: "Jump Cut",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.25, rate: 1 },
			{ position: 0.4, rate: 5 },
			{ position: 0.6, rate: 5 },
			{ position: 0.75, rate: 1 },
			{ position: 1, rate: 1 },
		],
	},
	{
		id: "flashIn",
		label: "Flash In",
		points: [
			{ position: 0, rate: 8 },
			{ position: 0.3, rate: 1 },
			{ position: 1, rate: 1 },
		],
	},
	{
		id: "flashOut",
		label: "Flash Out",
		points: [
			{ position: 0, rate: 1 },
			{ position: 0.7, rate: 1 },
			{ position: 1, rate: 8 },
		],
	},
];

export function buildRetimeCurvePreset({
	presetId,
}: {
	presetId: RetimeCurvePresetId;
}): RetimeCurve {
	const preset =
		RETIME_CURVE_PRESETS.find((candidate) => candidate.id === presetId) ??
		RETIME_CURVE_PRESETS[0];

	return sanitizeRetimeCurve({
		curve: { preset: preset.id, points: preset.points },
	});
}
