import {
	borrowSurface,
	drawChannelSplit,
	drawSource,
	keepSourceAlpha,
	SURFACE_KEYS,
	unitSize,
} from "../canvas";
import { drawTiled, grainTile, hashNoise, scanlineTile } from "../noise";
import type { EffectDefinition } from "../types";
import {
	amountParam,
	booleanValue,
	cyclePhase,
	motionParams,
	numberValue,
} from "./shared";

const VHS_PERIOD_SECONDS = 1;

export const vhsEffect: EffectDefinition = {
	type: "vhs",
	name: "VHS",
	keywords: ["vhs", "tape", "retro", "analog", "scanlines", "tracking"],
	animated: true,
	params: motionParams(),
	paint: ({ ctx, source, width, height, params, time }) => {
		const speed = numberValue({ params, key: "speed", fallback: 1 });
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const loop = booleanValue({ params, key: "loop", fallback: true });
		const unit = unitSize({ width, height });
		const phase = cyclePhase({
			time,
			speed,
			loop,
			period: VHS_PERIOD_SECONDS,
		});
		// Tracking error steps rather than slides: the head either finds the line or
		// it does not, so the jitter is sampled per tape "field" instead of per frame.
		const field = Math.floor(Math.max(0, time) * speed * 12);
		const jitter =
			(hashNoise({ x: field, y: 1, seed: 91 }) - 0.5) * amount * unit * 14;

		const stage = borrowSurface({ key: SURFACE_KEYS.stage, width, height });
		drawSource({
			ctx: stage.ctx,
			source,
			width,
			height,
			translateY: jitter,
			filter: `saturate(${1 + 0.35 * amount}) contrast(${1 + 0.12 * amount})`,
		});

		const fringe = Math.max(1, amount * unit * 9);
		drawChannelSplit({
			ctx,
			source: stage.canvas,
			width,
			height,
			red: { x: -fringe, y: 0 },
			blue: { x: fringe, y: 0 },
		});

		drawTiled({
			ctx,
			tile: scanlineTile({
				lineHeight: Math.max(1, Math.round(unit * 2)),
				gapHeight: Math.max(1, Math.round(unit * 3)),
				color: "rgba(0,0,0,1)",
			}),
			width,
			height,
			alpha: 0.35 * amount,
			composite: "multiply",
		});
		drawTiled({
			ctx,
			tile: grainTile({ cellSize: Math.max(1, unit * 2), seed: 17 }),
			width,
			height,
			alpha: 0.16 * amount,
			composite: "overlay",
			offsetY: Math.round(phase * height),
		});

		keepSourceAlpha({ ctx, source: stage.canvas, width, height });
	},
};

export const chromaticAberrationEffect: EffectDefinition = {
	type: "chromatic-aberration",
	name: "Chromatic aberration",
	keywords: ["chromatic", "aberration", "fringe", "rgb", "split", "lens"],
	params: [amountParam({ label: "Fringe", value: 0.4 })],
	paint: ({ ctx, source, width, height, params }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.4 });
		const fringe = amount * unitSize({ width, height }) * 12;

		drawChannelSplit({
			ctx,
			source,
			width,
			height,
			red: { x: -fringe, y: -fringe * 0.25 },
			blue: { x: fringe, y: fringe * 0.25 },
		});
		keepSourceAlpha({ ctx, source, width, height });
	},
};

