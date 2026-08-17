"use client";

import { useEffect, useRef } from "react";
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	EyeIcon,
	EyeOffIcon,
	Trash2Icon,
} from "lucide-react";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { PanelHeader } from "@/components/editor/panels/panel-header";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { EFFECT_GROUPS, effectsRegistry } from "@/effects";
import type { Effect, EffectDefinition, EffectGroup } from "@/effects/types";
import type { ParamValue, ParamValues } from "@/params";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import type { EffectElement, TimelineElement, EffectableElement } from "@/timeline";
import { cn } from "@/utils/ui";

/**
 * The Effects tab, laid out the way the Adjust tab is: what is on the clip sits at
 * the top with its controls, and the library sits underneath it.
 *
 * The controls being pinned rather than expanding inline in the grid is
 * deliberate. Inline meant the grid reflowed on every pick and a slider for
 * something in the bottom row landed below the fold; pinned, the sliders are
 * always in the same place and the picture is always in view while you drag them.
 */
export function ClipEffectsTab({
	element,
	trackId,
}: {
	element: EffectableElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const effects: Effect[] = element.effects ?? [];
	const sampleImageUrl = usePreviewSourceUrl({ element });
	const appliedByType = new Map(effects.map((effect) => [effect.type, effect]));

	// Tiles toggle. Clicking an applied effect takes it off, which is both what a
	// pressed-looking tile implies and what makes a separate "None" tile pointless.
	const toggle = ({ definition }: { definition: EffectDefinition }) => {
		const applied = appliedByType.get(definition.type);
		if (applied) {
			editor.timeline.removeClipEffect({
				trackId,
				elementId: element.id,
				effectId: applied.id,
			});
			return;
		}
		editor.timeline.addClipEffect({
			trackId,
			elementId: element.id,
			effectType: definition.type,
		});
	};

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Effects" />
			{effects.map((effect, index) => (
				<AppliedEffect
					key={effect.id}
					effect={effect}
					element={element}
					renderElement={renderElement as EffectableElement}
					trackId={trackId}
					index={index}
					stackSize={effects.length}
					sampleImageUrl={sampleImageUrl}
					previewUpdates={previewUpdates}
					onCommit={commit}
				/>
			))}
			{EFFECT_GROUPS.map((group) => (
				<LibraryGroup
					key={group.title}
					group={group}
					elementId={element.id}
					appliedTypes={new Set(appliedByType.keys())}
					sampleImageUrl={sampleImageUrl}
					onToggle={toggle}
				/>
			))}
		</div>
	);
}

/** A standalone effect element on the effect track: its controls, nothing else. */
export function StandaloneEffectTab({
	element,
	trackId,
}: {
	element: EffectElement;
	trackId: string;
}) {
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const definition = effectsRegistry.has(element.effectType)
		? effectsRegistry.get(element.effectType)
		: null;

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Effect" />
			{definition ? (
				<Section sectionKey={`${element.id}:effect`}>
					<SectionHeader>
						<SectionTitle>{definition.name}</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<EffectParams
							definition={definition}
							values={(renderElement as EffectElement).params}
							onPreview={({ key, value }) =>
								previewUpdates({
									params: {
										...(renderElement as EffectElement).params,
										[key]: value,
									},
								})
							}
							onCommit={commit}
						/>
					</SectionContent>
				</Section>
			) : (
				<p className="text-muted-foreground px-3.5 py-3 text-sm">
					This effect is no longer available.
				</p>
			)}
		</div>
	);
}

function AppliedEffect({
	effect,
	element,
	renderElement,
	trackId,
	index,
	stackSize,
	sampleImageUrl,
	previewUpdates,
	onCommit,
}: {
	effect: Effect;
	element: EffectableElement;
	renderElement: EffectableElement;
	trackId: string;
	index: number;
	stackSize: number;
	sampleImageUrl: string | undefined;
	previewUpdates: (updates: Partial<TimelineElement>) => void;
	onCommit: () => void;
}) {
	const editor = useEditor();
	const definition = effectsRegistry.has(effect.type)
		? effectsRegistry.get(effect.type)
		: null;
	if (!definition) {
		return null;
	}

	const renderParams =
		renderElement.effects?.find((entry) => entry.id === effect.id)?.params ??
		effect.params;

	const handlePreview = ({ key, value }: { key: string; value: ParamValue }) => {
		previewUpdates({
			effects: (renderElement.effects ?? []).map((entry) =>
				entry.id !== effect.id
					? entry
					: { ...entry, params: { ...entry.params, [key]: value } },
			),
		});
	};

	const move = ({ toIndex }: { toIndex: number }) =>
		editor.timeline.reorderClipEffects({
			trackId,
			elementId: element.id,
			fromIndex: index,
			toIndex,
		});

	return (
		<Section sectionKey={`${element.id}:effect:${effect.id}`} collapsible>
			<SectionHeader
				trailing={
					// `SectionHeader` already lays its trailing area out as a row, so this
					// is a fragment rather than another flex wrapper.
					<>
						{/* Order only matters once something is stacked on top. */}
						{stackSize > 1 && (
							<>
								<IconAction
									icon={<ChevronUpIcon />}
									label={`Move ${definition.name} down the stack`}
									isDisabled={index <= 0}
									onClick={() => move({ toIndex: index - 1 })}
								/>
								<IconAction
									icon={<ChevronDownIcon />}
									label={`Move ${definition.name} up the stack`}
									isDisabled={index >= stackSize - 1}
									onClick={() => move({ toIndex: index + 1 })}
								/>
							</>
						)}
						<IconAction
							icon={effect.enabled ? <EyeIcon /> : <EyeOffIcon />}
							label={
								effect.enabled
									? `Hide ${definition.name}`
									: `Show ${definition.name}`
							}
							onClick={() =>
								editor.timeline.toggleClipEffect({
									trackId,
									elementId: element.id,
									effectId: effect.id,
								})
							}
						/>
						<IconAction
							icon={<Trash2Icon />}
							label={`Remove ${definition.name}`}
							onClick={() =>
								editor.timeline.removeClipEffect({
									trackId,
									elementId: element.id,
									effectId: effect.id,
								})
							}
						/>
					</>
				}
			>
				<SectionTitle
					className={cn(!effect.enabled && "text-muted-foreground line-through")}
				>
					{definition.name}
				</SectionTitle>
			</SectionHeader>
			<SectionContent className={cn(!effect.enabled && "opacity-50")}>
				<EffectParams
					definition={definition}
					values={renderParams}
					sampleImageUrl={sampleImageUrl}
					onPreview={handlePreview}
					onCommit={onCommit}
				/>
			</SectionContent>
		</Section>
	);
}

