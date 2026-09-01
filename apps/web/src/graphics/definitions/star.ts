import type { ParamDefinition } from "@/params";
import type { GraphicDefinition } from "../types";
import { renderGraphicShape } from "../shapes";
import {
	FILL_PARAM,
	STROKE_ALIGN_PARAM,
	STROKE_COLOR_PARAM,
	STROKE_WIDTH_PARAM,
} from "./shared";

const POINTS_PARAM: ParamDefinition<"points"> = {
	key: "points",
	label: "Points",
	type: "number",
	default: 5,
	min: 3,
	max: 12,
	step: 1,
	control: "slider",
};

/**
 * How far the inner vertices sit from the centre, as a percentage of the outer
 * radius — the stored number is already that percentage, so it carries a suffix
 * rather than the corner radius's rescaling.
 */
const DEPTH_PARAM: ParamDefinition<"depth"> = {
	key: "depth",
	label: "Depth",
	type: "number",
	default: 45,
	min: 1,
	max: 99,
	step: 1,
	suffix: "%",
	control: "slider",
};

export const starGraphicDefinition: GraphicDefinition = {
	id: "star",
	name: "Star",
	keywords: ["star", "sparkle", "burst"],
	params: [
		FILL_PARAM,
		POINTS_PARAM,
		DEPTH_PARAM,
		STROKE_COLOR_PARAM,
		STROKE_WIDTH_PARAM,
		STROKE_ALIGN_PARAM,
	],
	render({ ctx, params, width, height }) {
		renderGraphicShape({ shape: "star", ctx, params, width, height });
	},
};
