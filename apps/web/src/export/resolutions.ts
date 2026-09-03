/**
 * How the export panel names the sizes it offers.
 *
 * The sizes themselves are decided in Rust — `editor_core::export::resolutions`
 * — because both rules that shape them belong to the encoder rather than to the
 * UI: 4:2:0 chroma has no representation for an odd side, and a rung above the
 * project's own resolution would be invented pixels at a larger file size. What
 * is left here is the wording, the same split the container table keeps.
 *
 * The number in the label is the *short* side, which reads correctly in both
 * orientations: a 1920x1080 project and a 1080x1920 one are both "1080p", and
 * 720p from either lands on 1280x720 and 720x1280 respectively.
 */

import { listExportResolutions } from "@/wasm/export";
import type { ExportResolution } from "@/wasm/export";
import type { TCanvasSize } from "@/project/types";

export type { ExportResolution };

/** The sizes this project may be exported at, its own resolution first. */
export function listProjectExportResolutions({
	canvas,
}: {
	canvas: TCanvasSize;
}): ExportResolution[] {
	return listExportResolutions({ canvas });
}

/** "1080p". */
export function getExportResolutionLabel({
	resolution,
}: {
	resolution: ExportResolution;
}): string {
	return `${resolution.shortSide}p`;
}

/**
 * "1920 x 1080" — shown beside the label, because the "p" alone does not say
 * what a 4:3 or vertical project is about to produce.
 */
export function describeExportResolution({
	resolution,
}: {
	resolution: ExportResolution;
}): string {
	return `${resolution.width} x ${resolution.height}`;
}

/**
 * Identifies a resolution in a `<Select>`, which trades in strings.
 *
 * Keyed on the pixel size rather than on the short side: the short side is the
 * label, and two entries could in principle round to the same one, but no two
 * entries can be the same number of pixels across.
 */
export function getExportResolutionKey({
	resolution,
}: {
	resolution: ExportResolution;
}): string {
	return `${resolution.width}x${resolution.height}`;
}
