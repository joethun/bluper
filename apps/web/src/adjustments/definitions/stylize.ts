import type {
	AdjustmentContribution,
	AdjustmentDefinition,
} from "@/adjustments/types";
import { ApertureIcon } from "lucide-react";
import { isNeutral, readAmount, unsignedParam } from "./shared";

const VIGNETTE_RADIUS = 0.55;
const MAX_SHARPEN_RADIUS_PX = 2.5;
const MAX_GRAIN_SIZE_PX = 2;

export const stylizeAdjustment: AdjustmentDefinition = {
	type: "stylize",
	name: "Stylize",
	description: "Sharpen, vignette and grain.",
	icon: ApertureIcon,
	keywords: ["sharpen", "clarity", "vignette", "grain", "film"],
	params: [
		unsignedParam({ key: "sharpen", label: "Sharpen" }),
		unsignedParam({ key: "vignette", label: "Vignette" }),
		unsignedParam({ key: "grain", label: "Grain" }),
	],
	resolve: ({ params }) => {
		const contribution: AdjustmentContribution = { filters: [], overlays: [] };

		const sharpen = readAmount({ value: params.sharpen });
		if (!isNeutral({ amount: sharpen })) {
			contribution.overlays.push({
				kind: "highPass",
				amount: sharpen,
				radius: 0.5 + sharpen * MAX_SHARPEN_RADIUS_PX,
			});
		}

		const vignette = readAmount({ value: params.vignette });
		if (!isNeutral({ amount: vignette })) {
			contribution.overlays.push({
				kind: "vignette",
				amount: vignette,
				radius: VIGNETTE_RADIUS,
			});
		}

		const grain = readAmount({ value: params.grain });
		if (!isNeutral({ amount: grain })) {
			contribution.overlays.push({
				kind: "grain",
				amount: grain,
				size: 1 + grain * MAX_GRAIN_SIZE_PX,
			});
		}

		return contribution;
	},
};
