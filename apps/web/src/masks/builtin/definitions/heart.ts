import type { MaskDefinition } from "@/masks/types";
import {
	BOX_LIKE_MASK_PARAMS,
	buildBoxMaskInteraction,
	computeBoxMaskParamUpdate,
	getDefaultSquareMaskParams,
} from "../box-like";
import {
	buildShapeMaskOverlayPath,
	buildShapeMaskPath,
} from "../shapes";

export const heartMaskDefinition: MaskDefinition<"heart"> = {
	type: "heart",
	name: "Heart",
	features: {
		hasPosition: true,
		hasRotation: true,
		sizeMode: "width-height",
	},
	params: BOX_LIKE_MASK_PARAMS,
	interaction: buildBoxMaskInteraction({
		sizeMode: "width-height",
		buildOverlayPath({ width, height }) {
			return buildShapeMaskOverlayPath({ shape: "heart", width, height });
		},
	}),
	buildDefault(context) {
		return {
			type: "heart",
			params: getDefaultSquareMaskParams(context),
		};
	},
	computeParamUpdate: computeBoxMaskParamUpdate,
	renderer: {
		body: {
			kind: "fillPath",
			buildPath({ resolvedParams, width, height }) {
				return buildShapeMaskPath({
					shape: "heart",
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
					shape: "heart",
					params: resolvedParams,
					width,
					height,
					outline: "stroke",
				});
			},
		},
	},
};
