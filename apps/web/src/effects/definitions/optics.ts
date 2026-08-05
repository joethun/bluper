import { drawSource, keepSourceAlpha, unitSize } from "../canvas";
import type { EffectDefinition } from "../types";
import { amountParam, numberValue } from "./shared";

export const blurEffect: EffectDefinition = {
	type: "blur",
	name: "Blur",
	keywords: ["blur", "soft", "defocus", "gaussian"],
	params: [amountParam({ label: "Radius", value: 0.4 })],
	paint: ({ ctx, source, width, height, params }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.4 });
		const radius = amount * unitSize({ width, height }) * 45;

		drawSource({
			ctx,
			source,
			width,
			height,
			filter: `blur(${radius.toFixed(2)}px)`,
		});
	},
};

export const blurFillEffect: EffectDefinition = {
	type: "blur-fill",
	name: "Blur fill",
	keywords: ["blur", "fill", "letterbox", "pillarbox", "background", "frame"],
	params: [
		amountParam({ label: "Radius", value: 0.5 }),
		{
			key: "inset",
			label: "Inset",
			type: "number",
			default: 0.2,
			min: 0.02,
			max: 0.6,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
	],
	paint: ({ ctx, source, width, height, params }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const inset = numberValue({ params, key: "inset", fallback: 0.2 });
		const radius = amount * unitSize({ width, height }) * 60;

		// A blurred copy fills the whole frame; the sharp one is pulled in off the
		// edges so the blur shows as a soft border rather than replacing the shot.
		drawSource({
			ctx,
			source,
			width,
			height,
			scale: 1 + inset,
			filter: `blur(${radius.toFixed(2)}px) brightness(0.9)`,
		});
		drawSource({ ctx, source, width, height, scale: 1 - inset });
	},
};

export const glowEffect: EffectDefinition = {
	type: "glow",
	name: "Glow",
	keywords: ["glow", "bloom", "halo", "dreamy", "soft light"],
	params: [
		amountParam({ label: "Strength", value: 0.5 }),
		{
			key: "threshold",
			label: "Threshold",
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.01,
			unit: "percent",
			control: "slider",
		},
	],
	paint: ({ ctx, source, width, height, params }) => {
		const amount = numberValue({ params, key: "amount", fallback: 0.5 });
		const threshold = numberValue({ params, key: "threshold", fallback: 0.5 });
		const unit = unitSize({ width, height });

		drawSource({ ctx, source, width, height });
		// Crushing everything below the threshold to black before blurring is what
		// leaves only the highlights to bloom, rather than lifting the whole frame.
		drawSource({
			ctx,
			source,
			width,
			height,
			filter: `brightness(${(1 - 0.55 * threshold).toFixed(3)}) contrast(${(
				1 + 6 * threshold
			).toFixed(2)}) blur(${(unit * 16).toFixed(2)}px)`,
			alpha: 0.85 * amount,
			composite: "lighter",
		});
		keepSourceAlpha({ ctx, source, width, height });
	},
};

