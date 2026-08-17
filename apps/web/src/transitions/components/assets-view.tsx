"use client";

import { useMemo, useState } from "react";
import { SearchIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { PanelEmptyState } from "@/components/editor/panels/panel-empty-state";
import { SectionTitle } from "@/components/section";
import { Input } from "@/components/ui/input";
import {
	findTransitionCutAtTime,
	getTransitionDefinitionsForMenu,
	TRANSITION_TARGET_ELEMENT_TYPES,
} from "@/transitions";
import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import type {
	TransitionCategory,
	TransitionDefinition,
} from "@/transitions/types";
import { cn } from "@/utils/ui";
import {
	TRANSITION_CATEGORY_LABELS,
	TRANSITION_CATEGORY_ORDER,
} from "./transition-categories";

/**
 * The transition browser. A transition belongs to a cut rather than to any one
 * clip, so it is aimed at a junction: either by dragging onto one, or by parking
 * the playhead on one and pressing add.
 */
export function TransitionsView() {
	const [search, setSearch] = useState("");
	const definitions = getTransitionDefinitionsForMenu();
	const matches = useMemo(
		() => filterDefinitions({ definitions, search }),
		[definitions, search],
	);

	return (
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3">
				<div className="relative">
					<SearchIcon className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
					<Input
						placeholder="Search transitions..."
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						size="xs"
						className="w-full pl-8"
					/>
				</div>

				<p className="text-muted-foreground text-xs">
					Drag one onto the join between two clips, or park the playhead on a
					join and press add.
				</p>

				{matches.length === 0 ? (
					<PanelEmptyState
						icon={SparklesIcon}
						title="No transitions"
						description={`Nothing matches “${search}”.`}
					/>
				) : (
					TRANSITION_CATEGORY_ORDER.filter((category) =>
						matches.some((definition) => definition.category === category),
					).map((category) => (
						<div key={category} className="flex flex-col gap-2">
							<SectionTitle>
								{TRANSITION_CATEGORY_LABELS[category]}
							</SectionTitle>
							<div
								className="grid gap-2"
								style={{
									gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
								}}
							>
								{matches
									.filter((definition) => definition.category === category)
									.map((definition) => (
										<TransitionItem
											key={definition.type}
											definition={definition}
										/>
									))}
							</div>
						</div>
					))
				)}
			</div>
		</PanelView>
	);
}

function TransitionItem({ definition }: { definition: TransitionDefinition }) {
	const addAtPlayhead = useAddTransitionAtPlayhead();

	return (
		<DraggableItem
			name={definition.name}
			preview={<TransitionPreview category={definition.category} />}
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
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
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

/**
 * A schematic of two clips meeting, with the seam drawn the way this category
 * joins them. Enough to tell the groups apart at a glance without rendering a
 * real transition per tile.
 */
function TransitionPreview({ category }: { category: TransitionCategory }) {
	return (
		<div className="bg-accent relative size-full overflow-hidden">
			<div className="absolute inset-y-0 left-0 w-1/2 bg-foreground/15" />
			<div className="absolute inset-y-0 right-0 w-1/2 bg-foreground/30" />
			<div
				className={cn(
					"absolute inset-y-0 left-1/2 -translate-x-1/2",
					category === "basic" &&
						"w-1/2 bg-gradient-to-r from-transparent via-foreground/25 to-transparent",
					category === "wipe" && "w-px bg-foreground/60",
					category === "motion" && "w-1.5 bg-foreground/50",
					category === "camera" && "w-1/3 bg-foreground/20 blur-[2px]",
				)}
			/>
		</div>
	);
}

function filterDefinitions({
	definitions,
	search,
}: {
	definitions: TransitionDefinition[];
	search: string;
}): TransitionDefinition[] {
	const query = search.trim().toLowerCase();
	if (!query) return definitions;

	return definitions.filter((definition) => {
		if (definition.name.toLowerCase().includes(query)) return true;
		if (definition.type.includes(query)) return true;
		return definition.keywords.some((keyword) =>
			keyword.toLowerCase().includes(query),
		);
	});
}
