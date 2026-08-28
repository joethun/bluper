import { drawSource, unitSize } from "../canvas";
import type { EffectDefinition } from "../types";
import {
	amountParam,
	booleanValue,
	cyclePhase,
	easeInOutCubic,
	easeOutCubic,
	motionParams,
	numberValue,
	selectParam,
	speedParam,
} from "./shared";

const PULSE_PERIOD_SECONDS = 1.4;

export const pulseEffect: EffectDefinition = {
	type: "pulse",
	name: "Pulse",
	keywords: ["pulse", "beat", "punch", "zoom", "snap", "push", "throb"],
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
			period: PULSE_PERIOD_SECONDS,
		});
		// A fast push in, then a slower settle back out. The shape of the move is
		// what makes it land as a hit rather than a drift, and the blur that rides
		// along with it is what sells the speed of the push.
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
	// Driven by `progress` rather than `time`, but the compositor's texture cache
	// does not care which: without this the layer would be painted once at the
	// first frame and then held, which is exactly what happened to this effect on
	// a still image, where nothing else forced a repaint.
	animated: true,
	params: [
		speedParam(),
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
		const speed = numberValue({ params, key: "speed", fallback: 1 });
		const isZoomingIn = params.direction !== "out";
		const travel = 0.35 * amount;
		// The move is driven by the clip's own progress rather than a cycle, so at
		// speed 1 it lands exactly on the last frame however long the clip is
		// trimmed to. Faster than that it arrives early and holds there; slower and
		// it is still travelling when the clip ends.
		const travelled = Math.min(1, progress * speed);
		const scale = isZoomingIn
			? 1 + travel * travelled
			: 1 + travel * (1 - travelled);

		drawSource({ ctx, source, width, height, scale });
	},
};
