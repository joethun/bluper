/**
 * Differential parity harness for the Rust migration.
 *
 * Every module that moves to `rust/crates/*` gets a window where both
 * implementations exist: the original TypeScript and the new Rust reached
 * through `bluper-wasm`. This runs the pair over generated inputs and reports
 * the first disagreement. Once parity holds, the TypeScript is deleted — and at
 * that point this check is no longer possible to write, which is why it has to
 * happen during the port rather than after it.
 *
 * What it is for: catching *numeric drift*. A port that returns 0.30000000000004
 * where the original returned 0.3, or rounds -0.5 the other way, passes every
 * "does it run" check in the repo and ships. `equalsExact` is therefore the
 * default; reach for `equalsApprox` only when a difference is genuinely
 * acceptable, and say why at the call site.
 *
 * Generation is seeded so a failure reproduces from the reported seed alone.
 */

/** Deterministic PRNG (mulberry32). Seeded so failures replay exactly. */
export interface Rng {
	/** Uniform in [0, 1). */
	float(): number;
	/** Uniform integer in [min, max], inclusive. */
	int({ min, max }: { min: number; max: number }): number;
	/** Uniform in [min, max). */
	range({ min, max }: { min: number; max: number }): number;
	bool(): boolean;
	pick<T>({ from }: { from: readonly T[] }): T;
}

export function createRng({ seed }: { seed: number }): Rng {
	let state = seed >>> 0;

	function float(): number {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	return {
		float,
		int({ min, max }) {
			return min + Math.floor(float() * (max - min + 1));
		},
		range({ min, max }) {
			return min + float() * (max - min);
		},
		bool() {
			return float() < 0.5;
		},
		pick({ from }) {
			if (from.length === 0) {
				throw new Error("Rng.pick: cannot pick from an empty list");
			}
			return from[Math.floor(float() * from.length)] as (typeof from)[number];
		},
	};
}

export interface ParityMismatch<TInput, TOutput> {
	/** Which iteration disagreed, so a long run can be narrowed. */
	iteration: number;
	/** The seed the whole run started from — replay with this to reproduce. */
	seed: number;
	input: TInput;
	ts: TOutput | { threw: string };
	rust: TOutput | { threw: string };
}

/**
 * Structural equality that treats the cases this codebase actually cares about
 * as differences rather than noise: `-0` is not `0` (`roundMediaTime` exists
 * specifically to stop `-0` reaching stored data), and `NaN` equals `NaN` so a
 * pair that both fail to produce a number is not reported as drift.
 */
export function equalsExact({ a, b }: { a: unknown; b: unknown }): boolean {
	if (typeof a === "number" && typeof b === "number") {
		if (Number.isNaN(a) && Number.isNaN(b)) return true;
		return Object.is(a, b);
	}
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		return a.every((item, index) => equalsExact({ a: item, b: b[index] }));
	}
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const aRecord = a as Record<string, unknown>;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const bRecord = b as Record<string, unknown>;
	const aKeys = Object.keys(aRecord).sort();
	const bKeys = Object.keys(bRecord).sort();
	if (aKeys.length !== bKeys.length) return false;
	if (!aKeys.every((key, index) => key === bKeys[index])) return false;
	return aKeys.every((key) =>
		equalsExact({ a: aRecord[key], b: bRecord[key] }),
	);
}

/**
 * Exact everywhere except leaf numbers, which may differ by up to `epsilon`.
 * Use when the Rust side legitimately cannot reproduce the TypeScript bit
 * pattern — a different summation order in an integral table, say — and record
 * the reason where you call it.
 */
