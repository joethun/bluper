"use client";

import { PanelHeader } from "@/components/editor/panels/panel-header";
import { ElementParamsSection } from "@/components/editor/panels/properties/components/element-params-tab";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { AdjustableElement } from "@/timeline";
import { cn } from "@/utils/ui";
import { CropIcon } from "lucide-react";
import { CROP_PARAM_KEYS, NO_CROP, readCropFromParams, type CropInsets } from "@/crop";
import { useCropModeStore } from "@/crop/crop-mode-store";

/**
 * The shapes worth one click. "Original" is the reset rather than a ratio of its
 * own: it puts every edge back, which is the only way to recover material a
 * previous preset trimmed off.
 */
const CROP_PRESETS: ReadonlyArray<{
	label: string;
	ratio: number | null;
}> = [
	{ label: "Original", ratio: null },
	{ label: "1:1", ratio: 1 },
	{ label: "4:5", ratio: 4 / 5 },
	{ label: "9:16", ratio: 9 / 16 },
	{ label: "16:9", ratio: 16 / 9 },
	{ label: "4:3", ratio: 4 / 3 },
];

/**
 * The symmetric insets that leave `ratio` behind, given a source of
 * `sourceWidth` by `sourceHeight`. Only one axis is ever trimmed — whichever one
 * the source has too much of — so a preset always keeps as much of the picture
 * as the shape allows.
 */
function insetsForRatio({
	ratio,
	sourceWidth,
	sourceHeight,
}: {
	ratio: number;
	sourceWidth: number;
	sourceHeight: number;
}): CropInsets {
	const sourceRatio = sourceWidth / sourceHeight;

	if (sourceRatio > ratio) {
		const keptFraction = ratio / sourceRatio;
		const inset = (1 - keptFraction) / 2;
		return { left: inset, right: inset, top: 0, bottom: 0 };
	}

	const keptFraction = sourceRatio / ratio;
	const inset = (1 - keptFraction) / 2;
	return { left: 0, right: 0, top: inset, bottom: inset };
}

function toParams({ crop }: { crop: CropInsets }) {
	return {
		"crop.left": crop.left,
		"crop.right": crop.right,
		"crop.top": crop.top,
		"crop.bottom": crop.bottom,
	};
}

/**
 * Trims the edges off a clip. The kept region is what the renderer then fits to
 * the canvas, so cropping reframes a shot rather than punching a hole in it —
 * position and scale in the Transform tab still move that reframed picture
 * around.
 */
export function CropTab({
	element,
	trackId,
}: {
	element: AdjustableElement;
	trackId: string;
}) {
	const editor = useEditor();
	const toggleCropMode = useCropModeStore((s) => s.toggleCropMode);
	const isCropping = useCropModeStore(
		(s) => s.croppingElement?.elementId === element.id,
	);
	const mediaAsset = useEditor((currentEditor) =>
		currentEditor.media.getAssets().find((asset) => asset.id === element.mediaId),
	);
	const canvasSize = useEditor(
		(currentEditor) => currentEditor.project.getActive()?.settings.canvasSize,
	);

	const sourceWidth = mediaAsset?.width ?? canvasSize?.width ?? 0;
	const sourceHeight = mediaAsset?.height ?? canvasSize?.height ?? 0;
	const crop = readCropFromParams({ params: element.params });
	const isCropped =
		crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0;

	const applyCrop = ({ next }: { next: CropInsets }) => {
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: toParams({ crop: next }) },
				},
			],
		});
	};

	// Without the source's own dimensions there is no way to say which axis a
	// ratio would trim, so the presets stand down and the four sliders below are
	// the whole control.
	const canUsePresets = sourceWidth > 0 && sourceHeight > 0;

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Crop" />
			<Section sectionKey={`${element.id}:crop-mode`}>
				{/* `pt-4` is what a section with no header of its own uses — same as
				    Fade, Speed, Audio and the shared params section. */}
				<SectionContent className="flex flex-col gap-1.5 pt-4">
					<Button
						type="button"
						size="sm"
						variant={isCropping ? "secondary" : "outline"}
						className="w-full"
						onClick={() =>
							toggleCropMode({ element: { trackId, elementId: element.id } })
						}
					>
						<CropIcon />
						{isCropping ? "Done cropping" : "Crop in preview"}
					</Button>
					<p className="text-muted-foreground text-xs">
						Or double-click the clip in the preview. Drag the corners; the
						trimmed edges stay visible so you can give them back.
					</p>
				</SectionContent>
			</Section>
			{canUsePresets && (
				<Section sectionKey={`${element.id}:crop-presets`}>
					<SectionHeader>
						<SectionTitle className="flex-1">Aspect ratio</SectionTitle>
					</SectionHeader>
					<SectionContent className="flex flex-wrap gap-1">
						{CROP_PRESETS.map((preset) => {
							const next =
								preset.ratio === null
									? NO_CROP
									: insetsForRatio({
											ratio: preset.ratio,
											sourceWidth,
											sourceHeight,
										});
							// "Original" is the reset rather than a shape of its own, so an
							// uncropped clip is Original and nothing else. Without the
							// `isCropped` guard a source whose native aspect already matches a
							// preset — a 4:3 still, say — lit that chip up alongside Original,
							// showing two selected shapes at once.
							const isActive =
								preset.ratio === null
									? !isCropped
									: isCropped && isSameCrop({ left: crop, right: next });

							return (
								<Button
									key={preset.label}
									type="button"
									size="sm"
									variant={isActive ? "secondary" : "ghost"}
									className={cn("h-7 px-2 text-xs", !isActive && "opacity-75")}
									onClick={() => applyCrop({ next })}
								>
									{preset.label}
								</Button>
							);
						})}
					</SectionContent>
				</Section>
			)}
			<ElementParamsSection
				element={element}
				trackId={trackId}
				paramKeys={CROP_PARAM_KEYS}
				sectionKey="crop"
			/>
		</div>
	);
}

/** Within half a percent, which is the granularity the sliders store. */
function isSameCrop({
	left,
	right,
}: {
	left: CropInsets;
	right: CropInsets;
}): boolean {
	const isClose = ({ a, b }: { a: number; b: number }) =>
		Math.abs(a - b) < 0.005;
	return (
		isClose({ a: left.left, b: right.left }) &&
		isClose({ a: left.right, b: right.right }) &&
		isClose({ a: left.top, b: right.top }) &&
		isClose({ a: left.bottom, b: right.bottom })
	);
}
