import type { ElementBounds } from "@/preview/element-bounds";
import type { SnapLine } from "@/wasm/preview-snap";

export function setMaskLocalCenter({
	center,
	bounds,
}: {
	center: { x: number; y: number };
	bounds: ElementBounds;
}): { centerX: number; centerY: number } {
	return {
		centerX: bounds.width === 0 ? 0 : center.x / bounds.width,
		centerY: bounds.height === 0 ? 0 : center.y / bounds.height,
	};
}

export function toGlobalMaskSnapLines({
	lines,
	bounds,
	canvasSize,
}: {
	lines: SnapLine[];
	bounds: ElementBounds;
	canvasSize: { width: number; height: number };
}): SnapLine[] {
	const centerX = bounds.cx - canvasSize.width / 2;
	const centerY = bounds.cy - canvasSize.height / 2;

	return lines.map((line) =>
		line.type === "vertical"
			? {
					type: "vertical" as const,
					position: centerX + line.position,
				}
			: {
					type: "horizontal" as const,
					position: centerY + line.position,
				},
	);
}
