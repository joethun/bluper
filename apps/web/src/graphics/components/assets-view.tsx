"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { buildDefaultGraphicInstance, getGraphicDefinition } from "@/graphics";
import { SHAPE_PRESETS, type ShapePreset } from "@/graphics/presets";
import { buildGraphicElement } from "@/timeline/element-utils";
import type { MediaTime } from "@/wasm";

/**
 * The shape browser. A shape needs nothing on the timeline to land on — it is
 * its own element, not a treatment of one — so every tile can be added at the
 * playhead or dragged to a position, with no empty state to guard.
 */
export function ShapesView() {
	return (
		<PanelView title="Shapes">
			<div className="grid grid-cols-3 gap-3">
				{SHAPE_PRESETS.map((preset) => (
					<ShapeItem key={preset.id} preset={preset} />
				))}
			</div>
		</PanelView>
	);
}

function ShapeItem({ preset }: { preset: ShapePreset }) {
	const editor = useEditor();

	const handleAddToTimeline = ({ currentTime }: { currentTime: MediaTime }) => {
		if (!editor.scenes.getActiveSceneOrNull()) return;

		editor.timeline.insertElement({
			element: buildGraphicElement({
				definitionId: preset.definitionId,
				name: preset.name,
				startTime: currentTime,
				params: preset.params,
			}),
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={preset.name}
			preview={<ShapePreview preset={preset} />}
			dragData={{
				id: preset.id,
				name: preset.name,
				type: "graphic",
				definitionId: preset.definitionId,
				params: preset.params ?? {},
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			containerClassName="w-full"
		/>
	);
}

/**
 * The tile's picture, drawn by the definition's own `render` so the geometry is
 * the one that will land on the canvas — a star's depth, a polygon's sides.
 *
 * The fill is the panel's ink rather than the shape's own, which is white by
 * default and would vanish against a light theme's tile. What the tile is for
 * is telling a triangle from a hexagon; the colour is a click away in the
 * properties panel once the shape is placed.
 */
function ShapePreview({ preset }: { preset: ShapePreset }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// A theme flip changes the ink without re-rendering the tile, so the paint
	// has to be asked for again.
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const context = canvas.getContext("2d");
		if (!context) return;

		const definition = getGraphicDefinition({
			definitionId: preset.definitionId,
		});
		const params = {
			...buildDefaultGraphicInstance({ definitionId: preset.definitionId })
				.params,
			...preset.params,
		};

		// Read once rather than per draw: the ink depends only on the theme, which
		// is a dependency of this effect, and resolving it is a forced style
		// recalculation.
		const ink = readInk({ element: canvas });

		const draw = ({ force }: { force: boolean }) => {
			const dpr = window.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			const width = Math.max(1, Math.round(rect.width));
			const height = Math.max(1, Math.round(rect.height));
			const deviceWidth = Math.round(width * dpr);
			const deviceHeight = Math.round(height * dpr);

			// A `ResizeObserver` fires on sub-pixel changes too, where the rounded
			// size — and so the picture — is unchanged. Assigning `canvas.width` is
			// what reallocates the backing store and clears it, so a tile that has
			// not really changed size has nothing to redraw. The first paint and a
			// theme flip force their way past this.
			const isUnchanged =
				canvas.width === deviceWidth && canvas.height === deviceHeight;
			if (!force && isUnchanged) return;

			canvas.width = deviceWidth;
			canvas.height = deviceHeight;
			context.setTransform(dpr, 0, 0, dpr, 0, 0);

			definition.render({
				ctx: context,
				params: { ...params, fill: ink },
				width,
				height,
			});
		};

		draw({ force: true });

		const observer = new ResizeObserver(() => draw({ force: false }));
		observer.observe(canvas);

		return () => observer.disconnect();
	}, [preset, resolvedTheme]);

	return (
		// The shape is drawn edge to edge of its canvas, as it is on the video, so
		// the breathing room is the box's: without it a rectangle fills the tile
		// and reads as a blank swatch rather than as a rectangle.
		<div className="flex size-full items-center justify-center p-4">
			{/* Decorative: the tile's name is already the draggable's label. */}
			<canvas ref={canvasRef} aria-hidden className="size-full" />
		</div>
	);
}

function readInk({ element }: { element: HTMLElement }): string {
	return (
		getComputedStyle(element).getPropertyValue("--foreground").trim() ||
		"#ffffff"
	);
}
