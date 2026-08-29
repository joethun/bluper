"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	findTransitionCutAtTime,
	getTransitionDefinitionsForMenu,
	TRANSITION_TARGET_ELEMENT_TYPES,
} from "@/transitions";
import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import type { TransitionDefinition } from "@/transitions/types";
import { TransitionPreview } from "./transition-preview";
import {
	type TransitionPreviewFrames,
	useTransitionPreviewFrames,
} from "./preview-frames";
import {
	TRANSITION_CATEGORY_LABELS,
	TRANSITION_CATEGORY_ORDER,
} from "./transition-categories";

/**
 * The transition browser. A transition belongs to a cut rather than to any one
 * clip, so it is aimed at a junction: either by dragging onto one, or by parking
 * the playhead on one and pressing add.
 *
 * There is no search box and no instructions above the grid. The whole library
 * is two dozen tiles in four named groups — less than a screenful — so a filter
 * cost a permanently occupied row to save nobody any scrolling, and the sentence
 * under it explained a drag that the tiles now demonstrate on hover.
 */
export function TransitionsView() {
	const definitions = getTransitionDefinitionsForMenu();
	// Decoded once for the whole panel rather than per tile: every tile blends
	// the same two stills, and two dozen decodes of one clip is two dozen trips
	// through ffmpeg for one pair of pictures.
	const frames = useTransitionPreviewFrames();

	return (
		// The Effects tab's shape, and for the same reason: a library of tiles in
		// named groups. `pt-0`/`px-0` take off the padding the asset panels put
		// round their grids, so the sections run to the panel edges and their rules
		// divide the list the way they do over there.
		<PanelView
			title="Transitions"
			scrollClassName="pt-0"
			contentClassName="px-0 pb-0"
		>
			{TRANSITION_CATEGORY_ORDER.filter((category) =>
				definitions.some((definition) => definition.category === category),
			).map((category) => (
				<Section
					key={category}
					sectionKey={`transitions:${category}`}
					collapsible
				>
					<SectionHeader>
						<SectionTitle>{TRANSITION_CATEGORY_LABELS[category]}</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<div className="grid grid-cols-3 gap-2">
							{definitions
								.filter((definition) => definition.category === category)
								.map((definition) => (
									<TransitionItem
										key={definition.type}
										definition={definition}
										frames={frames}
									/>
								))}
						</div>
					</SectionContent>
				</Section>
			))}
		</PanelView>
	);
}

function TransitionItem({
	definition,
	frames,
}: {
	definition: TransitionDefinition;
	frames: TransitionPreviewFrames | null;
}) {
	const addAtPlayhead = useAddTransitionAtPlayhead();
	const [isHovered, setIsHovered] = useState(false);

	return (
		// The label sits outside `DraggableItem` so it can be the Effects tile's
		// own — two lines, clamped, rather than one truncated — and this wrapper
		// carries the `group` the thumbnail's hover border and add button answer
		// to, so pointing at the name lights the tile the same way.
		//
		// Hover is tracked here rather than on the canvas because the add button
		// sits over the thumbnail as a sibling: crossing onto it would otherwise
		// count as leaving, and restart the pass.
		<div
			className="group flex flex-col gap-1.5"
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<DraggableItem
				name={definition.name}
				preview={
					<TransitionPreview
						definition={definition}
						frames={frames}
						isPlaying={isHovered}
					/>
				}
				onAddToTimeline={({ currentTime }) =>
					addAtPlayhead({ definition, currentTime })
				}
				dragData={{
					id: definition.type,
					name: definition.name,
					type: "transition",
					transitionType: definition.type,
					targetElementTypes: [...TRANSITION_TARGET_ELEMENT_TYPES],
				}}
				aspectRatio={5 / 4}
				variant="card"
				shouldShowLabel={false}
				containerClassName="w-full"
				// The Effects tile's chrome: a border that is always there and darkens
				// under the pointer, in place of the asset grid's ring that only
				// appears on hover. `ring-0` retires that ring.
				previewClassName="rounded-sm border ring-0 transition-colors group-hover:border-muted-foreground/60"
			/>
			<span className="text-muted-foreground line-clamp-2 text-xs leading-tight">
				{definition.name}
			</span>
		</div>
	);
}

/**
 * Lands a transition on the join under the playhead, which is what the add button
 * does in place of a drop target. The slack is one frame: a cut is a single
 * instant, and the playhead is frame-quantised, so demanding an exact tick would
 * make the button look broken while sitting visibly on the join.
 */
function useAddTransitionAtPlayhead() {
	const editor = useEditor();

	return ({
		definition,
		currentTime,
	}: {
		definition: TransitionDefinition;
		currentTime: MediaTime;
	}) => {
		const tracks = editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!tracks) {
			return;
		}

		const fps = editor.project.getActiveOrNull()?.settings.fps;
		const framesPerSecond = fps ? frameRateToFloat(fps) : 0;
		const toleranceTicks =
			framesPerSecond > 0 ? Math.round(TICKS_PER_SECOND / framesPerSecond) : 0;

		// A clip is usually selected because it is the one being worked on, so its
		// track breaks the tie when two tracks are cut at the same instant.
		const selected = editor.selection.getSelectedElements();
		const cut = findTransitionCutAtTime({
			tracks,
			time: currentTime,
			toleranceTicks,
			preferredTrackId: selected.length === 1 ? selected[0].trackId : null,
		});
		if (!cut) {
			toast.error("No join at the playhead", {
				description:
					"Move the playhead to where two video or image clips meet, then add.",
			});
			return;
		}

		editor.timeline.setElementTransition({
			trackId: cut.trackId,
			elementId: cut.incomingId,
			transitionType: definition.type,
		});
	};
}
