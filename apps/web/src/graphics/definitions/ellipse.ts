import type { ParamDefinition } from "@/params";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";

interface EllipseParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
}

const ELLIPSE_PARAMS: ParamDefinition<keyof EllipseParams & string>[] = [
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
];

export const ellipseGraphicDefinition: GraphicDefinition = {
	id: "ellipse",
	name: "Ellipse",
	keywords: ["ellipse", "circle", "oval"],
	params: ELLIPSE_PARAMS,
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "ellipse", ctx, params, width, height });
	},
};
