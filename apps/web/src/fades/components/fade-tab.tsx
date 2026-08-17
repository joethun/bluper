"use client";

import { PanelHeader } from "@/components/editor/panels/panel-header";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { useEditor } from "@/editor/use-editor";
import { getMaxFadeDuration, readFade, withFadeEdge } from "@/fades";
import type { FadeableElement } from "@/timeline";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import { clamp, formatNumberForDisplay } from "@/utils/math";
import {
	mediaTimeToSeconds,
	minMediaTime,
	roundMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	type MediaTime,
} from "@/wasm";

/**
 * Fade in and fade out for one clip. Unlike a transition this needs no
 * neighbour — the clip ramps against the project background — so it is always
 * available and lives with the clip's own properties.
 */
export function FadeTab({
	element,
	trackId,
}: {
	element: FadeableElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates, commit } =
		useElementPreview<FadeableElement>({
			trackId,
			elementId: element.id,
			fallback: element,
		});

	const fade = readFade({ element: renderElement });

	const previewEdge =
		({ edge }: { edge: "in" | "out" }) =>
		(duration: MediaTime) => {
			previewUpdates({
				fade: withFadeEdge({ fade, edge, duration }),
			} as Partial<FadeableElement>);
		};

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Fade" />
			<Section sectionKey={`${element.id}:fade`}>
				<SectionContent className="pt-4">
					<SectionFields>
						<SectionField label="Fade in">
							<FadeField
								duration={fade?.in ?? ZERO_MEDIA_TIME}
								maxDuration={getMaxFadeDuration({
									element: renderElement,
									edge: "in",
								})}
								onPreview={previewEdge({ edge: "in" })}
								onCommit={commit}
							/>
						</SectionField>
						<SectionField label="Fade out">
							<FadeField
								duration={fade?.out ?? ZERO_MEDIA_TIME}
								maxDuration={getMaxFadeDuration({
									element: renderElement,
									edge: "out",
								})}
								onPreview={previewEdge({ edge: "out" })}
								onCommit={() => {
									commit();
									// Keeps the panel honest when a value was clamped on the way in.
									editor.timeline.getTotalDuration();
								}}
							/>
						</SectionField>
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}

/** Fade length in seconds. Zero means no fade on that edge. */
function FadeField({
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
	const maxSeconds = mediaTimeToSeconds({ time: maxDuration });
	const shown = minMediaTime({ a: duration, b: maxDuration });

	const previewSeconds = (seconds: number) => {
		onPreview(
			roundMediaTime({
				time: clamp({ value: seconds, min: 0, max: maxSeconds }) *
					TICKS_PER_SECOND,
			}),
		);
	};

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: mediaTimeToSeconds({ time: shown }),
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
			isDefault={shown === ZERO_MEDIA_TIME}
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
			onScrub={(value) => previewSeconds(value)}
			onScrubEnd={onCommit}
			onReset={() => {
				previewSeconds(0);
				onCommit();
			}}
		/>
	);
}
