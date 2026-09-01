"use client";

import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import {
	useKeyframedParamProperty,
	type KeyframedParamPropertyResult,
} from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import type { ParamDefinition, ParamValues } from "@/params";
import type { GraphicElement } from "@/timeline";
import {
	graphicsRegistry,
	registerDefaultGraphics,
	resolveGraphicElementParamsAtTime,
} from "@/graphics";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { PanelHeader } from "@/components/editor/panels/panel-header";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { MediaTime } from "@/wasm";

registerDefaultGraphics();

/**
 * The shape's own controls: what it is made of, then what is drawn round it.
 *
 * Two named sections and nothing else in their headers — no collapse, no group
 * reset. A shape has half a dozen fields in total, so there is nothing to fold
 * away to reach, and every field already carries its own reset in the number
 * field beside it.
 */
export function GraphicTab({
	element,
	trackId,
}: {
	element: GraphicElement;
	trackId: string;
}) {
	const definition = graphicsRegistry.get(element.definitionId);
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const { renderElement } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const liveElement = renderElement as GraphicElement;
	const resolvedParams = resolveGraphicElementParamsAtTime({
		element: liveElement,
		localTime,
	});

	const groups = [
		{
			title: definition.name,
			params: definition.params.filter((param) => param.group !== "stroke"),
		},
		{
			title: "Stroke",
			params: definition.params.filter((param) => param.group === "stroke"),
		},
	].filter((group) => group.params.length > 0);

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Graphic" />
			{groups.map((group) => (
				<Section key={group.title}>
					<SectionHeader>
						<SectionTitle>{group.title}</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<SectionFields>
							{group.params.map((param) => (
								<AnimatedGraphicParamField
									key={param.key}
									param={param}
									trackId={trackId}
									element={liveElement}
									localTime={localTime}
									isPlayheadWithinElementRange={isPlayheadWithinElementRange}
									resolvedParams={resolvedParams}
								/>
							))}
						</SectionFields>
					</SectionContent>
				</Section>
			))}
		</div>
	);
}

function AnimatedGraphicParamField({
	param,
	trackId,
	element,
	localTime,
	isPlayheadWithinElementRange,
	resolvedParams,
}: {
	key?: string;
	param: ParamDefinition;
	trackId: string;
	element: GraphicElement;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	resolvedParams: ParamValues;
}) {
	const animatedParam: KeyframedParamPropertyResult = useKeyframedParamProperty(
		{
			param,
			trackId,
			elementId: element.id,
			animations: element.animations,
			localTime,
			isPlayheadWithinElementRange,
			resolvedValue: resolvedParams[param.key] ?? param.default,
			buildBaseUpdates: ({ value }) => ({
				params: {
					...element.params,
					[param.key]: value,
				},
			}),
		},
	);

	return (
		<PropertyParamField
			param={param}
			value={resolvedParams[param.key] ?? param.default}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={{
				isActive: animatedParam.isKeyframedAtTime,
				isAnimated: animatedParam.hasAnimatedKeyframes,
				isDisabled: !isPlayheadWithinElementRange,
				onToggle: animatedParam.toggleKeyframe,
			}}
		/>
	);
}
