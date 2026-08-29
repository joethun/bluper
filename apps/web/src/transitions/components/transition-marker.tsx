"use client";

import { ChevronsRightLeftIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import type { ParamValue } from "@/params";
import type { TransitionableElement } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline";
import { TIMELINE_LAYERS } from "@/timeline/components/layers";
import {
	findTransitionDefinition,
	MIN_TRANSITION_DURATION,
	type TransitionPlacement,
} from "@/transitions";
import type { ElementTransition } from "@/transitions/types";
import { clamp, formatNumberForDisplay } from "@/utils/math";
import { cn } from "@/utils/ui";
import {
	mediaTimeToSeconds,
	minMediaTime,
	roundMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";

/**
 * Just enough that a sub-pixel span still paints something. Deliberately not wide
 * enough to clear the badge: the band's whole job is to report the real extent, and
 * padding a short transition out to look bigger would be a lie about it. Zoom in and
 * it grows.
 */
const MIN_SPAN_WIDTH_PX = 2;

/**
 * The transition badge, sitting on the cut itself rather than inside either clip
 * — it belongs to the join, and straddling it is what makes clear which two clips
 * it bridges. Clicking opens its settings.
 *
 * Hovering the badge lights up the stretch the blend actually covers. The badge
 * marks the cut, but the blend runs from half its length before that to half after,
 * so its real start and end are not otherwise visible: showing them on the clips
 * themselves says it in the timeline's own terms rather than as a pair of numbers to
 * translate back into positions.
 */
export function TransitionMarker({
	trackId,
	placement,
	zoomLevel,
}: {
	trackId: string;
	placement: TransitionPlacement;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const definition = findTransitionDefinition({
		transitionType: placement.transition.type,
	});
	const left = timelineTimeToPixels({ time: placement.cut, zoomLevel });
	const name = definition?.name ?? placement.transition.type;
	// Straight from the window's own bounds, offset because the badge sits on the cut
	// rather than at the window's start.
	const spanStart = timelineTimeToPixels({
		time: placement.windowStart,
		zoomLevel,
	});
	const spanEnd = timelineTimeToPixels({
		time: placement.windowEnd,
		zoomLevel,
	});
	const spanLeft = spanStart - left;
	const spanWidth = Math.max(MIN_SPAN_WIDTH_PX, spanEnd - spanStart);

	const stopTimelineGestures = (event: React.MouseEvent) => {
		// The track underneath treats a bare mousedown as "deselect and box-select".
		event.stopPropagation();
	};

	return (
		<div
			// `group` so the band can answer the badge's own hover with no delay and no
			// re-render: :hover reaches an ancestor even though it takes no pointer
			// events itself, which is what keeps the clips underneath still hoverable.
			className="group pointer-events-none absolute inset-y-0"
			style={{ left, zIndex: TIMELINE_LAYERS.trackContent + 2 }}
		>
			<div
				aria-hidden
				className={cn(
					"bg-primary/25 ring-primary/60 absolute inset-y-0 rounded-sm opacity-0 ring-1 group-hover:opacity-100",
					// Stays lit while the settings are open, so scrubbing the length shows
					// the band grow and shrink with it.
					isSettingsOpen && "opacity-100",
				)}
				style={{ left: spanLeft, width: spanWidth }}
			/>
			<div className="bg-primary/80 absolute inset-y-0 w-0.5 -translate-x-1/2" />
			<Popover open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={`Edit ${name} transition`}
						className="bg-background/90 text-foreground ring-primary pointer-events-auto absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm ring-1 backdrop-blur-sm hover:bg-background"
						onMouseDown={stopTimelineGestures}
						onClick={stopTimelineGestures}
					>
						<ChevronsRightLeftIcon className="size-3" />
					</button>
				</PopoverTrigger>
				{/* `p-0` and a titled bar of its own, like the export popover: the
				    default `p-4` box put this panel's fields on a gutter no other
				    panel in the editor uses, and hung its title in the middle of it. */}
				<PopoverContent
					className="w-64 overflow-hidden p-0"
					align="center"
					onMouseDown={stopTimelineGestures}
				>
					<TransitionSettings
						trackId={trackId}
						placement={placement}
						onRemove={() => {
							editor.timeline.removeElementTransition({
								trackId,
								elementId: placement.incomingId,
							});
						}}
					/>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function TransitionSettings({
	trackId,
	placement,
	onRemove,
}: {
	trackId: string;
	placement: TransitionPlacement;
	onRemove: () => void;
}) {
	const editor = useEditor();
	const transition = placement.transition;
	const definition = findTransitionDefinition({
		transitionType: transition.type,
	});

	// Previewing through the element patch keeps a scrub live and lands as a
	// single history entry when the pointer is released.
	const preview = ({ updates }: { updates: Partial<ElementTransition> }) => {
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: placement.incomingId,
					updates: {
						transitionIn: { ...transition, ...updates },
					} as Partial<TransitionableElement>,
				},
			],
		});
	};
	const commit = () => editor.timeline.commitPreview();

	return (
		<div className="flex flex-col">
			<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3.5">
				<span className="truncate text-sm font-medium">
					{definition?.name ?? `${transition.type} (unavailable)`}
				</span>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Remove transition"
					className="shrink-0"
					onClick={onRemove}
				>
					<Trash2Icon />
				</Button>
			</div>

			<SectionContent className="pt-3.5">
				<SectionFields>
					<SectionField label="Duration">
						<DurationField
							duration={minMediaTime({
								a: transition.duration,
								b: placement.maxDuration,
							})}
							maxDuration={placement.maxDuration}
							onPreview={(duration) => preview({ updates: { duration } })}
							onCommit={commit}
						/>
					</SectionField>
					{definition?.params.map((param) => (
						<PropertyParamField
							key={param.key}
							param={param}
							value={transition.params[param.key] ?? param.default}
							onPreview={(value: ParamValue) =>
								preview({
									updates: {
										params: { ...transition.params, [param.key]: value },
									},
								})
							}
							onCommit={commit}
						/>
					))}
				</SectionFields>
			</SectionContent>
		</div>
	);
}

/**
 * Duration in seconds, capped at the shorter of the two clips — half of the
 * window eats into each, so a longer one would run past a neighbour's far edge.
 */
function DurationField({
	duration,
	maxDuration,
	onPreview,
	onCommit,
}: {
	duration: MediaTime;
	maxDuration: MediaTime;
	onPreview: (duration: MediaTime) => void;
	onCommit: () => void;
}) {
	const minSeconds = mediaTimeToSeconds({ time: MIN_TRANSITION_DURATION });
	const maxSeconds = Math.max(
		minSeconds,
		mediaTimeToSeconds({ time: maxDuration }),
	);
	const previewSeconds = (seconds: number) => {
		onPreview(
			roundMediaTime({
				time:
					clamp({ value: seconds, min: minSeconds, max: maxSeconds }) *
					TICKS_PER_SECOND,
			}),
		);
	};

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: mediaTimeToSeconds({ time: duration }),
			maxFractionDigits: 2,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			return Number.isNaN(parsed) ? null : parsed;
		},
		onPreview: previewSeconds,
		onCommit,
	});

	return (
		<NumberField
			suffix="s"
			suffixClassName="text-muted-foreground"
			value={draft.displayValue}
			dragSensitivity="slow"
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
			onScrub={(value) => previewSeconds(value)}
			onScrubEnd={onCommit}
		/>
	);
}
