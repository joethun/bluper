import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import { createRng } from "@/testing/parity";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

// Imported after the mock, not statically at the top: a top-level `import` is
// hoisted above `mock.module` and would load the bundler-target package, which
// `bun test` cannot initialise.
const {
	MIN_SCALE,
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapPosition,
	snapRotation,
	snapScale,
	snapScaleAxes,
} = await import("@/wasm/preview-snap");

/**
 * Preview-canvas snapping, owned by `editor-core::preview::snap`.
 *
 * The TypeScript original in `apps/web/src/preview/preview-snap.ts` was deleted
 * at the switchover, so this is no longer a differential — these are the values
 * the two implementations were proven bit-identical on over 4,000 generated
 * gestures while both existed.
 */

const CANVAS_SIZE = { width: 1920, height: 1080 };
const SNAP_THRESHOLD = { x: 8, y: 8 };
const ELEMENT_SIZE = { width: 400, height: 300 };

test("the constants are the ones the interaction controllers read", () => {
	expect(MIN_SCALE).toBe(0.01);
	expect(SNAP_THRESHOLD_SCREEN_PIXELS).toBe(8);
});

test("a position near the centre snaps to it and reports both guides", () => {
	expect(
		snapPosition({
			proposedPosition: { x: 3, y: -2 },
			canvasSize: CANVAS_SIZE,
			elementSize: ELEMENT_SIZE,
			rotation: 0,
			snapThreshold: SNAP_THRESHOLD,
		}),
	).toEqual({
		snappedPosition: { x: 0, y: 0 },
		activeLines: [
			{ type: "vertical", position: 0 },
			{ type: "horizontal", position: 0 },
		],
	});
});

test("a position clear of every target is returned untouched, with no guides", () => {
	expect(
		snapPosition({
			proposedPosition: { x: 400, y: 333 },
			canvasSize: CANVAS_SIZE,
			elementSize: ELEMENT_SIZE,
			rotation: 0,
			snapThreshold: SNAP_THRESHOLD,
		}),
	).toEqual({
		snappedPosition: { x: 400, y: 333 },
		activeLines: [],
	});
});

test("rotation snaps to the nearest right angle inside five degrees", () => {
	expect(snapRotation({ proposedRotation: 2 })).toEqual({
		snappedRotation: 0,
		isSnapped: true,
	});
	expect(snapRotation({ proposedRotation: 88 })).toEqual({
		snappedRotation: 90,
		isSnapped: true,
	});
	// Outside the threshold the proposal is handed back unchanged.
	expect(snapRotation({ proposedRotation: 100 })).toEqual({
		snappedRotation: 100,
		isSnapped: false,
	});
	expect(snapRotation({ proposedRotation: 45 })).toEqual({
		snappedRotation: 45,
		isSnapped: false,
	});
});

test("a small negative rotation keeps JavaScript's negative zero", () => {
	// `Math.round(-2 / 90)` is `-0`, and the sign rides through the multiply into
	// the snapped angle. Rust's `f64::round` loses it — this is the case that put
	// the sign of zero into `editor-core::math::js_round`.
	const result = snapRotation({ proposedRotation: -2 });
	expect(result.isSnapped).toBe(true);
	expect(Object.is(result.snappedRotation, -0)).toBe(true);
});

test("a rotation tie rounds toward positive infinity, not away from zero", () => {
	// -45 / 90 is exactly -0.5. `Math.round` sends that to -0, so the nearest
	// step is 0 and the proposal is 45 degrees away — far too far to snap. Rust's
	// own rounding would answer -1, snapping it to -90.
	expect(snapRotation({ proposedRotation: -45 })).toEqual({
		snappedRotation: -45,
		isSnapped: false,
	});
});

