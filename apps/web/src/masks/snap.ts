import type { MaskHandleId } from "@/masks/types";
import type {
	MaskSnapResult,
	RectangleMaskParams,
	SplitMaskParams,
} from "@/masks/types";
import {
	snapBoxMaskInteraction as _snapBoxMaskInteraction,
	snapSplitMaskInteraction as _snapSplitMaskInteraction,
	type PreviewSnapLine,
} from "bluper-wasm";
import type { SnapLine } from "@/wasm/preview-snap";

/**
 * Snap dispatchers for the two built-in mask shapes — rectangle and split. Owned
 * by `editor-core::masks::snap`.
 *
 * The Rust module exposes concrete `MaskBoxSnapResult` and `MaskSplitSnapResult`
 * types because wasm-bindgen cannot bridge a generic; the façade re-projects
 * them into the TS `MaskSnapResult<T>` shape callers expect.
 */

function previewLinesToSnapLines(lines: PreviewSnapLine[]): SnapLine[] {
	return lines.map((line) => ({
		type: line.type,
		position: line.position,
	}));
}

export function snapBoxMaskInteraction({
	handleId,
	startParams,
	proposedParams,
	bounds,
	canvasSize,
	snapThreshold,
}: {
	handleId: MaskHandleId;
	startParams: RectangleMaskParams;
	proposedParams: RectangleMaskParams;
	bounds: import("@/preview/element-bounds").ElementBounds;
	canvasSize: { width: number; height: number };
	snapThreshold: { x: number; y: number };
}): MaskSnapResult<RectangleMaskParams> {
	const result = _snapBoxMaskInteraction({
		handleId,
		startParams,
		proposedParams,
		bounds,
		canvasSize,
		snapThreshold,
	});
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		params: result.params as RectangleMaskParams,
		activeLines: previewLinesToSnapLines(result.activeLines),
	};
}

export function snapSplitMaskInteraction({
	handleId,
	proposedParams,
	bounds,
	canvasSize,
	snapThreshold,
}: {
	handleId: MaskHandleId;
	proposedParams: SplitMaskParams;
	bounds: import("@/preview/element-bounds").ElementBounds;
	canvasSize: { width: number; height: number };
	snapThreshold: { x: number; y: number };
}): MaskSnapResult<SplitMaskParams> {
	const result = _snapSplitMaskInteraction({
		handleId,
		proposedParams,
		bounds,
		canvasSize,
		snapThreshold,
	});
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		params: result.params as SplitMaskParams,
		activeLines: previewLinesToSnapLines(result.activeLines),
	};
}
