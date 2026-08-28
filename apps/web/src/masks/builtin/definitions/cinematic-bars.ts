import type { MaskDefinition } from "@/masks/types";
import {
	BOX_LIKE_MASK_PARAMS,
	buildBoxMaskInteraction,
	computeBoxMaskParamUpdate,
} from "../box-like";
import {
	buildShapeMaskOverlayPath,
	buildShapeMaskPath,
	getDefaultCinematicBarsMaskParams,
} from "../shapes";

export const cinematicBarsMaskDefinition: MaskDefinition<"cinematic-bars"> = {
	type: "cinematic-bars",
	name: "Cinematic Bars",
	features: {
		hasPosition: true,
		hasRotation: true,
		sizeMode: "height-only",
	},
	params: BOX_LIKE_MASK_PARAMS,
	interaction: buildBoxMaskInteraction({
		sizeMode: "height-only",
		buildOverlayPath({ width, height }) {
			return buildShapeMaskOverlayPath({ shape: "cinematic-bars", width, height });
		},
	}),
	buildDefault(context) {
		return {
			type: "cinematic-bars",
			params: getDefaultCinematicBarsMaskParams(context),
		};
	},
	computeParamUpdate: computeBoxMaskParamUpdate,
	renderer: {
		body: {
			kind: "fillPath",
			buildPath({ resolvedParams, width, height }) {
				return buildShapeMaskPath({
					shape: "cinematic-bars",
					params: resolvedParams,
					width,
					height,
				});
			},
		},
		stroke: {
			kind: "strokeFromPath",
			buildStrokePath({ resolvedParams, width, height }) {
				return buildShapeMaskPath({
					shape: "cinematic-bars",
					params: resolvedParams,
					width,
					height,
					outline: "stroke",
				});
			},
		},
	},
};
