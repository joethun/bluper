import type { ParamValues } from "@/params";

/**
 * The shapes the panel offers, which are not the same list as the definitions
 * they are built on. A definition is a parametric primitive — `polygon` draws
 * any regular polygon from three sides to twelve — but nobody looking for a
 * triangle scans a grid for "Polygon" and then counts sides, so every shape a
 * user would name is its own tile and carries the params that make it that
 * shape. All of them stay editable afterwards from the Graphic section of the
 * properties panel, which is where the sides themselves live.
 *
 * Pentagon is the polygon's own default rather than an override, and is why
 * there is no generic "Polygon" tile: it would draw the same picture.
 */
export interface ShapePreset {
	id: string;
	name: string;
	definitionId: string;
	params?: Partial<ParamValues>;
}

export const SHAPE_PRESETS: readonly ShapePreset[] = [
	{ id: "rectangle", name: "Rectangle", definitionId: "rectangle" },
	{ id: "ellipse", name: "Ellipse", definitionId: "ellipse" },
	{
		id: "triangle",
		name: "Triangle",
		definitionId: "polygon",
		params: { sides: 3 },
	},
	{
		id: "diamond",
		name: "Diamond",
		definitionId: "polygon",
		params: { sides: 4 },
	},
	{ id: "pentagon", name: "Pentagon", definitionId: "polygon" },
	{
		id: "hexagon",
		name: "Hexagon",
		definitionId: "polygon",
		params: { sides: 6 },
	},
	{ id: "star", name: "Star", definitionId: "star" },
];
