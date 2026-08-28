"use client";

import { BoxSelectIcon } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { PanelEmptyState } from "@/components/editor/panels/panel-empty-state";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";

export function PropertiesPanel() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();

	if (selectedElements.length === 0) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<EmptyView />
			</div>
		);
	}

	// Goes through PanelEmptyState like the no-selection state next to it, rather
	// than a bare centred line — the two alternate in the same panel, so a
	// different icon/title/spacing treatment for each read as two panels.
	if (selectedElements.length > 1) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<PanelEmptyState
					className="bg-background"
					icon={BoxSelectIcon}
					title={`${selectedElements.length} elements selected`}
					description="Select a single element to edit its properties"
				/>
			</div>
		);
	}

	const mediaAssets = editor.media.getAssets();

	const elementsWithTracks = editor.timeline.getElementsWithTracks({
		elements: selectedElements,
	});
	const elementWithTrack = elementsWithTracks[0];

	if (!elementWithTrack) return null;

	const { element, track } = elementWithTrack;
	const config = getPropertiesConfig({ element, mediaAssets });
	const visibleTabs = config.tabs;

	const storedTabId = activeTabPerType[element.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	return (
		<div className="panel bg-background flex h-full overflow-hidden rounded-sm border">
			<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
				{visibleTabs.map((tab) => (
					<Tooltip key={tab.id}>
						<TooltipTrigger asChild>
							<Button
								variant={tab.id === activeTab.id ? "secondary" : "ghost"}
								size="icon"
								onClick={() =>
									setActiveTab({
										elementType: element.type,
										tabId: tab.id,
									})
								}
								aria-label={tab.label}
								className={cn(
									"shrink-0",
									"h-8 w-8",
									tab.id !== activeTab.id && "text-muted-foreground",
								)}
							>
								{tab.icon}
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right">{tab.label}</TooltipContent>
					</Tooltip>
				))}
			</div>
			<ScrollArea className="flex-1 scrollbar-hidden">
				{activeTab.content({ trackId: track.id })}
			</ScrollArea>
		</div>
	);
}
