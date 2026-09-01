import type { ParamDefinition } from "@/params";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";
import {
	CORNER_RADIUS_PARAM,
	FILL_PARAM,
	STROKE_ALIGN_PARAM,
	STROKE_COLOR_PARAM,
	STROKE_WIDTH_PARAM,
} from "./shared";

const SIDES_PARAM: ParamDefinition<"sides"> = {
	key: "sides",
	label: "Sides",
	type: "number",
	default: 5,
	min: 3,
	max: 12,
	step: 1,
	control: "slider",
};

export const polygonGraphicDefinition: GraphicDefinition = {
	id: "polygon",
	name: "Polygon",
	keywords: ["polygon", "triangle", "pentagon", "hexagon", "diamond"],
	params: [
		FILL_PARAM,
		SIDES_PARAM,
		CORNER_RADIUS_PARAM,
		STROKE_COLOR_PARAM,
		STROKE_WIDTH_PARAM,
		STROKE_ALIGN_PARAM,
	],
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "polygon", ctx, params, width, height });
	},
};