test("a scale below the floor is not dragged up to it by snapping", () => {
	// `MIN_SCALE` bounds what the *gesture* may propose; snapping does not
	// re-clamp, so a proposal already under it comes back as it went in.
	expect(
		snapScale({
			proposedScale: 0.0001,
			position: { x: 0, y: 0 },
			baseWidth: ELEMENT_SIZE.width,
			baseHeight: ELEMENT_SIZE.height,
			rotation: 0,
			canvasSize: CANVAS_SIZE,
			snapThreshold: SNAP_THRESHOLD,
		}),
	).toEqual({ snappedScale: 0.0001, activeLines: [] });
});

test("each axis snaps on its own evidence", () => {
	expect(
		snapScaleAxes({
			proposedScaleX: 1.001,
			proposedScaleY: 2.5,
			position: { x: 0, y: 0 },
			baseWidth: ELEMENT_SIZE.width,
			baseHeight: ELEMENT_SIZE.height,
			rotation: 0,
			canvasSize: CANVAS_SIZE,
			snapThreshold: SNAP_THRESHOLD,
		}),
	).toEqual({
		// `snapDistance` is `Infinity`, not null, when an axis found nothing to
		// snap to — the two are indistinguishable through `JSON.stringify`, which
		// renders both as `null`.
		x: { snappedScale: 1.001, snapDistance: Infinity, activeLines: [] },
		y: { snappedScale: 2.5, snapDistance: Infinity, activeLines: [] },
	});
});

test("no generated gesture breaks the snapping invariants", () => {
	// Without a second implementation to diff against, what is left to check is
	// that the answers stay self-consistent: a gesture reported as unsnapped must
	// come back untouched, and a snapped one must name the guide it landed on.
	// The rotations are drawn from textbook angles because every half-extent goes
	// through `sin`/`cos`, and a freely generated angle would make the exact
	// comparisons below depend on the last bit of a transcendental.
	const rng = createRng({ seed: 0x5e_4a_90 });
	let positionSnaps = 0;
	let rotationSnaps = 0;

	for (let iteration = 0; iteration < 4_000; iteration += 1) {
		const rotation = rng.pick({ from: [0, 30, 45, 60, 90, 180, 270, -45, -90] });
		const spread = rng.pick({ from: [6, 40, 400] });
		const proposedPosition = {
			x: rng.range({ min: -spread, max: spread }),
			y: rng.range({ min: -spread, max: spread }),
		};

		const position = snapPosition({
			proposedPosition,
			canvasSize: CANVAS_SIZE,
			elementSize: ELEMENT_SIZE,
			rotation,
			snapThreshold: SNAP_THRESHOLD,
		});

		if (position.activeLines.length === 0) {
			expect(position.snappedPosition).toEqual(proposedPosition);
		} else {
			positionSnaps += 1;
			// A guide's `position` is the canvas-space line an element *edge* lands
			// on, not the centre, so the check is on the correction rather than on
			// the coordinate: snapping may never move a gesture further than the
			// threshold that admitted it.
			expect(
				Math.abs(position.snappedPosition.x - proposedPosition.x),
			).toBeLessThanOrEqual(SNAP_THRESHOLD.x);
			expect(
				Math.abs(position.snappedPosition.y - proposedPosition.y),
			).toBeLessThanOrEqual(SNAP_THRESHOLD.y);
		}

		const proposedRotation = rng.range({ min: -400, max: 400 });
		const rotationResult = snapRotation({ proposedRotation });
		if (rotationResult.isSnapped) {
			rotationSnaps += 1;
			// Every snap target is a right angle, so the result is a multiple of 90
			// and within the threshold of what was asked for. `Math.abs` is load
			// bearing: `(-0) % 90` is `-0`, and `toBe` compares with `Object.is`.
			expect(Math.abs(rotationResult.snappedRotation % 90)).toBe(0);
			expect(
				Math.abs(proposedRotation - rotationResult.snappedRotation),
			).toBeLessThanOrEqual(5);
		} else {
			expect(rotationResult.snappedRotation).toBe(proposedRotation);
		}
	}

	// Without these a boundary that had stopped deserialising would refuse to
	// snap anything and every branch above would pass having checked nothing.
	expect(positionSnaps).toBeGreaterThan(0);
	expect(rotationSnaps).toBeGreaterThan(0);
});
