import type { ParamDefinition } from "@/params";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";

interface RectangleParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	cornerRadius: number;
}

const RECTANGLE_PARAMS: ParamDefinition<keyof RectangleParams & string>[] = [
	{
		key: "fill",
		label: "Fill",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#000000",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 0,
		min: 0,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	STROKE_ALIGN_PARAM,
	{
		key: "cornerRadius",
		label: "Corner radius",
		type: "number",
		default: 0,
		min: 0,
		max: 50,
		step: 1,
		shortLabel: "R",
	},
];

export const rectangleGraphicDefinition: GraphicDefinition = {
	id: "rectangle",
	name: "Rectangle",
	keywords: ["rectangle", "square", "box"],
	params: RECTANGLE_PARAMS,
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "rectangle", ctx, params, width, height });
	},
};
