import type { NumberParamDefinition } from "@/params";

/**
 * CapCut's adjustment sliders are all integers on a -100..100 (or 0..100) scale,
 * with 0 as "leave it alone". Keeping the stored range identical means the panel
 * can show the raw number the way CapCut does.
 */
export function signedParam({
	key,
	label,
}: {
	key: string;
	label: string;
}): NumberParamDefinition {
	return {
		key,
		label,
		type: "number",
		default: 0,
		min: -100,
		max: 100,
		step: 1,
		keyframable: false,
	};
}

export function unsignedParam({
	key,
	label,
}: {
	key: string;
	label: string;
}): NumberParamDefinition {
	return {
		key,
		label,
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
		keyframable: false,
	};
}

/** Slider value → -1..1, with anything unset treated as neutral. */
export function readAmount({ value }: { value: unknown }): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(-1, value / 100));
}

export function isNeutral({ amount }: { amount: number }): boolean {
	return Math.abs(amount) < 0.001;
}

export function formatFilterNumber({ value }: { value: number }): string {
	return Number(value.toFixed(4)).toString();
}
