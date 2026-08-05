"use client";

import { BanIcon, SlidersHorizontalIcon } from "lucide-react";
import {
	MAX_CURVE_RATE,
	MIN_CURVE_RATE,
	RETIME_CURVE_PRESETS,
	buildRetimeCurvePreset,
	sampleCurveRates,
} from "@/retime";
import type { RetimeCurvePresetId } from "@/timeline";
import { cn } from "@/utils/ui";

const SKETCH_WIDTH = 40;
const SKETCH_HEIGHT = 22;
const SKETCH_SEGMENTS = 48;
const SKETCH_PADDING = 3;

const LOG_MIN = Math.log(MIN_CURVE_RATE);
const LOG_MAX = Math.log(MAX_CURVE_RATE);

/**
 * The tile sketches are drawn from the same handles the preset applies, so what
 * a tile shows is what the clip will play.
 */
function buildSketchPath({
	presetId,
}: {
	presetId: RetimeCurvePresetId;
}): string {
	const rates = sampleCurveRates({
		curve: buildRetimeCurvePreset({ presetId }),
		sampleCount: SKETCH_SEGMENTS,
	});
	const usableHeight = SKETCH_HEIGHT - SKETCH_PADDING * 2;

	return `M${rates
		.map((rate, index) => {
			const x = (index / SKETCH_SEGMENTS) * SKETCH_WIDTH;
			const fraction = (Math.log(rate) - LOG_MIN) / (LOG_MAX - LOG_MIN);
			const y =
				SKETCH_PADDING +
				(1 - Math.min(1, Math.max(0, fraction))) * usableHeight;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join("L")}`;
}

/** Preset shapes never change, so each sketch is drawn once. */
const SKETCH_PATHS = new Map<RetimeCurvePresetId, string>(
	RETIME_CURVE_PRESETS.map((preset) => [
		preset.id,
		buildSketchPath({ presetId: preset.id }),
	]),
);

function PresetTile({
	label,
	isSelected,
	onSelect,
	children,
}: {
	label: string;
	isSelected: boolean;
	onSelect: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex cursor-pointer flex-col items-center gap-1.5"
		>
			<span
				className={cn(
					"bg-foreground/5 flex h-11 w-full items-center justify-center rounded-md border border-transparent transition-colors",
					"hover:bg-foreground/10",
					isSelected && "border-primary bg-primary/10",
				)}
			>
				{children}
			</span>
			<span
				className={cn(
					"text-muted-foreground w-full truncate text-center text-[10px] leading-none",
					isSelected && "text-foreground",
				)}
			>
				{label}
			</span>
		</button>
	);
}

export function SpeedCurvePresets({
	selectedPreset,
	onSelect,
	onClear,
}: {
	selectedPreset?: RetimeCurvePresetId;
	onSelect: (presetId: RetimeCurvePresetId) => void;
	onClear: () => void;
}) {
	return (
		<div className="grid grid-cols-4 gap-2">
			<PresetTile
				label="None"
				isSelected={selectedPreset === undefined}
				onSelect={onClear}
			>
				<BanIcon className="text-muted-foreground size-4" />
			</PresetTile>

			{RETIME_CURVE_PRESETS.map((preset) => (
				<PresetTile
					key={preset.id}
					label={preset.label}
					// Dragging a handle does not change which preset the curve came
					// from, so the tile stays lit and Reset has something to restore.
					isSelected={selectedPreset === preset.id}
					onSelect={() => onSelect(preset.id)}
				>
					{preset.id === "custom" ? (
						<SlidersHorizontalIcon className="text-muted-foreground size-4" />
					) : (
						<svg
							viewBox={`0 0 ${SKETCH_WIDTH} ${SKETCH_HEIGHT}`}
							className="h-[22px] w-10"
							aria-hidden="true"
						>
							<path
								d={SKETCH_PATHS.get(preset.id)}
								fill="none"
								className="stroke-foreground/70"
								strokeWidth={1.5}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					)}
				</PresetTile>
			))}
		</div>
	);
}
