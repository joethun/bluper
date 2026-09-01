import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";
import {
	CORNER_RADIUS_PARAM,
	FILL_PARAM,
	STROKE_ALIGN_PARAM,
	STROKE_COLOR_PARAM,
	STROKE_WIDTH_PARAM,
} from "./shared";

export const rectangleGraphicDefinition: GraphicDefinition = {
	id: "rectangle",
	name: "Rectangle",
	keywords: ["rectangle", "square", "box"],
	params: [
		FILL_PARAM,
		CORNER_RADIUS_PARAM,
		STROKE_COLOR_PARAM,
		STROKE_WIDTH_PARAM,
		STROKE_ALIGN_PARAM,
	],
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "rectangle", ctx, params, width, height });
	},
};
