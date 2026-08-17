import type { TransitionDefinition } from "@/transitions/types";
import {
	DEFAULT_TRANSITION_DURATION,
	INTENSITY_PARAM,
	readIntensity,
	side,
	SLOW_TRANSITION_DURATION,
	smoothstep,
	triangle,
} from "./shared";

/** Blur radius at full intensity, expressed against a 1920px-wide frame. */
const MAX_BLUR_SIGMA_AT_REFERENCE_WIDTH = 36;
const BLUR_REFERENCE_WIDTH = 1920;
const MAX_ZOOM_STEP = 0.6;
const MAX_SHAKE_TRAVEL = 0.06;

function blurSigma({
	amount,
	width,
}: {
	amount: number;
	width: number;
}): number {
	return (
		amount * MAX_BLUR_SIGMA_AT_REFERENCE_WIDTH * (width / BLUR_REFERENCE_WIDTH)
	);
}

/**
 * Deterministic jitter. `Math.random()` would make the same frame render
 * differently on every pass, breaking both texture caching and export
 * reproducibility, so the wobble comes from mismatched sine frequencies.
 */
function jitter({
	progress,
	seed,
}: {
	progress: number;
	seed: number;
}): number {
	return (
		Math.sin(progress * 47 + seed) * 0.6 +
		Math.sin(progress * 113 + seed * 3) * 0.4
	);
}

const zoomIn: TransitionDefinition = {
	type: "zoom-in",
	name: "Zoom in",
	category: "camera",
	keywords: ["zoom", "in", "push", "scale", "punch"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params }) => {
		const step = readIntensity({ value: params.intensity }) * MAX_ZOOM_STEP;
		const eased = smoothstep({ progress });
		return {
			outgoing: side({ scale: 1 + eased * step }),
			incoming: side({
				opacity: progress,
				scale: 1 / (1 + (1 - eased) * step),
			}),
		};
	},
};

const zoomOut: TransitionDefinition = {
	type: "zoom-out",
	name: "Zoom out",
	category: "camera",
	keywords: ["zoom", "out", "pull", "scale", "shrink"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params }) => {
		const step = readIntensity({ value: params.intensity }) * MAX_ZOOM_STEP;
		const eased = smoothstep({ progress });
		return {
			outgoing: side({ scale: 1 / (1 + eased * step) }),
			incoming: side({
				opacity: progress,
				scale: 1 + (1 - eased) * step,
			}),
		};
	},
};

const spin: TransitionDefinition = {
	type: "spin",
	name: "Spin",
	category: "camera",
	keywords: ["spin", "rotate", "whip", "twirl"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params }) => {
		const amount = readIntensity({ value: params.intensity });
		const eased = smoothstep({ progress });
		const turn = 90 + amount * 270;
		return {
			outgoing: side({
				rotateDegrees: eased * turn * 0.35,
				scale: 1 + eased * 0.2,
			}),
			incoming: side({
				opacity: progress,
				rotateDegrees: -(1 - eased) * turn,
				scale: 1 - (1 - eased) * 0.4,
			}),
		};
	},
};

const blur: TransitionDefinition = {
	type: "blur",
	name: "Blur",
	category: "camera",
	keywords: ["blur", "defocus", "soft", "dreamy"],
	defaultDuration: SLOW_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params, width }) => {
		const amount = readIntensity({ value: params.intensity });
		const ramp = triangle({ progress });
		const sigma = blurSigma({ amount: amount * ramp, width });
		return {
			outgoing: side({ blurSigma: sigma }),
			incoming: side({ opacity: progress, blurSigma: sigma }),
		};
	},
};

const shake: TransitionDefinition = {
	type: "shake",
	name: "Shake",
	category: "camera",
	keywords: ["shake", "bump", "impact", "handheld", "glitch"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params, width, height }) => {
		const amount = readIntensity({ value: params.intensity });
		const envelope = triangle({ progress });
		const travelX = amount * envelope * MAX_SHAKE_TRAVEL * width;
		const travelY = amount * envelope * MAX_SHAKE_TRAVEL * height;
		return {
			outgoing: side({
				offsetX: jitter({ progress, seed: 1 }) * travelX,
				offsetY: jitter({ progress, seed: 7 }) * travelY,
				// Shifting the frame exposes the background at the edges unless the
				// clip is scaled up enough to cover the travel on both sides.
				scale: 1 + amount * MAX_SHAKE_TRAVEL * 2,
			}),
			incoming: side({
				opacity: progress,
				offsetX: jitter({ progress, seed: 13 }) * travelX,
				offsetY: jitter({ progress, seed: 19 }) * travelY,
				scale: 1 + amount * MAX_SHAKE_TRAVEL * 2,
			}),
		};
	},
};

const whipPan: TransitionDefinition = {
	type: "whip-pan",
	name: "Whip pan",
	category: "camera",
	keywords: ["whip", "pan", "swipe", "fast", "motion"],
	defaultDuration: DEFAULT_TRANSITION_DURATION,
	params: [INTENSITY_PARAM],
	resolve: ({ progress, params, width }) => {
		const amount = readIntensity({ value: params.intensity });
		const eased = smoothstep({ progress });
		const sigma = blurSigma({ amount: amount * triangle({ progress }), width });
		return {
			outgoing: side({
				offsetX: eased * width,
				blurSigma: sigma,
			}),
			incoming: side({
				offsetX: -(1 - eased) * width,
				blurSigma: sigma,
			}),
		};
	},
};

export const CAMERA_TRANSITIONS: TransitionDefinition[] = [
	zoomIn,
	zoomOut,
	spin,
	blur,
	shake,
	whipPan,
];
