import { useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { PanelHeader } from "@/components/editor/panels/panel-header";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import {
	buildConstantRetime,
	buildCurveRetime,
	buildRetimeCurvePreset,
	getRetimeCurve,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import {
	DEFAULT_RETIME_RATE,
	MIN_RETIME_RATE,
	MAX_RETIME_RATE,
	clampRetimeRate,
	canMaintainPitch,
} from "@/retime";
import type {
	AudioElement,
	RetimeCurve,
	RetimeCurvePresetId,
	VideoElement,
} from "@/timeline";
import { type MediaTime, mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { SpeedCurveGraph } from "./speed-curve-graph";
import { SpeedCurvePresets } from "./speed-curve-presets";

const SPEED_STEP = 0.01;
const SPEED_FRACTION_DIGITS = getFractionDigitsForStep({ step: SPEED_STEP });

function rateToDisplay({ rate }: { rate: number }): string {
	return formatNumberForDisplay({
		value: rate,
		fractionDigits: SPEED_FRACTION_DIGITS,
	});
}

function parseSpeedInput({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	if (Number.isNaN(parsed)) return null;
	return clampRetimeRate({
		rate: snapToStep({ value: parsed, step: SPEED_STEP }),
	});
}

function secondsToDisplay({ seconds }: { seconds: number }): string {
	return `${seconds.toFixed(1)}s`;
}

/**
 * The material the clip's trims leave on screen. `sourceDuration` and the trims
 * are all untouched by retiming, so this figure holds still while a speed is
 * being dragged; only clips that predate `sourceDuration` have to work back from
 * their own length.
 */
function getVisibleSourceSpan({
	element,
}: {
	element: AudioElement | VideoElement;
}): MediaTime {
	if (element.sourceDuration != null) {
		return roundMediaTime({
			time: Math.max(
				0,
				element.sourceDuration - element.trimStart - element.trimEnd,
			),
		});
	}

	return roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: element.duration,
			clipDuration: element.duration,
			retime: element.retime,
		}),
	});
}

function buildRetime({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch: boolean;
}) {
	if (rate === DEFAULT_RETIME_RATE && !maintainPitch) return undefined;
	return buildConstantRetime({ rate, maintainPitch });
}

export function SpeedTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const retime = element.retime;
	const rate = clampRetimeRate({
		rate: retime?.rate ?? DEFAULT_RETIME_RATE,
	});
	const isPitchPreserveAvailable = canMaintainPitch({ rate });
	const maintainPitch = retime?.maintainPitch ?? false;
	const curve = getRetimeCurve({ retime });
	const pendingRateRef = useRef(rate);

	// A curve keeps the material the trim exposes and changes how long the clip
	// runs, so the readout is that span at 1x against the length it plays for. The
	// span comes from the trims, which a speed change never touches, so the
	// "before" figure does not move when the speed does.
	const sourceSpan = getVisibleSourceSpan({ element });
	const sourceSpanSeconds = mediaTimeToSeconds({ time: sourceSpan });
	const durationSeconds = mediaTimeToSeconds({
		time: roundMediaTime({
			time: getTimelineDurationForSourceSpan({
				sourceSpan,
				retime,
			}),
		}),
	});

	const commitRetime = ({
		rate: nextRate,
		maintainPitch: nextMaintainPitch,
	}: {
		rate: number;
		maintainPitch: boolean;
	}) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildRetime({ rate: nextRate, maintainPitch: nextMaintainPitch }),
		});
	};

	const commitCurve = ({ curve: nextCurve }: { curve: RetimeCurve }) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildCurveRetime({ curve: nextCurve, maintainPitch }),
		});
	};

	const previewCurve = ({ curve: nextCurve }: { curve: RetimeCurve }) => {
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: {
						retime: buildCurveRetime({ curve: nextCurve, maintainPitch }),
					},
				},
			],
		});
	};

	const speedDraft = usePropertyDraft({
		displayValue: rateToDisplay({ rate }),
		parse: (input) => parseSpeedInput({ input }),
		onPreview: (nextRate) => {
			pendingRateRef.current = nextRate;
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId: element.id,
						updates: {
							retime: buildRetime({ rate: nextRate, maintainPitch }),
						},
					},
				],
			});
		},
		onCommit: () => {
			commitRetime({ rate: pendingRateRef.current, maintainPitch });
		},
	});

	return (
		<div className="flex h-full flex-col">
			<PanelHeader title="Speed" />
			<Section sectionKey={`${element.id}:speed`}>
				<SectionContent className="pt-4">
					<SectionFields>
						{curve ? (
							<SectionField label="Duration">
								<div className="flex h-7 items-center gap-1.5 text-sm">
									<span className="text-muted-foreground">
										{secondsToDisplay({ seconds: sourceSpanSeconds })}
									</span>
									<span className="text-muted-foreground">&rarr;</span>
									<span className="font-medium">
										{secondsToDisplay({ seconds: durationSeconds })}
									</span>
								</div>
							</SectionField>
						) : (
							<SectionField label="Speed">
								<NumberField
									value={speedDraft.displayValue}
									suffix="x"
									suffixClassName="text-muted-foreground"
									dragSensitivity="slow"
									scrubRanges={[
										{ from: 0.01, to: 1, pixelsPerUnit: 160 },
										{ from: 1, to: 5, pixelsPerUnit: 48 },
									]}
									scrubClamp={{ min: MIN_RETIME_RATE, max: MAX_RETIME_RATE }}
									onFocus={() => {
										pendingRateRef.current = rate;
										speedDraft.onFocus();
									}}
									onChange={speedDraft.onChange}
									onBlur={speedDraft.onBlur}
									onScrub={speedDraft.scrubTo}
									onScrubEnd={speedDraft.commitScrub}
									onReset={() =>
										commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch })
									}
									isDefault={rate === DEFAULT_RETIME_RATE}
								/>
							</SectionField>
						)}
						<SectionField label="Change pitch">
							<Switch
								checked={!maintainPitch}
								disabled={!isPitchPreserveAvailable}
								onCheckedChange={(checked) => {
									if (curve) {
										editor.timeline.updateElementRetime({
											trackId,
											elementId: element.id,
											retime: buildCurveRetime({
												curve,
												maintainPitch: !checked,
											}),
										});
										return;
									}
									commitRetime({ rate, maintainPitch: !checked });
								}}
							/>
						</SectionField>
						<SectionField label="Speed curve">
							<SpeedCurvePresets
								selectedPreset={curve?.preset}
								onSelect={(presetId: RetimeCurvePresetId) =>
									commitCurve({
										curve: buildRetimeCurvePreset({ presetId }),
									})
								}
								onClear={() =>
									commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch })
								}
							/>
						</SectionField>
						{curve ? (
							<SpeedCurveGraph
								// A new preset is a new set of handles, so the graph starts
								// again rather than keeping a selection that has moved.
								key={curve.preset}
								curve={curve}
								onPreview={(nextCurve) => previewCurve({ curve: nextCurve })}
								onCommit={(nextCurve) => commitCurve({ curve: nextCurve })}
								onReset={() =>
									commitCurve({
										curve: buildRetimeCurvePreset({ presetId: curve.preset }),
									})
								}
							/>
						) : null}
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}