function LibraryGroup({
	group,
	elementId,
	appliedTypes,
	sampleImageUrl,
	onToggle,
}: {
	group: EffectGroup;
	elementId: string;
	appliedTypes: Set<string>;
	sampleImageUrl: string | undefined;
	onToggle: ({ definition }: { definition: EffectDefinition }) => void;
}) {
	const definitions = group.types
		.filter((type) => effectsRegistry.has(type))
		.map((type) => effectsRegistry.get(type));

	if (definitions.length === 0) {
		return null;
	}

	return (
		<Section sectionKey={`${elementId}:effects:${group.title}`} collapsible>
			<SectionHeader>
				<SectionTitle>{group.title}</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<div className="grid grid-cols-3 gap-2">
					{definitions.map((definition) => (
						<EffectTile
							key={definition.type}
							definition={definition}
							sampleImageUrl={sampleImageUrl}
							isApplied={appliedTypes.has(definition.type)}
							onClick={() => onToggle({ definition })}
						/>
					))}
				</div>
			</SectionContent>
		</Section>
	);
}

function IconAction({
	icon,
	label,
	isDisabled = false,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	isDisabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={label}
					disabled={isDisabled}
					onClick={onClick}
					className="text-muted-foreground disabled:opacity-30"
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	);
}

function EffectParams({
	definition,
	values,
	sampleImageUrl,
	onPreview,
	onCommit,
}: {
	definition: EffectDefinition;
	values: ParamValues;
	/** A still of the layer, for an eyedropper param such as the key colour. */
	sampleImageUrl?: string;
	onPreview: ({ key, value }: { key: string; value: ParamValue }) => void;
	onCommit: () => void;
}) {
	if (definition.params.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				{definition.name} has nothing to adjust.
			</p>
		);
	}

	return (
		<SectionFields>
			{definition.params.map((param) => (
				<PropertyParamField
					key={param.key}
					param={param}
					value={values[param.key] ?? param.default}
					sampleImageUrl={sampleImageUrl}
					onPreview={(value) => onPreview({ key: param.key, value })}
					onCommit={onCommit}
				/>
			))}
		</SectionFields>
	);
}

function EffectTile({
	definition,
	sampleImageUrl,
	isApplied,
	onClick,
}: {
	definition: EffectDefinition;
	sampleImageUrl: string | undefined;
	isApplied: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={isApplied}
			title={isApplied ? `Remove ${definition.name}` : `Add ${definition.name}`}
			className="group flex flex-col gap-1.5 text-left"
		>
			<div
				className={cn(
					"bg-accent relative aspect-[5/4] w-full overflow-hidden rounded-sm border transition-colors",
					isApplied
						? "border-primary ring-primary ring-1"
						: "group-hover:border-muted-foreground/60",
				)}
			>
				<TilePreview
					effectType={definition.type}
					sampleImageUrl={sampleImageUrl}
				/>
				{isApplied && (
					<span className="bg-primary text-primary-foreground absolute top-1 right-1 flex size-4 items-center justify-center rounded-sm">
						<CheckIcon className="size-3" />
					</span>
				)}
			</div>
			<span
				className={cn(
					"line-clamp-2 text-xs leading-tight",
					isApplied ? "text-foreground font-medium" : "text-muted-foreground",
				)}
			>
				{definition.name}
			</span>
		</button>
	);
}

function TilePreview({
	effectType,
	sampleImageUrl,
}: {
	effectType: string;
	sampleImageUrl: string | undefined;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
					sourceUrl: sampleImageUrl,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType, sampleImageUrl]);

	return <canvas ref={canvasRef} className="size-full" />;
}

/**
 * The still the tiles preview against, and that the key colour is sampled out of.
 * Using the clip's own thumbnail means the tiles show what each effect would do to
 * this shot rather than to a stock frame; layers with no thumbnail of their own
 * fall back to the bundled one.
 */
function usePreviewSourceUrl({
	element,
}: {
	element: EffectableElement;
}): string | undefined {
	const editor = useEditor();

	const mediaId = "mediaId" in element ? element.mediaId : undefined;
	if (!mediaId) {
		return undefined;
	}
	return editor.media.getAssets().find((asset) => asset.id === mediaId)
		?.thumbnailUrl;
}
