import type { ParamDefinition } from "@/params";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";

interface StarParams {
	fill: string;
	stroke: string;
	strokeWidth: number;
	strokeAlign: GraphicStrokeAlign;
	points: number;
	depth: number;
}

const STAR_PARAMS: ParamDefinition<keyof StarParams & string>[] = [
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
		key: "points",
		label: "Points",
		type: "number",
		default: 5,
		min: 3,
		max: 12,
		step: 1,
		shortLabel: "P",
	},
	{
		key: "depth",
		label: "Depth",
		type: "number",
		default: 45,
		min: 1,
		max: 99,
		step: 1,
		shortLabel: "D",
	},
];

export const starGraphicDefinition: GraphicDefinition = {
	id: "star",
	name: "Star",
	keywords: ["star", "sparkle", "burst"],
	params: STAR_PARAMS,
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "star", ctx, params, width, height });
	},
};
