import { drawSource, unitSize } from "../canvas";
import type { EffectDefinition } from "../types";
import {
	amountParam,
	beatEnvelope,
	booleanValue,
	cyclePhase,
	easeInOutCubic,
	easeOutCubic,
	motionParams,
	numberValue,
	selectParam,
} from "./shared";

const PULSE_PERIOD_SECONDS = 0.5;
const CRASH_ZOOM_PERIOD_SECONDS = 1.4;

export const pulseEffect: EffectDefinition = {
	type: "pulse",
	name: "Pulse",
	keywords: ["pulse", "beat", "bounce", "throb"],
	animated: true,
	params: motionParams(),
	paint: ({ ctx, source, width, height, params, time }) => {
		const speed = numberValue({ params, key: "speed", fallback: 1 });
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const loop = booleanValue({ params, key: "loop", fallback: true });
		const beat = beatEnvelope({
			phase: cyclePhase({
				time,
				speed,
				loop,
				period: PULSE_PERIOD_SECONDS,
			}),
		});

		drawSource({
			ctx,
			source,
			width,
			height,
			scale: 1 + 0.14 * amount * beat,
			filter: `brightness(${1 + 0.32 * amount * beat}) saturate(${
				1 + 0.3 * amount * beat
			})`,
		});
	},
};

export const crashZoomEffect: EffectDefinition = {
	type: "crash-zoom",
	name: "Crash zoom",
	keywords: ["crash", "zoom", "punch", "snap", "push"],
	animated: true,
	params: motionParams({ amountLabel: "Punch" }),
	paint: ({ ctx, source, width, height, params, time }) => {
		const speed = numberValue({ params, key: "speed", fallback: 1 });
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const loop = booleanValue({ params, key: "loop", fallback: true });
		const phase = cyclePhase({
			time,
			speed,
			loop,
			period: CRASH_ZOOM_PERIOD_SECONDS,
		});
		// A fast push in, then a slower settle back out. The shape of the move is
		// what makes it read as a crash rather than a slow zoom.
		const attack = 0.3;
		const punch =
			phase < attack
				? easeOutCubic({ t: phase / attack })
				: 1 - easeInOutCubic({ t: (phase - attack) / (1 - attack) });
		const unit = unitSize({ width, height });

		drawSource({
			ctx,
			source,
			width,
			height,
			scale: 1 + 0.8 * amount * punch,
			filter: `blur(${(2.5 * amount * punch * unit).toFixed(2)}px)`,
		});
	},
};

export const slowZoomEffect: EffectDefinition = {
	type: "slow-zoom",
	name: "Slow zoom",
	keywords: ["slow", "zoom", "ken burns", "drift", "push"],
	animated: true,
	params: [
		amountParam({ label: "Distance" }),
		selectParam({
			key: "direction",
			label: "Direction",
			value: "in",
			options: [
				{ value: "in", label: "In" },
				{ value: "out", label: "Out" },
			],
		}),
	],
	paint: ({ ctx, source, width, height, params, progress }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const isZoomingIn = params.direction !== "out";
		const travel = 0.35 * amount;
		// The move is driven by the clip's own progress rather than a cycle, so it
		// lands exactly at the last frame however long the clip is trimmed to.
		const scale = isZoomingIn
			? 1 + travel * progress
			: 1 + travel * (1 - progress);

		drawSource({ ctx, source, width, height, scale });
	},
};

