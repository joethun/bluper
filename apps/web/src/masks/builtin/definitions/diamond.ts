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

export const diamondMaskDefinition: MaskDefinition<"diamond"> = {
	type: "diamond",
	name: "Diamond",
	features: {
		hasPosition: true,
		hasRotation: true,
		sizeMode: "width-height",
	},
	params: BOX_LIKE_MASK_PARAMS,
	interaction: buildBoxMaskInteraction({
		sizeMode: "width-height",
		buildOverlayPath({ width, height }) {
			return buildShapeMaskOverlayPath({ shape: "diamond", width, height });
		},
	}),
	buildDefault(context) {
		return {
			type: "diamond",
			params: getDefaultSquareMaskParams(context),
		};
	},
	computeParamUpdate: computeBoxMaskParamUpdate,
	renderer: {
		body: {
			kind: "fillPath",
			buildPath({ resolvedParams, width, height }) {
				return buildShapeMaskPath({
					shape: "diamond",
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
					shape: "diamond",
					params: resolvedParams,
					width,
					height,
					outline: "stroke",
				});
			},
		},
	},
};
