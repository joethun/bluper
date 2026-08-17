import type {
	AdjustmentContribution,
	AdjustmentDefinition,
} from "@/adjustments/types";
import { ContrastIcon } from "lucide-react";
import {
	formatFilterNumber,
	isNeutral,
	readAmount,
	signedParam,
} from "./shared";

const SHADOW_CONTRAST_RANGE = 0.5;
const HIGHLIGHT_STRENGTH = 0.55;

/**
 * Shadows move without touching the whites by pairing a contrast change with the
 * exact brightness that puts white back where it was. `contrast()` pivots around
 * mid-grey, so softening it lifts black towards grey and pulls white down; the
 * following `brightness()` restores white, leaving a clean shadow lift.
 */
function shadowFilters({ amount }: { amount: number }): string[] {
	const contrast = 1 - amount * SHADOW_CONTRAST_RANGE;
	const whiteAfterContrast = 0.5 + 0.5 * contrast;
	const brightness = 1 / whiteAfterContrast;

	return [
		`contrast(${formatFilterNumber({ value: contrast })})`,
		`brightness(${formatFilterNumber({ value: brightness })})`,
	];
}

export const lightAdjustment: AdjustmentDefinition = {
	type: "light",
	name: "Light",
	description: "Recover highlights and open up shadows.",
	icon: ContrastIcon,
	keywords: ["highlights", "shadows", "blacks", "whites", "tone", "light"],
	params: [
		signedParam({ key: "highlights", label: "Highlights" }),
		signedParam({ key: "shadows", label: "Shadows" }),
	],
	resolve: ({ params }) => {
		const contribution: AdjustmentContribution = { filters: [], overlays: [] };

		const shadows = readAmount({ value: params.shadows });
		if (!isNeutral({ amount: shadows })) {
			contribution.filters.push(...shadowFilters({ amount: shadows }));
		}

		const highlights = readAmount({ value: params.highlights });
		if (!isNeutral({ amount: highlights })) {
			// Blending the layer with itself: `screen` blooms the bright end,
			// `multiply` rolls it off. Both leave near-black almost untouched, which
			// is what keeps this from doubling as a brightness slider.
			contribution.overlays.push({
				kind: "toneCurve",
				compositeOperation: highlights > 0 ? "screen" : "multiply",
				alpha: Math.abs(highlights) * HIGHLIGHT_STRENGTH,
			});
		}

		return contribution;
	},
};
