import type {
	AdjustmentContribution,
	AdjustmentDefinition,
} from "@/adjustments/types";
import { PaletteIcon } from "lucide-react";
import {
	formatFilterNumber,
	isNeutral,
	readAmount,
	signedParam,
} from "./shared";

const WARM_COLOR = "#ff7a2f";
const COOL_COLOR = "#2f9dff";
const MAGENTA_COLOR = "#ff2fe0";
const GREEN_COLOR = "#43ff2f";
const TEMPERATURE_STRENGTH = 0.45;
const TINT_STRENGTH = 0.3;
const MAX_HUE_DEGREES = 180;

export const colorAdjustment: AdjustmentDefinition = {
	type: "color",
	name: "Color",
	description: "White balance and hue.",
	icon: PaletteIcon,
	keywords: ["temperature", "warmth", "white balance", "tint", "hue", "color"],
	params: [
		signedParam({ key: "temperature", label: "Temperature" }),
		signedParam({ key: "tint", label: "Tint" }),
		signedParam({ key: "hue", label: "Hue" }),
	],
	resolve: ({ params }) => {
		const contribution: AdjustmentContribution = { filters: [], overlays: [] };

		const hue = readAmount({ value: params.hue });
		if (!isNeutral({ amount: hue })) {
			contribution.filters.push(
				`hue-rotate(${formatFilterNumber({
					value: hue * MAX_HUE_DEGREES,
				})}deg)`,
			);
		}

		// White balance is a wash rather than a filter: `soft-light` warms or cools
		// midtones while leaving clipped whites and blacks where they are, which is
		// how a temperature slider is expected to behave.
		const temperature = readAmount({ value: params.temperature });
		if (!isNeutral({ amount: temperature })) {
			contribution.overlays.push({
				kind: "wash",
				color: temperature > 0 ? WARM_COLOR : COOL_COLOR,
				alpha: Math.abs(temperature) * TEMPERATURE_STRENGTH,
				compositeOperation: "soft-light",
			});
		}

		const tint = readAmount({ value: params.tint });
		if (!isNeutral({ amount: tint })) {
			contribution.overlays.push({
				kind: "wash",
				color: tint > 0 ? MAGENTA_COLOR : GREEN_COLOR,
				alpha: Math.abs(tint) * TINT_STRENGTH,
				compositeOperation: "soft-light",
			});
		}

		return contribution;
	},
};