export function equalsApprox({ epsilon }: { epsilon: number }) {
	function compare({ a, b }: { a: unknown; b: unknown }): boolean {
		if (typeof a === "number" && typeof b === "number") {
			if (Number.isNaN(a) && Number.isNaN(b)) return true;
			if (!Number.isFinite(a) || !Number.isFinite(b)) return Object.is(a, b);
			return Math.abs(a - b) <= epsilon;
		}
		if (a === b) return true;
		if (
			typeof a !== "object" ||
			typeof b !== "object" ||
			a === null ||
			b === null
		) {
			return false;
		}
		if (Array.isArray(a) || Array.isArray(b)) {
			if (!Array.isArray(a) || !Array.isArray(b)) return false;
			if (a.length !== b.length) return false;
			return a.every((item, index) => compare({ a: item, b: b[index] }));
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const aRecord = a as Record<string, unknown>;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const bRecord = b as Record<string, unknown>;
		const aKeys = Object.keys(aRecord).sort();
		const bKeys = Object.keys(bRecord).sort();
		if (aKeys.length !== bKeys.length) return false;
		if (!aKeys.every((key, index) => key === bKeys[index])) return false;
		return aKeys.every((key) => compare({ a: aRecord[key], b: bRecord[key] }));
	}
	return compare;
}

/**
 * Exact everywhere except leaf numbers, which may differ by a *relative*
 * `epsilon`. Prefer this to {@link equalsApprox} whenever the values span more
 * than a couple of orders of magnitude: a fixed absolute tolerance is far too
 * loose at the top of the range and impossibly tight at the bottom.
 *
 * The case this exists for is transcendentals. V8 ships its own `Math.log` and
 * `Math.exp` rather than calling the platform's, and Rust uses the system libm;
 * both are accurate to within an ulp but they need not agree on which one. A
 * port that only differs that way is faithful. One with a real mistake in it
 * misses by far more than an ulp, so this still fails.
 *
 * Near zero the comparison falls back to absolute, since relative error is
 * meaningless there.
 */
export function equalsRelative({ epsilon }: { epsilon: number }) {
	function compare({ a, b }: { a: unknown; b: unknown }): boolean {
		if (typeof a === "number" && typeof b === "number") {
			if (Number.isNaN(a) && Number.isNaN(b)) return true;
			if (!Number.isFinite(a) || !Number.isFinite(b)) return Object.is(a, b);
			const scale = Math.max(Math.abs(a), Math.abs(b));
			if (scale < 1) return Math.abs(a - b) <= epsilon;
			return Math.abs(a - b) <= scale * epsilon;
		}
		if (a === b) return true;
		if (
			typeof a !== "object" ||
			typeof b !== "object" ||
			a === null ||
			b === null
		) {
			return false;
		}
		if (Array.isArray(a) || Array.isArray(b)) {
			if (!Array.isArray(a) || !Array.isArray(b)) return false;
			if (a.length !== b.length) return false;
			return a.every((item, index) => compare({ a: item, b: b[index] }));
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const aRecord = a as Record<string, unknown>;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const bRecord = b as Record<string, unknown>;
		const aKeys = Object.keys(aRecord).sort();
		const bKeys = Object.keys(bRecord).sort();
		if (aKeys.length !== bKeys.length) return false;
		if (!aKeys.every((key, index) => key === bKeys[index])) return false;
		return aKeys.every((key) => compare({ a: aRecord[key], b: bRecord[key] }));
	}
	return compare;
}

/**
 * Run both implementations over generated inputs and return the first
 * disagreement, or `null` if they agree throughout.
 *
 * A throw counts as an outcome: both sides throwing is parity (the port
 * preserved the rejection), one side throwing is a mismatch. That matters
 * because several of these modules signal invalid input by throwing —
 * `requireMediaTime` does — and a port that silently returns a number instead
 * has changed behaviour even though it never disagrees on a valid input.
 */
export function findParityMismatch<TInput, TOutput>({
	iterations = 2000,
	seed = 0x9e3779b9,
	generate,
	ts,
	rust,
	equals = equalsExact,
}: {
	iterations?: number;
	seed?: number;
	generate: ({ rng }: { rng: Rng }) => TInput;
	ts: ({ input }: { input: TInput }) => TOutput;
	rust: ({ input }: { input: TInput }) => TOutput;
	equals?: ({ a, b }: { a: unknown; b: unknown }) => boolean;
}): ParityMismatch<TInput, TOutput> | null {
	const rng = createRng({ seed });

	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const input = generate({ rng });

		let tsOutcome: TOutput | { threw: string };
		let tsThrew = false;
		try {
			tsOutcome = ts({ input });
		} catch (error) {
			tsThrew = true;
			tsOutcome = {
				threw: error instanceof Error ? error.message : String(error),
			};
		}

		let rustOutcome: TOutput | { threw: string };
		let rustThrew = false;
		try {
			rustOutcome = rust({ input });
		} catch (error) {
			rustThrew = true;
			rustOutcome = {
				threw: error instanceof Error ? error.message : String(error),
			};
		}

		// Both rejecting is parity; the messages are free to differ, since they
		// cross the wasm boundary as strings and are not part of the contract.
		if (tsThrew && rustThrew) continue;
		if (tsThrew !== rustThrew) {
			return { iteration, seed, input, ts: tsOutcome, rust: rustOutcome };
		}
		if (!equals({ a: tsOutcome, b: rustOutcome })) {
			return { iteration, seed, input, ts: tsOutcome, rust: rustOutcome };
		}
	}

	return null;
}

/**
 * Render a mismatch as the assertion message. Kept separate from the search so
 * the harness stays framework-agnostic — the caller does the asserting.
 */
export function describeParityMismatch<TInput, TOutput>({
	mismatch,
}: {
	mismatch: ParityMismatch<TInput, TOutput>;
}): string {
	return [
		`parity broke on iteration ${mismatch.iteration} (seed ${mismatch.seed})`,
		`  input: ${describeValue({ value: mismatch.input })}`,
		`     ts: ${describeValue({ value: mismatch.ts })}`,
		`   rust: ${describeValue({ value: mismatch.rust })}`,
	].join("\n");
}

/**
 * `JSON.stringify` with the one case it cannot express spelled out: it renders
 * `-0` as `0`, so a mismatch that is *only* a sign of zero — the difference
 * {@link equalsExact} exists to catch, since it propagates into stored data —
 * would print two identical-looking lines and read as a harness bug rather than
 * a real find. `NaN` and the infinities become `null` for the same reason.
 */
function describeValue({ value }: { value: unknown }): string {
	return (
		JSON.stringify(value, (_key, raw: unknown) => {
			if (typeof raw !== "number") return raw;
			if (Object.is(raw, -0)) return "-0";
			if (Number.isNaN(raw)) return "NaN";
			if (raw === Number.POSITIVE_INFINITY) return "Infinity";
			if (raw === Number.NEGATIVE_INFINITY) return "-Infinity";
			return raw;
		}) ?? String(value)
	);
}
