"use client";

import { RotateCcwIcon } from "lucide-react";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { PanelHeader } from "@/components/editor/panels/panel-header";
import { ElementParamField } from "@/components/editor/panels/properties/components/element-params-tab";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import type { ParamValues } from "@/params";
import {
	ADJUSTMENT_PARAM_GROUPS,
	getElementParams,
	readElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { AdjustableElement, VisualElement } from "@/timeline";

/**
 * Blending is not a panel of its own: opacity and blend mode are the last things
 * you reach for once the tone of the picture is settled, so they close out the
 * Adjust list as one more group.
 */
const BLENDING_GROUP = {
	title: "Blending",
	keys: ["opacity", "blendMode"] as readonly string[],
};

const ADJUST_GROUPS = [...ADJUSTMENT_PARAM_GROUPS, BLENDING_GROUP];

/** Footage and stills: the grade, then blending. */
export function AdjustTab({
	element,
	trackId,
}: {
	element: AdjustableElement;
	trackId: string;
}) {
	return (
		<ParamGroupsTab
			element={element}
			trackId={trackId}
			title="Adjust"
			groups={ADJUST_GROUPS}
		/>
	);
}

/**
 * Everything else. Blending is not a tab of its own where there is a grade to sit
 * under, but text, stickers and shapes have no grade — so it stands alone rather
 * than opacity and blend mode going missing entirely.
 */
export function BlendingTab({
	element,
	trackId,
}: {
	element: VisualElement;
	trackId: string;
}) {
	return (
		<ParamGroupsTab
			element={element}
			trackId={trackId}
			title="Blending"
			groups={[BLENDING_GROUP]}
		/>
	);
}

function ParamGroupsTab({
	element,
	trackId,
	title,
	groups,
}: {
	element: VisualElement;
	trackId: string;
	title: string;
	groups: ReadonlyArray<{ title: string; keys: readonly string[] }>;
}) {
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const paramByKey = new Map(
		getElementParams({ element }).map((param) => [param.key, param]),
	);

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title={title} />
			<TooltipProvider delayDuration={300}>
				{groups.map((group) => (
					<AdjustGroup
						key={group.title}
						element={element}
						trackId={trackId}
						title={group.title}
						params={group.keys
							.map((key) => paramByKey.get(key))
							.filter((param): param is ElementParamDefinition =>
								Boolean(param),
							)}
						localTime={localTime}
						isPlayheadWithinElementRange={isPlayheadWithinElementRange}
					/>
				))}
			</TooltipProvider>
		</div>
	);
}

function AdjustGroup({
	element,
	trackId,
	title,
	params,
	localTime,
	isPlayheadWithinElementRange,
}: {
	element: VisualElement;
	trackId: string;
	title: string;
	params: ElementParamDefinition[];
	localTime: ReturnType<typeof useElementPlayhead>["localTime"];
	isPlayheadWithinElementRange: boolean;
}) {
	const editor = useEditor();

	if (params.length === 0) {
		return null;
	}

	const readValue = ({ param }: { param: ElementParamDefinition }) =>
		readElementParamValue({ element, param }) ?? param.default;

	const isPristine = params.every(
		(param) => readValue({ param }) === param.default,
	);

	// One command for the whole group, so undo puts back the pass that was thrown
	// away rather than making the editor walk back a slider at a time.
	const reset = () => {
		const params_: ParamValues = { ...element.params };
		for (const param of params) {
			params_[param.key] = param.default;
		}
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch: { params: params_ } }],
		});
	};

	return (
		// Collapsible, and with the reset sitting beside the chevron, so a group here
		// behaves like an applied effect over in the Effects tab.
		<Section sectionKey={`${element.id}:adjust:${title}`} collapsible>
			<SectionHeader
				trailing={
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label={`Reset ${title.toLowerCase()}`}
								disabled={isPristine}
								onClick={reset}
								className="text-muted-foreground disabled:opacity-30"
							>
								<RotateCcwIcon />
							</Button>
						</TooltipTrigger>
						<TooltipContent side="left">Reset {title}</TooltipContent>
					</Tooltip>
				}
			>
				<SectionTitle>{title}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					{params.map((param) => (
						<ElementParamField
							key={param.key}
							element={element}
							trackId={trackId}
							param={param}
							baseValue={readValue({ param })}
							localTime={localTime}
							isPlayheadWithinElementRange={isPlayheadWithinElementRange}
						/>
					))}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
