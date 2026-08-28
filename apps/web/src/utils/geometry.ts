import {
	exceedsDragThresholdValue as _exceedsDragThresholdValue,
	dimensionToAspectRatioValue as _dimensionToAspectRatioValue,
} from "bluper-wasm";

/**
 * Plane geometry. Owned by `editor-core::math::geometry`.
 *
 * `Point` stays here because it is a type: it describes what the callers pass,
 * and nothing crosses the bridge to produce one.
 *
 * The rotation helpers are not re-exported. They exist in
 * `editor-core::math::geometry`, where the shape masks call them directly;
 * every TypeScript caller they used to have now asks Rust for a whole outline
 * instead, so a wrapper here would be a bridge crossing with nothing on the
 * other side of it.
 */

export interface Point {
	readonly x: number;
	readonly y: number;
}

export function exceedsDragThreshold({
	current,
	origin,
	threshold,
}: {
	current: Point;
	origin: Point;
	threshold: number;
}): boolean {
	return _exceedsDragThresholdValue({
		current: { x: current.x, y: current.y },
		origin: { x: origin.x, y: origin.y },
		threshold,
	});
}

export function dimensionToAspectRatio({
	width,
	height,
}: {
	width: number;
	height: number;
}): string {
	return _dimensionToAspectRatioValue({ width, height });
}
