import type {
	BooleanParamDefinition,
	NumberParamDefinition,
	ParamDefinition,
	ParamValues,
	SelectParamDefinition,
} from "@/params";

/**
 * Every bundled effect is steered by the same two or three controls the
 * reference panel shows (how strong, how fast, and whether it repeats), so they
 * are declared once here instead of being retyped per definition.
 */
export function amountParam({
	label = "Amount",
	value = 0.5,
}: {
	label?: string;
	value?: number;
} = {}): NumberParamDefinition {
	return {
		key: "amount",
		label,
		type: "number",
		default: value,
		min: 0,
		max: 1,
		step: 0.01,
		unit: "percent",
		control: "slider",
	};
}

function speedParam({
	value = 1,
}: {
	value?: number;
} = {}): NumberParamDefinition {
	return {
		key: "speed",
		label: "Speed",
		type: "number",
		default: value,
		min: 0.1,
		max: 3,
		step: 0.05,
		control: "slider",
		suffix: "x",
	};
}

function loopParam(): BooleanParamDefinition {
	return {
		key: "loop",
		label: "Loop",
		type: "boolean",
		default: true,
		keyframable: false,
	};
}

/** Amount, speed and loop, in the order the reference panel lists them. */
export function motionParams({
	amountLabel,
	amount = 0.5,
	speed = 1,
}: {
	amountLabel?: string;
	amount?: number;
	speed?: number;
} = {}): ParamDefinition[] {
	return [
		speedParam({ value: speed }),
		amountParam({ label: amountLabel, value: amount }),
		loopParam(),
	];
}

export function selectParam({
	key,
	label,
	value,
	options,
}: {
	key: string;
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
}): SelectParamDefinition {
	return {
		key,
		label,
		type: "select",
		default: value,
		keyframable: false,
		options,
	};
}

export function numberValue({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function booleanValue({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: boolean;
}): boolean {
	const value = params[key];
	return typeof value === "boolean" ? value : fallback;
}

export function stringValue({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: string;
}): string {
	const value = params[key];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Where an animated effect sits in its cycle, as 0..1. With `loop` off the
 * animation runs once and then holds at the end of the cycle, which for every
 * bundled effect is the frame that looks untouched.
 */
export function cyclePhase({
	time,
	speed,
	loop,
	period,
}: {
	time: number;
	speed: number;
	loop: boolean;
	period: number;
}): number {
	const cycles = (Math.max(0, time) * speed) / period;
	if (!loop) {
		return Math.min(1, cycles);
	}
	return cycles - Math.floor(cycles);
}

/** A sharp attack that decays over the rest of the cycle. */
export function beatEnvelope({
	phase,
	sharpness = 3,
}: {
	phase: number;
	sharpness?: number;
}): number {
	return Math.pow(1 - phase, sharpness);
}

export function easeOutCubic({ t }: { t: number }): number {
	const clamped = Math.min(1, Math.max(0, t));
	return 1 - Math.pow(1 - clamped, 3);
}

export function easeInOutCubic({ t }: { t: number }): number {
	const clamped = Math.min(1, Math.max(0, t));
	return clamped < 0.5
		? 4 * clamped * clamped * clamped
		: 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}
