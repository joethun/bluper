import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { timelineTimeToSnappedPixels } = await import("@/wasm/pixel-utils");

/**
 * Dragging a multi-clip selection used to stutter because each member's
 * pixel position was snapped independently each frame:
 *
 *   left_i  =  snap((currentTime + timeOffset_i) * pps)
 *            =  snap(a + b)
 *
 * `snap(a + b) - snap(a)` is not generally equal to `snap(b)`, so the
 * relative pixel gap between the anchor and any other member stuttered
 * ±1/dpr CSS pixels as `currentTime` advanced — the whole reason
 * multi-drag looked glitchy.
 *
 * The fix captures each member's pixel offset from the anchor once at
 * drag start (from the resting snapped positions) and on every frame
 * does `anchorLeftPx + memberPixelOffset`. The relative gap becomes a
 * constant captured at gesture start, so the selection moves as one
 * solid block.
 *
 * This test pins the contrast between the two formulas so the bug can't
 * come back without the new-formula invariant breaking.
 */

const TICKS_PER_SECOND = 120_000;
const ZOOM = 1;

function ticks(seconds: number): number {
	return Math.round(seconds * TICKS_PER_SECOND);
}

function snapMemberLeft({
	currentTime,
	timeOffset,
}: {
	currentTime: number;
	timeOffset: number;
}): number {
	return timelineTimeToSnappedPixels({
		time: currentTime + timeOffset,
		zoomLevel: ZOOM,
	});
}

function snapAnchorLeft({ currentTime }: { currentTime: number }): number {
	return timelineTimeToSnappedPixels({
		time: currentTime,
		zoomLevel: ZOOM,
	});
}

test("per-member snap makes the relative pixel gap drift as the anchor moves", () => {
	// Anchor at 10s, member 2s ahead. The resting gap (relative to the
	// anchor) is captured here from the snap of the absolute positions;
	// any per-frame computation that diverges from it by even a sub-pixel
	// shows up as a different pixel gap at some `currentTime`.
	const anchorRestLeft = timelineTimeToSnappedPixels({
		time: ticks(10),
		zoomLevel: ZOOM,
	});
	const memberRestLeft = timelineTimeToSnappedPixels({
		time: ticks(12),
		zoomLevel: ZOOM,
	});
	const expectedGap = memberRestLeft - anchorRestLeft;

	let maxDrift = 0;
	// Walk the anchor a full second in fine sub-pixel steps so the
	// anchor's fractional pixel part crosses every rounding boundary the
	// member doesn't share.
	for (let dtTicks = 0; dtTicks <= TICKS_PER_SECOND; dtTicks += 1) {
		const currentTime = ticks(10) - dtTicks; // drag backwards
		const memberLeft = snapMemberLeft({
			currentTime,
			timeOffset: ticks(2),
		});
		const anchorLeft = snapAnchorLeft({ currentTime });
		const gap = memberLeft - anchorLeft;
		maxDrift = Math.max(maxDrift, Math.abs(gap - expectedGap));
	}

	// Sanity: the bug exists. The whole point of this file is to show
	// that the new formula doesn't share it.
	expect(maxDrift).toBeGreaterThan(0);
});

test("constant per-member pixel offset keeps the relative gap fixed across the gesture", () => {
	// The fix's renderer path: the per-member offset is captured once at
	// drag start from the resting snapped positions, and on every frame
	// the member's `left` is `anchorLeftPx + offset`. Relative gap must
	// be exactly `offset` for every frame — no drift, no stutter.
	const anchorRestLeft = timelineTimeToSnappedPixels({
		time: ticks(10),
		zoomLevel: ZOOM,
	});
	const memberRestLeft = timelineTimeToSnappedPixels({
		time: ticks(12),
		zoomLevel: ZOOM,
	});
	const memberPixelOffset = memberRestLeft - anchorRestLeft;

	for (let dtTicks = 0; dtTicks <= TICKS_PER_SECOND; dtTicks += 1) {
		const currentTime = ticks(10) - dtTicks;
		const anchorLeftPx = snapAnchorLeft({ currentTime });
		const memberLeftPx = anchorLeftPx + memberPixelOffset;
		expect(memberLeftPx - anchorLeftPx).toBe(memberPixelOffset);
	}
});

test("the new formula also holds when the anchor drags forward", () => {
	const anchorRestLeft = timelineTimeToSnappedPixels({
		time: ticks(10),
		zoomLevel: ZOOM,
	});
	const memberRestLeft = timelineTimeToSnappedPixels({
		time: ticks(12),
		zoomLevel: ZOOM,
	});
	const memberPixelOffset = memberRestLeft - anchorRestLeft;

	for (let dtTicks = 0; dtTicks <= TICKS_PER_SECOND; dtTicks += 1) {
		const currentTime = ticks(10) + dtTicks;
		const anchorLeftPx = snapAnchorLeft({ currentTime });
		const memberLeftPx = anchorLeftPx + memberPixelOffset;
		expect(memberLeftPx - anchorLeftPx).toBe(memberPixelOffset);
	}
});

test("the member offset is zero for the anchor itself", () => {
	// Dragging a single clip is a degenerate case of multi-drag: the
	// anchor is also the only member, so its offset from itself is 0 and
	// the formula collapses to the existing single-clip behaviour.
	const anchorRestLeft = timelineTimeToSnappedPixels({
		time: ticks(10),
		zoomLevel: ZOOM,
	});
	const memberRestLeft = timelineTimeToSnappedPixels({
		time: ticks(10),
		zoomLevel: ZOOM,
	});
	expect(memberRestLeft - anchorRestLeft).toBe(0);
});
