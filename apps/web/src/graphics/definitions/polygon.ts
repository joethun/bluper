import type { ParamDefinition } from "@/params";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";

interface PolygonParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	sides: number;
	cornerRadius: number;
}

const POLYGON_PARAMS: ParamDefinition<keyof PolygonParams & string>[] = [
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
		key: "sides",
		label: "Sides",
		type: "number",
		default: 5,
		min: 3,
		max: 12,
		step: 1,
		shortLabel: "S",
	},
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

export const polygonGraphicDefinition: GraphicDefinition = {
	id: "polygon",
	name: "Polygon",
	keywords: ["polygon", "triangle", "pentagon", "hexagon", "diamond"],
	params: POLYGON_PARAMS,
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "polygon", ctx, params, width, height });
	},
};
