import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type {
	ScalarAnimationChannel,
	ScalarAnimationKey,
	ScalarSegmentType,
} from "@/animation/types";
// `interpolation.ts` pulls `mediaTime` from `@/wasm`, whose bundler-target wasm
// cannot initialise under `bun test`. Swap the raw package for the nodejs-target
// build of the same crate so the real façade loads — including the integer-tick
// check in `mediaTime`, which an identity stub used to skip.
//
// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const { getChannelValueAtTime, normalizeScalarChannel } =
	await import("@/wasm/animation");
const {
	getBezierPoint,
	getDefaultLeftHandle,
	getDefaultRightHandle,
	solveBezierProgressForTime,
} = await import("@/wasm");
const { clamp } = await import("@/utils/math");
// The real branded constructor, so key times built here are checked the same
// way the implementation checks them.
const { mediaTime } = await import("@/wasm");

/**
 * Reads a value off a channel the plain way: normalize, then walk the keys from
 * the start looking for the segment that contains `time`.
 *
 * The evaluator now lives in `editor-core::animation::interpolation`, so this
 * naive version is an independent reference for it rather than a second opinion
 * on sibling TypeScript — which makes it more useful after the port than before.
 *
 * This is deliberately the naive implementation. `getScalarChannelValueAtTime`
 * bisects instead, and bisection is easy to get subtly wrong at the edges —
 * exactly-on-a-key times, times outside the channel's span, and two keys
 * sharing a time. Keeping an obvious version to compare against is what caught
 * the last of those.
 */
function referenceValueAtTime({
	channel,
	time,
	fallbackValue,
}: {
	channel: ScalarAnimationChannel;
	time: number;
	fallbackValue: number;
}): number {
	if (channel.keys.length === 0) return fallbackValue;

	const normalized = normalizeScalarChannel({ channel });
	const firstKey = normalized.keys[0];
	const lastKey = normalized.keys[normalized.keys.length - 1];
	if (!firstKey || !lastKey) return fallbackValue;

	const extrapolate = ({
		mode,
		edgeKey,
		neighborKey,
	}: {
		mode: "hold" | "linear";
		edgeKey: ScalarAnimationKey;
		neighborKey: ScalarAnimationKey | undefined;
	}): number => {
		if (mode === "hold" || !neighborKey) return edgeKey.value;
		const span = neighborKey.time - edgeKey.time;
		if (span === 0) return edgeKey.value;
		return (
			edgeKey.value +
			((time - edgeKey.time) / span) * (neighborKey.value - edgeKey.value)
		);
	};

	if (time <= firstKey.time) {
		if (time < firstKey.time) {
			return extrapolate({
				mode: normalized.extrapolation?.before ?? "hold",
				edgeKey: firstKey,
				neighborKey: normalized.keys[1],
			});
		}
		return firstKey.value;
	}

	if (time >= lastKey.time) {
		if (time > lastKey.time) {
			return extrapolate({
				mode: normalized.extrapolation?.after ?? "hold",
				edgeKey: lastKey,
				neighborKey: normalized.keys[normalized.keys.length - 2],
			});
		}
		return lastKey.value;
	}

	for (let index = 0; index < normalized.keys.length - 1; index++) {
		const leftKey = normalized.keys[index];
		const rightKey = normalized.keys[index + 1];
		if (time === rightKey.time) return rightKey.value;
		if (!(time >= leftKey.time && time <= rightKey.time)) continue;
		if (leftKey.segmentToNext === "step") return leftKey.value;

		const span = rightKey.time - leftKey.time;
		if (span === 0) return rightKey.value;

		if (leftKey.segmentToNext === "linear") {
			const progress = clamp({
				value: (time - leftKey.time) / span,
				min: 0,
				max: 1,
			});
			return leftKey.value + (rightKey.value - leftKey.value) * progress;
		}

		const rightHandle =
			leftKey.rightHandle ?? getDefaultRightHandle({ leftKey, rightKey });
		const leftHandle =
			rightKey.leftHandle ?? getDefaultLeftHandle({ leftKey, rightKey });
		return getBezierPoint({
			progress: solveBezierProgressForTime({ time, leftKey, rightKey }),
			p0: leftKey.value,
			p1: leftKey.value + rightHandle.dv,
			p2: rightKey.value + leftHandle.dv,
			p3: rightKey.value,
		});
	}

	return lastKey.value;
}

test("reading a scalar channel matches a plain walk of its keys", () => {
	// Fixed seed so a failure names a reproducible channel.
	let seed = 0x2545f491;
	const random = (): number => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return ((seed >>> 0) % 100000) / 100000;
	};

	const SEGMENTS: readonly ScalarSegmentType[] = ["step", "linear", "bezier"];
	const EXTRAPOLATIONS = ["hold", "linear"] as const;
	const mismatches: string[] = [];
	let compared = 0;

	for (let trial = 0; trial < 4000; trial++) {
		const keyCount = 1 + Math.floor(random() * 12);
		const keys: ScalarAnimationKey[] = [];
		for (let index = 0; index < keyCount; index++) {
			keys.push({
				id: `key-${index}`,
				// Unsorted, on a coarse grid so times collide often: two keyframes
				// sharing a time is the case bisection gets wrong most easily.
				time: mediaTime({ ticks: Math.round(random() * 40) * 25 }),
				value: Math.round(random() * 200) - 100,
				segmentToNext: SEGMENTS[Math.floor(random() * SEGMENTS.length)],
				tangentMode: "flat",
			});
		}

		const channel: ScalarAnimationChannel = {
			keys,
			extrapolation:
				random() < 0.5
					? {
							before: EXTRAPOLATIONS[Math.floor(random() * 2)],
							after: EXTRAPOLATIONS[Math.floor(random() * 2)],
						}
					: undefined,
		};

		for (let probe = 0; probe < 40; probe++) {
			// Every fourth probe lands exactly on a key; the rest sweep across and
			// beyond the channel's span to cover both extrapolation edges.
			const time =
				probe % 4 === 0
					? (keys[Math.floor(random() * keys.length)]?.time ?? 0)
					: Math.round(random() * 1200) - 100;

			const actual = getChannelValueAtTime({
				channel,
				time,
				fallbackValue: 7.5,
			});
			const expected = referenceValueAtTime({
				channel,
				time,
				fallbackValue: 7.5,
			});
			compared++;

			if (Math.abs(actual - expected) >= 1e-9 && mismatches.length < 5) {
				mismatches.push(
					`t=${time} got ${actual}, expected ${expected}, keys ${JSON.stringify(
						keys.map((key) => [key.time, key.value, key.segmentToNext]),
					)}`,
				);
			}
		}
	}

	expect(compared).toBeGreaterThan(100_000);
	expect(mismatches).toEqual([]);
});
