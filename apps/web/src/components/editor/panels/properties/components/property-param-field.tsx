"use client";

import { useState } from "react";
import type {
	ParamDefinition,
	NumberParamDefinition,
	ParamValue,
} from "@/params";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";
import { SectionField } from "@/components/section";
import { NumberField } from "@/components/ui/number-field";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ColorPicker } from "@/components/ui/color-picker";
import { FontPicker } from "@/components/ui/font-picker";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useFrameSampler } from "@/preview/use-frame-sampler";
import { usePropertyDraft } from "../hooks/use-property-draft";
import { KeyframeToggle } from "./keyframe-toggle";
import { Textarea } from "@/components/ui/textarea";

export function PropertyParamField({
	param,
	value,
	onPreview,
	onCommit,
	keyframe,
	sampleImageUrl,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	keyframe?: {
		isActive: boolean;
		isAnimated: boolean;
		isDisabled: boolean;
		onToggle: () => void;
	};
	/**
	 * A still of the layer this param belongs to, for an eyedropper param to sample
	 * out of. Only read by `control: "eyedropper"` colour params.
	 */
	sampleImageUrl?: string;
}) {
	return (
		<SectionField
			label={param.label}
			beforeLabel={
				keyframe && param.keyframable !== false ? (
					<KeyframeToggle
						isActive={keyframe.isActive}
						isAnimated={keyframe.isAnimated}
						isDisabled={keyframe.isDisabled}
						label={param.label.toLowerCase()}
						onToggle={keyframe.onToggle}
					/>
				) : undefined
			}
		>
			<ParamInput
				param={param}
				value={value}
				onPreview={onPreview}
				onCommit={onCommit}
				sampleImageUrl={sampleImageUrl}
			/>
		</SectionField>
	);
}

