import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { FreezeConfig, RetimeConfig } from "@/timeline";

mock.module("bluper-wasm", () => wasmNative);

const { resolveSampledSourceTime } = await import("@/freeze");
const { getSourceTimeAtClipTime } = await import("@/wasm/retime");
const { roundMediaTime } = await import("@/wasm/media-time");
const { findParityMismatch, equalsExact, createRng: _createRng } = await import(
	"@/testing/parity"
);
type Rng = ReturnType<typeof _createRng>;

/**
 * `resolveSampledSourceTime` moved to `editor-core::freeze`, and the TypeScript
 * reference it was held equal to is gone. There is no second implementation
 * left to diff against, so the differential below is against the
 * *decomposition*: the freeze passthrough plus the `getSourceTimeAtClipTime`
 * and `roundMediaTime` calls the consolidated one folds into a single crossing.
 * That is what the consolidation could plausibly break, and it stays a real
 * comparison because either side can move without the other.
 */

interface SampleInput {
	freeze: FreezeConfig | undefined;
	trimStart: number;
	clipTime: number;
	clipDuration: number | undefined;
	retime: RetimeConfig | undefined;
}

function makeRetime(rng: Rng): RetimeConfig | undefined {
	if (rng.bool()) return undefined;
	return { rate: rng.range({ min: 0.1, max: 4 }) };
}

function makeInput({ rng }: { rng: Rng }): SampleInput {
	return {
		freeze: rng.bool()
			? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			  { sourceTime: rng.int({ min: 0, max: 60_000 }) as never }
			: undefined,
		trimStart: rng.int({ min: 0, max: 60_000 }),
		clipTime: rng.range({ min: 0, max: 10_000 }),
		clipDuration: rng.bool()
			? rng.range({ min: 100, max: 10_000 })
			: undefined,
		retime: makeRetime(rng),
	};
}

/** The freeze rule and the two source-time calls, composed here rather than in Rust. */
function runDecomposed({ input }: { input: SampleInput }): number {
	if (input.freeze) {
		return Number(input.freeze.sourceTime);
	}
	return Number(
		roundMediaTime({
			time:
				input.trimStart +
				getSourceTimeAtClipTime({
					clipTime: input.clipTime,
					clipDuration: input.clipDuration,
					retime: input.retime,
				}),
		}),
	);
}

function runRust({ input }: { input: SampleInput }): number {
	return Number(
		resolveSampledSourceTime({
			freeze: input.freeze,
			trimStart: input.trimStart,
			clipTime: input.clipTime,
			clipDuration: input.clipDuration,
			retime: input.retime,
		}),
	);
}

test("a frozen clip ignores its retime", () => {
	expect(
		runRust({
			input: {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				freeze: { sourceTime: 12_345 as never },
				trimStart: 0,
				clipTime: 500,
				clipDuration: 1000,
				retime: { rate: 2 },
			},
		}),
	).toBe(12_345);
});

test("a uniform rate walks the source at its own speed", () => {
	expect(
		runRust({
			input: {
				freeze: undefined,
				trimStart: 1000,
				clipTime: 2000,
				clipDuration: 4000,
				retime: { rate: 2 },
			},
		}),
	).toBe(5000);
});

test("parity over generated inputs", () => {
	const mismatch = findParityMismatch({
		generate: makeInput,
		ts: runDecomposed,
		rust: runRust,
		equals: equalsExact,
		iterations: 5_000,
	});
	expect(mismatch).toBeNull();
});
