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

export const ellipseMaskDefinition: MaskDefinition<"ellipse"> = {
	type: "ellipse",
	name: "Ellipse",
	features: {
		hasPosition: true,
		hasRotation: true,
		sizeMode: "width-height",
	},
	params: BOX_LIKE_MASK_PARAMS,
	interaction: buildBoxMaskInteraction({
		sizeMode: "width-height",
		buildOverlayPath({ width, height }) {
			return buildShapeMaskOverlayPath({ shape: "ellipse", width, height });
		},
	}),
	buildDefault(context) {
		return {
			type: "ellipse",
			params: getDefaultSquareMaskParams(context),
		};
	},
	computeParamUpdate: computeBoxMaskParamUpdate,
	renderer: {
		body: {
			kind: "fillPath",
			buildPath({ resolvedParams, width, height }) {
				return buildShapeMaskPath({
					shape: "ellipse",
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
					shape: "ellipse",
					params: resolvedParams,
					width,
					height,
					outline: "stroke",
				});
			},
		},
	},
};
