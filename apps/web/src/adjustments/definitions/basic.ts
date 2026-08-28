import type {
	AdjustmentContribution,
	AdjustmentDefinition,
} from "@/adjustments/types";
import { SunIcon } from "lucide-react";
import {
	formatFilterNumber,
	isNeutral,
	readAmount,
	signedParam,
} from "./shared";

/** ±80% exposure at the ends of the slider, so -100 dims without going black. */
const BRIGHTNESS_RANGE = 0.8;
const CONTRAST_RANGE = 1;
const SATURATION_RANGE = 1;

export const basicAdjustment: AdjustmentDefinition = {
	type: "basic",
	name: "Basic",
	description: "Exposure, contrast and saturation.",
	icon: SunIcon,
	keywords: ["brightness", "exposure", "contrast", "saturation", "vibrance"],
	params: [
		signedParam({ key: "brightness", label: "Brightness" }),
		signedParam({ key: "contrast", label: "Contrast" }),
		signedParam({ key: "saturation", label: "Saturation" }),
	],
	resolve: ({ params }) => {
		const contribution: AdjustmentContribution = { filters: [], overlays: [] };

		const brightness = readAmount({ value: params.brightness });
		if (!isNeutral({ amount: brightness })) {
			contribution.filters.push(
				`brightness(${formatFilterNumber({
					value: 1 + brightness * BRIGHTNESS_RANGE,
				})})`,
			);
		}

		const contrast = readAmount({ value: params.contrast });
		if (!isNeutral({ amount: contrast })) {
			contribution.filters.push(
				`contrast(${formatFilterNumber({
					value: 1 + contrast * CONTRAST_RANGE,
				})})`,
			);
		}

		const saturation = readAmount({ value: params.saturation });
		if (!isNeutral({ amount: saturation })) {
			contribution.filters.push(
				`saturate(${formatFilterNumber({
					value: 1 + saturation * SATURATION_RANGE,
				})})`,
			);
		}

		return contribution;
	},
};
