import {
	buildGraphicShapeOutline as _buildGraphicShapeOutline,
	type GraphicOutlineCommand,
	type GraphicShapeKind,
	type GraphicShapeOptions,
} from "bluper-wasm";
import type { ParamValues } from "@/params";
import { applyAlignedStroke } from "./stroke";
import type { GraphicStrokeAlign } from "./definitions/shared";

/**
 * The built-in graphics' outlines. Owned by `editor-core::graphics::shapes`.
 *
 * Rust works out the vertices, the radius clamps and the corner tangents; this
 * replays them into a `Path2D`, which is a browser object. `arcTo` and
 * `roundRect` stay browser calls for the same reason the ellipse does — the
 * canvas already has that construction, and rewriting it would move the
 * rendering by a fraction of a pixel for nothing.
 */

export type { GraphicShapeKind };

function replay(commands: GraphicOutlineCommand[]): Path2D {
	const path = new Path2D();

	for (const command of commands) {
		switch (command.kind) {
			case "moveTo":
				path.moveTo(command.x, command.y);
				break;
			case "lineTo":
				path.lineTo(command.x, command.y);
				break;
			case "arcTo":
				path.arcTo(
					command.x1,
					command.y1,
					command.x2,
					command.y2,
					command.radius,
				);
				break;
			case "ellipse":
				path.ellipse(
					command.centerX,
					command.centerY,
					command.radiusX,
					command.radiusY,
					0,
					0,
					Math.PI * 2,
				);
				break;
			case "roundRect":
				path.roundRect(
					command.x,
					command.y,
					command.width,
					command.height,
					command.radius,
				);
				break;
			case "closePath":
				path.closePath();
				break;
		}
	}

	return path;
}

function buildGraphicShapePath(options: GraphicShapeOptions): Path2D {
	return replay(_buildGraphicShapeOutline(options).commands);
}

/**
 * A param the shape may not define at all. Absent stays absent rather than
 * becoming zero: Rust holds the definition's default, so only what the user
 * actually set is sent.
 */
function readNumber({
	params,
	key,
}: {
	params: ParamValues;
	key: string;
}): number | undefined {
	const value = params[key];
	return value === undefined ? undefined : Number(value);
}

/**
 * Draws one of the built-in shapes, filled and stroked.
 *
 * Every graphic definition's `render` is this call: they differ only in which
 * shape they name and which params the panel offers, both of which are
 * declarations rather than code.
 */
export function renderGraphicShape({
	shape,
	ctx,
	params,
	width,
	height,
}: {
	shape: GraphicShapeKind;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	params: ParamValues;
	width: number;
	height: number;
}): void {
	const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const strokeAlign = (params.strokeAlign ?? "center") as GraphicStrokeAlign;
	const path = buildGraphicShapePath({
		shape,
		width,
		height,
		strokeWidth,
		strokeAlign,
		cornerRadius: readNumber({ params, key: "cornerRadius" }),
		sides: readNumber({ params, key: "sides" }),
		points: readNumber({ params, key: "points" }),
		depth: readNumber({ params, key: "depth" }),
	});

	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = String(params.fill ?? "#ffffff");
	ctx.fill(path);

	applyAlignedStroke({
		ctx,
		path,
		strokeWidth,
		strokeAlign,
		strokeColor: String(params.stroke ?? "#000000"),
	});
}
