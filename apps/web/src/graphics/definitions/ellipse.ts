import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";
import {
	FILL_PARAM,
	STROKE_ALIGN_PARAM,
	STROKE_COLOR_PARAM,
	STROKE_WIDTH_PARAM,
} from "./shared";

export const ellipseGraphicDefinition: GraphicDefinition = {
	id: "ellipse",
	name: "Ellipse",
	keywords: ["ellipse", "circle", "oval"],
	params: [
		FILL_PARAM,
		STROKE_COLOR_PARAM,
		STROKE_WIDTH_PARAM,
		STROKE_ALIGN_PARAM,
	],
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "ellipse", ctx, params, width, height });
	},
};
