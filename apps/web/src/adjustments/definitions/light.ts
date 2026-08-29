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

/**
 * The dark end of the tone range. This used to carry a Highlights slider as
 * well, which blended the layer with itself under `screen` or `multiply`; it is
 * gone, along with the tone-curve overlay pass that was there to serve it.
 */
export const lightAdjustment: AdjustmentDefinition = {
	type: "light",
	name: "Light",
	description: "Open up shadows without crushing the whites.",
	icon: ContrastIcon,
	keywords: ["shadows", "blacks", "tone", "light"],
	params: [signedParam({ key: "shadows", label: "Shadows" })],
	resolve: ({ params }) => {
		const contribution: AdjustmentContribution = { filters: [], overlays: [] };

		const shadows = readAmount({ value: params.shadows });
		if (!isNeutral({ amount: shadows })) {
			contribution.filters.push(...shadowFilters({ amount: shadows }));
		}

		return contribution;
	},
};
