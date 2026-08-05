import { drawSource, fillLayer, keepSourceAlpha, unitSize } from "../canvas";
import { drawTiled, grainTile } from "../noise";
import type { EffectDefinition } from "../types";
import { amountParam, numberValue } from "./shared";

export const colorShiftEffect: EffectDefinition = {
	type: "color-shift",
	name: "Color shift",
	keywords: ["colour", "color", "shift", "hue", "grade", "tint"],
	params: [
		{
			key: "hue",
			label: "Hue",
			type: "number",
			default: 120,
			min: 0,
			max: 360,
			step: 1,
			suffix: "°",
			control: "slider",
			trackGradient:
				"linear-gradient(to right, #ff2f6a, #ffd12f, #22e06a, #2f9dff, #a12fff, #ff2f6a)",
		},
		amountParam({ label: "Mix", value: 0.8 }),
	],
	paint: ({ ctx, source, width, height, params }) => {
		const hue = numberValue({ params, key: "hue", fallback: 120 });
		const amount = numberValue({ params, key: "amount", fallback: 0.8 });

		// The shifted copy is laid over the untouched one, so Mix is a real blend
		// between the two grades rather than a weaker rotation.
		drawSource({ ctx, source, width, height });
		drawSource({
			ctx,
			source,
			width,
			height,
			filter: `hue-rotate(${Math.round(hue)}deg) saturate(1.15)`,
			alpha: amount,
		});
	},
};

export const filmicEffect: EffectDefinition = {
	type: "filmic",
	name: "Filmic",
	keywords: ["film", "filmic", "grain", "halation", "cinema", "stock"],
	params: [
		amountParam({ label: "Strength", value: 0.6 }),
		{
			key: "grain",
			label: "Grain",
			type: "number",
			default: 0.35,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
	],
	paint: ({ ctx, source, width, height, params }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.6 });
		const grain = numberValue({ params, key: "grain", fallback: 0.35 });
		const unit = unitSize({ width, height });

		drawSource({
			ctx,
			source,
			width,
			height,
			filter: `contrast(${1 + 0.16 * amount}) saturate(${
				1 - 0.15 * amount
			}) sepia(${(0.16 * amount).toFixed(3)})`,
		});
		// Halation: the highlights bleed into what surrounds them, the way a bright
		// window blooms through a film emulsion.
		drawSource({
			ctx,
			source,
			width,
			height,
			filter: `brightness(1.45) contrast(2.1) blur(${(unit * 9).toFixed(2)}px)`,
			alpha: 0.3 * amount,
			composite: "lighter",
		});
		// Lifted, slightly warm blacks, which is the part of a print look that a
		// contrast curve alone cannot give.
		fillLayer({
			ctx,
			color: "#2b2118",
			width,
			height,
			alpha: 0.16 * amount,
			composite: "lighten",
		});
		if (grain > 0) {
			drawTiled({
				ctx,
				tile: grainTile({ cellSize: Math.max(1, unit * 1.5), seed: 5 }),
				width,
				height,
				alpha: 0.3 * grain,
				composite: "overlay",
			});
		}

		keepSourceAlpha({ ctx, source, width, height });
	},
};
