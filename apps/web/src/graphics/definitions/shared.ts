import type { ParamDefinition } from "@/params";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

/**
 * The params every built-in shape carries, declared once rather than copied into
 * each definition: a shape differs from its neighbours in what it draws, not in
 * having its own idea of what "Fill" means.
 *
 * The bounded numbers are sliders, like every other bounded number in the
 * properties panel — a corner radius or a stroke width is judged against the
 * picture rather than typed, and the field beside the track still takes an exact
 * value.
 */
export const FILL_PARAM: ParamDefinition<"fill"> = {
	key: "fill",
	label: "Fill",
	type: "color",
	default: "#ffffff",
};

export const STROKE_COLOR_PARAM: ParamDefinition<"stroke"> = {
	key: "stroke",
	label: "Color",
	type: "color",
	default: "#000000",
	group: "stroke",
};

export const STROKE_WIDTH_PARAM: ParamDefinition<"strokeWidth"> = {
	key: "strokeWidth",
	label: "Width",
	type: "number",
	default: 0,
	min: 0,
	max: 64,
	step: 1,
	control: "slider",
	group: "stroke",
};

export const STROKE_ALIGN_PARAM: ParamDefinition<"strokeAlign"> = {
	key: "strokeAlign",
	label: "Stroke align",
	type: "select",
	default: "center",
	keyframable: false,
	group: "stroke",
	options: [
		{ value: "inside", label: "Inside" },
		{ value: "center", label: "Center" },
		{ value: "outside", label: "Outside" },
	],
};

/**
 * How round the corners are, as a fraction of the roundest the shape can be:
 * `editor-core::graphics::shapes` reads the stored 0..50 against the largest
 * radius that fits, so a stored 50 is a fully rounded corner. `unit: "percent"`
 * is what puts that on screen as 0..100% while the slider keeps working in the
 * stored range.
 */
export const CORNER_RADIUS_PARAM: ParamDefinition<"cornerRadius"> = {
	key: "cornerRadius",
	label: "Corner radius",
	type: "number",
	default: 0,
	min: 0,
	max: 50,
	step: 1,
	unit: "percent",
	control: "slider",
};
