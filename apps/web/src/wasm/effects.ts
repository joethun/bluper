import { unitSize as _unitSize } from "bluper-wasm";

/**
 * Effect-side helpers, now owned by `editor-core::effects::canvas`.
 *
 * Drawing itself still happens on the canvas context in TypeScript — the
 * bridge has nothing to add there. The small numerics the effects call each
 * frame live here so both implementations agree on the same answer.
 */

export function unitSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): number {
	return _unitSize({ width, height });
}
