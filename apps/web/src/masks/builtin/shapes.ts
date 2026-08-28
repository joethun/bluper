import {
	buildMaskShapeOutline as _buildMaskShapeOutline,
	buildMaskShapeOverlayPath as _buildMaskShapeOverlayPath,
	getDefaultCinematicBarsMaskParams as _getDefaultCinematicBarsMaskParams,
	type MaskOutlineCommand,
	type MaskOutlineKind,
	type MaskShapeKind,
} from "bluper-wasm";
import type {
	MaskDefaultContext,
	RectangleMaskParams,
} from "@/masks/types";

/**
 * The built-in shape masks' outlines. Owned by
 * `editor-core::masks::builtin::shapes`.
 *
 * Rust computes where the vertices go; this replays them into a `Path2D`,
 * which is a browser object and stays on this side. Each definition in
 * `definitions/` is left holding its plugin-layer description — the params
 * spec, the feature flags, the renderer's shape — and no geometry.
 */

export type { MaskShapeKind };

function replay(commands: MaskOutlineCommand[]): Path2D {
	const path = new Path2D();

	for (const command of commands) {
		switch (command.kind) {
			case "moveTo":
				path.moveTo(command.x, command.y);
				break;
			case "lineTo":
				path.lineTo(command.x, command.y);
				break;
			case "cubicTo":
				path.bezierCurveTo(
					command.control1.x,
					command.control1.y,
					command.control2.x,
					command.control2.y,
					command.end.x,
					command.end.y,
				);
				break;
			case "ellipse":
				path.ellipse(
					command.centerX,
					command.centerY,
					command.radiusX,
					command.radiusY,
					command.rotationRad,
					0,
					Math.PI * 2,
				);
				break;
			case "closePath":
				path.closePath();
				break;
		}
	}

	return path;
}

export function buildShapeMaskPath({
	shape,
	params,
	width,
	height,
	outline = "body",
}: {
	shape: MaskShapeKind;
	params: RectangleMaskParams;
	width: number;
	height: number;
	outline?: MaskOutlineKind;
}): Path2D {
	return replay(
		_buildMaskShapeOutline({ shape, params, width, height, outline })
			.commands,
	);
}

export function buildShapeMaskOverlayPath({
	shape,
	width,
	height,
}: {
	shape: MaskShapeKind;
	width: number;
	height: number;
}): string {
	return _buildMaskShapeOverlayPath({ shape, width, height });
}

export function getDefaultCinematicBarsMaskParams({
	elementSize,
}: MaskDefaultContext): RectangleMaskParams {
	const result = _getDefaultCinematicBarsMaskParams({
		elementSize: elementSize
			? { width: elementSize.width, height: elementSize.height }
			: undefined,
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result as RectangleMaskParams;
}