function ParamInput({
	param,
	value,
	onPreview,
	onCommit,
	sampleImageUrl,
}: {
	param: ParamDefinition;
	value: ParamValue;
	onPreview: (value: ParamValue) => void;
	onCommit: () => void;
	sampleImageUrl?: string;
}) {
	const requestSampleImage = useFrameSampler();

	if (param.type === "number") {
		const numericValue = typeof value === "number" ? value : Number(value);
		if (param.control === "slider") {
			// The slider gives up the right-hand end of the row to the number field,
			// which is what carries the readout and the reset affordance.
			return (
				<div className="flex items-center gap-2">
					<NumberParamSlider
						param={param}
						value={numericValue}
						onPreview={onPreview}
						onCommit={onCommit}
					/>
					<NumberParamField
						param={param}
						value={numericValue}
						onPreview={onPreview}
						onCommit={onCommit}
						className="w-[5.5rem] shrink-0"
					/>
				</div>
			);
		}
		return (
			<NumberParamField
				param={param}
				value={numericValue}
				onPreview={onPreview}
				onCommit={onCommit}
			/>
		);
	}

	if (param.type === "boolean") {
		return (
			<Switch
				checked={Boolean(value)}
				onCheckedChange={(checked) => {
					onPreview(checked);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "select") {
		return (
			<Select
				value={String(value)}
				onValueChange={(selected) => {
					onPreview(selected);
					onCommit();
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{param.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	}

	if (param.type === "color") {
		// One control for every colour in the editor, eyedropper param or not. The
		// two differ only in where the eyedropper reads from: a chroma key samples
		// its clip's untouched still, because the green it needs is the green as
		// shot rather than the one the key has already begun removing, while every
		// other colour samples the composited frame the user is looking at.
		const sampleSource =
			param.control === "eyedropper" && sampleImageUrl
				? async () => sampleImageUrl
				: requestSampleImage;

		return (
			<ColorPicker
				value={String(value).replace(/^#/, "").toUpperCase()}
				sampleLabel={param.label.toLowerCase()}
				onRequestSampleImage={sampleSource}
				onChange={(color) => onPreview(`#${color}`)}
				onChangeEnd={(color) => {
					onPreview(`#${color}`);
					onCommit();
				}}
			/>
		);
	}

	if (param.type === "text") {
		return (
			<Textarea
				value={String(value)}
				onChange={(event) => onPreview(event.currentTarget.value)}
				onBlur={onCommit}
			/>
		);
	}

	if (param.type === "font") {
		return (
			<FontPicker
				defaultValue={String(value)}
				onValueChange={(family) => {
					onPreview(family);
					onCommit();
				}}
			/>
		);
	}

	return null;
}

function NumberParamSlider({
	param,
	value,
	onPreview,
	onCommit,
}: {
	param: NumberParamDefinition;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
}) {
	const max = param.max ?? 100;
	// Previewing writes to the preview overlay, but `value` is read back off the
	// committed element, so it does not budge until the drag ends. A thumb
	// controlled by it alone would be yanked back on every pointermove — i.e. it
	// would not move at all — so the in-flight position lives here until
	// `commitPreview` makes it real.
	const [dragValue, setDragValue] = useState<number | null>(null);
	const displayValue = Math.min(max, Math.max(param.min, dragValue ?? value));

	return (
		<Slider
			aria-label={param.label}
			className="min-w-0 flex-1"
			min={param.min}
			max={max}
			step={param.step}
			value={[displayValue]}
			trackGradient={param.trackGradient}
			thumbClassName="border-background bg-primary border-2"
			// Radix reports every position during the drag, then once more when the
			// pointer or key is released, which is exactly the preview/commit split
			// the property fields expect.
			onValueChange={([next]) => {
				setDragValue(next);
				onPreview(next);
			}}
			onValueCommit={([next]) => {
				onPreview(next);
				// Committing applies the overlay synchronously, so `value` has already
				// caught up by the time the drag position is dropped.
				onCommit();
				setDragValue(null);
			}}
		/>
	);
}

function NumberParamField({
	param,
	value,
	onPreview,
	onCommit,
	className,
}: {
	param: NumberParamDefinition;
	value: number;
	onPreview: (value: number) => void;
	onCommit: () => void;
	className?: string;
}) {
	// `unit: "percent"` maps a stored 0..max range onto a 0..100 display range,
	// matching how the masks panel presents percent params. min/max stay in
	// stored space in the definition so coerceParamValue keeps clamping
	// correctly; only the display range is rescaled here.
	const isPercent = param.unit === "percent";
	const percentMax = param.max ?? 100;
	const displayMultiplier = isPercent
		? 100 / percentMax
		: (param.displayMultiplier ?? 1);
	const min = isPercent ? 0 : param.min;
	const max = isPercent ? 100 : param.max;
	const step = isPercent ? 1 : param.step;
	const suffix = param.suffix ?? (isPercent ? "%" : undefined);
	const displayValue = value * displayMultiplier;
	const clampDisplayValue = (nextDisplayValue: number) =>
		Math.max(
			min,
			max !== undefined ? Math.min(max, nextDisplayValue) : nextDisplayValue,
		);

	const previewFromDisplay = (displayVal: number) => {
		const clamped = clampDisplayValue(snapToStep({ value: displayVal, step }));
		onPreview(clamped / displayMultiplier);
	};

	const maxFractionDigits = getFractionDigitsForStep({ step });

	const draft = usePropertyDraft({
		displayValue: formatNumberForDisplay({
			value: displayValue,
			maxFractionDigits,
		}),
		parse: (input) => {
			const parsed = parseFloat(input);
			if (Number.isNaN(parsed)) return null;
			return clampDisplayValue(snapToStep({ value: parsed, step }));
		},
		onPreview: previewFromDisplay,
		onCommit,
	});

	const handleReset = () => {
		onPreview(param.default);
		onCommit();
	};

	return (
		<NumberField
			className={className}
			icon={param.shortLabel}
			suffix={suffix}
			suffixClassName="text-muted-foreground"
			value={draft.displayValue}
			dragSensitivity="slow"
			isDefault={value === param.default}
			onFocus={draft.onFocus}
			onChange={draft.onChange}
			onBlur={draft.onBlur}
			onScrub={previewFromDisplay}
			onScrubEnd={onCommit}
			onReset={handleReset}
		/>
	);
}
