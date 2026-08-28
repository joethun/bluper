import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { describeParityMismatch, findParityMismatch } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

const {
	getTimelinePixelsPerSecond,
	timelineTimeToPixels,
	timelinePixelsToTime,
	timelineTimeToSnappedPixels,
	getCenteredLineLeft,
	TIMELINE_INDICATOR_LINE_WIDTH_PX,
} = await import("@/wasm/pixel-utils");
// Imported after the mock, not statically at the top: a top-level `import` is
// hoisted above `mock.module`, so it would load the bundler-target package that
// `bun test` cannot initialise. A full-suite run hides that — some earlier file
// has already installed the process-global mock — so this file would only fail
// when run on its own.
const { mediaTime } = await import("@/wasm/media-time");

/**
 * Timeline content-space math, owned by `editor-core::timeline::pixel_utils`.
 * Pinned cases + differential parity against hand-rolled TS reference.
 */

test("getTimelinePixelsPerSecond scales the base", () => {
	expect(getTimelinePixelsPerSecond({ zoomLevel: 1 })).toBe(50);
	expect(getTimelinePixelsPerSecond({ zoomLevel: 2 })).toBe(100);
	expect(getTimelinePixelsPerSecond({ zoomLevel: 0.5 })).toBe(25);
	expect(getTimelinePixelsPerSecond({ zoomLevel: 0 })).toBe(0);
});

test("timelineTimeToPixels computes the conversion", () => {
	expect(
		timelineTimeToPixels({ time: 0, zoomLevel: 1 }),
	).toBe(0);
	// 1 second at zoom 1 = 50 px
	expect(
		timelineTimeToPixels({ time: 120000, zoomLevel: 1 }),
	).toBe(50);
	// half a second at zoom 2 = 50 px
	expect(
		timelineTimeToPixels({ time: 60000, zoomLevel: 2 }),
	).toBe(50);
});

test("timelinePixelsToTime inverse of the conversion", () => {
	expect(timelinePixelsToTime({ pixels: 0, zoomLevel: 1 })).toBe(
		mediaTime({ ticks: 0 }),
	);
	expect(timelinePixelsToTime({ pixels: 50, zoomLevel: 1 })).toBe(
		mediaTime({ ticks: 120000 }),
	);
	expect(timelinePixelsToTime({ pixels: 100, zoomLevel: 2 })).toBe(
		mediaTime({ ticks: 120000 }),
	);
});

test("timelinePixelsToTime clamps negative pixels to zero", () => {
	expect(timelinePixelsToTime({ pixels: -1000, zoomLevel: 1 })).toBe(
		mediaTime({ ticks: 0 }),
	);
});

test("timelineTimeToSnappedPixels rounds to the device pixel grid", () => {
	// dpr=1: no rounding
	expect(
		timelineTimeToSnappedPixels({
			time: 0,
			zoomLevel: 1,
			devicePixelRatio: 1,
		}),
	).toBe(0);
	// dpr=2: 50 px in device coords = 25 css px (snap to half pixel = back to integer)
	const snappedDpr2 = timelineTimeToSnappedPixels({
		time: 120000,
		zoomLevel: 1,
		devicePixelRatio: 2,
	});
	expect(snappedDpr2).toBe(50);
	// dpr=2 with a half-pixel offset: should round back
	const halfPixelSnapped = timelineTimeToSnappedPixels({
		time: 60000,
		zoomLevel: 1,
		devicePixelRatio: 2,
	});
	expect(halfPixelSnapped).toBe(25);
});

test("timelineTimeToSnappedPixels falls back when dpr is invalid", () => {
	// 0 isn't a valid dpr but the Rust side treats anything non-positive as 1.
	const rawWithZero = timelineTimeToSnappedPixels({
		time: 0,
		zoomLevel: 1,
		devicePixelRatio: 0,
	});
	const explicitOne = timelineTimeToSnappedPixels({
		time: 0,
		zoomLevel: 1,
		devicePixelRatio: 1,
	});
	expect(rawWithZero).toBe(explicitOne);
});

test("getCenteredLineLeft subtracts half the width", () => {
	expect(
		getCenteredLineLeft({ centerPixel: 10 }),
	).toBe(10 - TIMELINE_INDICATOR_LINE_WIDTH_PX / 2);
	expect(
		getCenteredLineLeft({ centerPixel: 10, lineWidthPx: 4 }),
	).toBe(8);
	expect(
		getCenteredLineLeft({ centerPixel: 10.5 }),
	).toBe(10.5 - TIMELINE_INDICATOR_LINE_WIDTH_PX / 2);
});

test("pixel-math parity over generated inputs", () => {
	const TICKS_PER_SECOND = 120000;
	const BASE = 50;
	const mismatch = findParityMismatch({
		iterations: 2_000,
		seed: 0x1010e1,
		generate: ({ rng }) => ({
			zoomLevel: rng.range({ min: 0.25, max: 8 }),
			time: rng.int({ min: -2000, max: 5_000 }),
			pixels: rng.range({ min: -200, max: 5_000 }),
			devicePixelRatio: rng.pick({ from: [1, 1.5, 2, 3] }),
		}),
		ts: ({ input }) => {
			const getPps = (z: number) => BASE * z;
			const rawPixel = (input.time / TICKS_PER_SECOND) * getPps(input.zoomLevel);
			return {
				pps: getPps(input.zoomLevel),
				timeToPx: rawPixel,
				pxToTime: Math.max(
					0,
					Math.round(
						(input.pixels / getPps(input.zoomLevel)) * TICKS_PER_SECOND,
					),
				),
				// Negative times reach this — a clip dragged left of zero — and
				// `Math.round` answers `-0` just below zero. `equalsExact` compares
				// zeroes with `Object.is`, so this field is what catches a rounding
				// helper on the Rust side that loses the sign.
				snappedPx:
					Math.round(rawPixel * input.devicePixelRatio) /
					input.devicePixelRatio,
				center: 100 - 2 / 2,
			};
		},
		rust: ({ input }) => ({
			pps: getTimelinePixelsPerSecond({ zoomLevel: input.zoomLevel }),
			timeToPx: timelineTimeToPixels({
				time: input.time,
				zoomLevel: input.zoomLevel,
			}),
			pxToTime: timelinePixelsToTime({
				pixels: input.pixels,
				zoomLevel: input.zoomLevel,
			}),
			snappedPx: timelineTimeToSnappedPixels({
				time: input.time,
				zoomLevel: input.zoomLevel,
				devicePixelRatio: input.devicePixelRatio,
			}),
			center: getCenteredLineLeft({ centerPixel: 100 }),
		}),
	});
	expect(mismatch ? describeParityMismatch({ mismatch }) : null).toBeNull();
});
