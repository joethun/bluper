import { expect, test } from "bun:test";
import {
	createRng,
	describeParityMismatch,
	equalsApprox,
	equalsExact,
	equalsRelative,
	findParityMismatch,
} from "@/testing/parity";

/**
 * The harness is the safety net for every stage of the Rust migration, so it
 * gets its own tests: a net with a hole in it is worse than no net, because the
 * port it waves through looks verified.
 */

test("agreeing implementations report no mismatch", () => {
	const mismatch = findParityMismatch({
		iterations: 500,
		generate: ({ rng }) => rng.range({ min: -1000, max: 1000 }),
		ts: ({ input }) => Math.abs(input),
		rust: ({ input }) => (input < 0 ? -input : input),
	});
	expect(mismatch).toBeNull();
});

test("a float that drifts in the last bits is caught, not rounded away", () => {
	// Repeated addition against a single multiply: 0.1 summed ten times is
	// 0.9999999999999999, not 1. This is the shape of the real risk — a Rust
	// port that builds an integral table by accumulating where the TypeScript
	// multiplied, or vice versa, differs only in the last bits.
	const mismatch = findParityMismatch({
		iterations: 1,
		generate: () => 0.1,
		ts: ({ input }) => {
			let sum = 0;
			for (let step = 0; step < 10; step += 1) sum += input;
			return sum;
		},
		rust: ({ input }) => input * 10,
	});
	expect(mismatch).not.toBeNull();
});

test("-0 is a difference, since it propagates into stored data", () => {
	const mismatch = findParityMismatch({
		iterations: 1,
		generate: () => 0,
		ts: () => 0,
		rust: () => -0,
	});
	expect(mismatch).not.toBeNull();
});

test("NaN on both sides is parity, not drift", () => {
	const mismatch = findParityMismatch({
		iterations: 1,
		generate: () => 0,
		ts: () => Number.NaN,
		rust: () => Number.NaN,
	});
	expect(mismatch).toBeNull();
});

test("both sides rejecting an input is parity; only one rejecting is not", () => {
	expect(
		findParityMismatch({
			iterations: 10,
			generate: () => 0,
			ts: () => {
				throw new Error("ts rejects");
			},
			rust: () => {
				throw new Error("rust rejects, with a different message");
			},
		}),
	).toBeNull();

	expect(
		findParityMismatch({
			iterations: 10,
			generate: () => 0,
			ts: () => {
				throw new Error("only ts rejects");
			},
			rust: () => 0,
		}),
	).not.toBeNull();
});

test("nested structures are compared by value, including key sets", () => {
	expect(
		equalsExact({
			a: { outer: [{ inner: 1 }, { inner: 2 }] },
			b: { outer: [{ inner: 1 }, { inner: 2 }] },
		}),
	).toBe(true);
	expect(equalsExact({ a: { one: 1 }, b: { one: 1, two: undefined } })).toBe(
		false,
	);
	expect(equalsExact({ a: [1, 2], b: [1, 2, 3] })).toBe(false);
});

test("equalsApprox tolerates its epsilon and nothing beyond it", () => {
	const within = equalsApprox({ epsilon: 1e-9 });
	expect(within({ a: 1, b: 1 + 5e-10 })).toBe(true);
	expect(within({ a: 1, b: 1 + 5e-8 })).toBe(false);
	// Structure still has to match exactly — the tolerance is only for leaves.
	expect(within({ a: { v: 1 }, b: { w: 1 } })).toBe(false);
});

test("a run is reproducible from its reported seed", () => {
	const options = {
		iterations: 200,
		seed: 12345,
		generate: ({ rng }: { rng: ReturnType<typeof createRng> }) =>
			rng.int({ min: -50, max: 50 }),
		ts: ({ input }: { input: number }) => input,
		rust: ({ input }: { input: number }) => (input === 7 ? 0 : input),
	};
	const first = findParityMismatch(options);
	const second = findParityMismatch(options);
	expect(first).not.toBeNull();
	expect(second).toEqual(first);
});

test("the failure message distinguishes -0 from 0", () => {
	// JSON.stringify renders -0 as 0, which would print the one difference
	// equalsExact is built to catch as two identical lines.
	const mismatch = findParityMismatch({
		iterations: 1,
		generate: () => ({}),
		ts: () => ({ value: -0 }),
		rust: () => ({ value: 0 }),
	});
	expect(mismatch).not.toBeNull();
	if (!mismatch) return;
	expect(describeParityMismatch({ mismatch })).toContain('"-0"');
});

test("the failure message names the seed, the input and both outputs", () => {
	const mismatch = findParityMismatch({
		iterations: 1,
		seed: 99,
		generate: () => 5,
		ts: () => 1,
		rust: () => 2,
	});
	expect(mismatch).not.toBeNull();
	if (!mismatch) return;
	const described = describeParityMismatch({ mismatch });
	expect(described).toContain("seed 99");
	expect(described).toContain("input: 5");
	expect(described).toContain("ts: 1");
	expect(described).toContain("rust: 2");
});

test("the harness can drive the real Rust build across the wasm boundary", async () => {
	// The bundler-target `bluper-wasm` the app imports cannot initialise
	// outside a bundler, so parity tests use the nodejs-target build of the
	// same crate (`bun run wasm:test`). The shipped bundler artifact stays
	// covered by `/desktop-check`.
	const wasm = await import("bluper-wasm-native");
	const TICKS_PER_SECOND = wasm.TICKS_PER_SECOND();

	const mismatch = findParityMismatch({
		iterations: 2000,
		generate: ({ rng }) => rng.int({ min: -5_000_000, max: 5_000_000 }),
		ts: ({ input }) => input / TICKS_PER_SECOND,
		rust: ({ input }) => wasm.mediaTimeToSeconds({ time: input }),
	});

	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});

test("equalsRelative scales its tolerance with the magnitude", () => {
	const within = equalsRelative({ epsilon: 1e-12 });
	// A one-ulp difference is tolerated at any size...
	expect(within({ a: 850.7356548088851, b: 850.7356548088852 })).toBe(true);
	expect(within({ a: 3776.26891475795, b: 3776.2689147579495 })).toBe(true);
	// ...but a real mistake is not, however small it looks next to the value.
	expect(within({ a: 850.7356548088851, b: 850.7356558088851 })).toBe(false);
	// Below one it falls back to absolute, so tiny values are not compared
	// against a tolerance that has shrunk to nothing.
	expect(within({ a: 1e-20, b: 2e-20 })).toBe(true);
	expect(within({ a: 0.5, b: 0.5000001 })).toBe(false);
});
