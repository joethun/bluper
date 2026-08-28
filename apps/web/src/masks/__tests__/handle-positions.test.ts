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
	getBoxMaskHandlePositions,
	getBoxMaskRectOverlay,
	getLineMaskHandlePositions,
	getLineMaskOverlay,
} = await import("@/wasm/mask-handles");

/**
 * Mask overlay and handle geometry, owned by
 * `editor-core::masks::handle_positions`.
 *
 * The TypeScript original in `apps/web/src/masks/handle-positions.ts` was
 * deleted at the switchover. While both existed the two were proven identical —
 * bit-exact on the overlay rectangles, and to within an ulp of the trigonometry
 * on the handle coordinates. These pin what that agreement produced.
 */

const BOUNDS = { cx: 960, cy: 540, width: 640, height: 360, rotation: 0 };

test("a box mask's rectangle is the element's bounds scaled by the mask", () => {
	// Mask params are fractions of the element, so a 0.4 x 0.5 mask on a
	// 640 x 360 element is 256 x 180, centred on the element's centre.
	expect(
		getBoxMaskRectOverlay({
			centerX: 0.5,
			centerY: 0.5,
			width: 0.4,
			height: 0.5,
			rotation: 0,
			bounds: BOUNDS,
		}),
	).toEqual({
		type: "rect",
		id: "bounding-box",
		center: { x: 1280, y: 720 },
		width: 256,
		height: 180,
		rotation: 0,
		dashed: false,
		cursor: "move",
		handleId: { kind: "position" },
	});
});

test("a line mask is drawn far past the element on both sides", () => {
	// The cut has to reach the edge of the viewport at any zoom, so the line is
	// extended to 50x the element's largest dimension rather than clipped to it:
	// 640 x 50 = 32000 either side of the centre.
	expect(
		getLineMaskOverlay({
			centerX: 0.5,
			centerY: 0.5,
			rotation: 0,
			bounds: BOUNDS,
		}),
	).toEqual({
		type: "line",
		id: "line",
		start: { x: 1280, y: -31280 },
		end: { x: 1280, y: 32720 },
		cursor: "move",
		handleId: { kind: "position" },
	});
});

test("a line mask carries only a rotation and a feather handle", () => {
	expect(
		getLineMaskHandlePositions({
			centerX: 0.5,
			centerY: 0.5,
			rotation: 0,
			feather: 0,
			bounds: BOUNDS,
			displayScale: 1,
		}),
	).toEqual([
		{
			id: { kind: "rotation" },
			x: 1300,
			y: 720,
			cursor: "crosshair",
			kind: "icon",
			icon: "rotate",
		},
		{
			id: { kind: "feather" },
			x: 1260,
			y: 720,
			cursor: "ew-resize",
			kind: "icon",
			icon: "feather",
		},
	]);
});

test("a box mask's handles are the four corners, three edges and two icons", () => {
	const handles = getBoxMaskHandlePositions({
		centerX: 0.5,
		centerY: 0.5,
		width: 0.4,
		height: 0.5,
		rotation: 0,
		feather: 0,
		sizeMode: "width-height",
		showScaleHandle: false,
		bounds: BOUNDS,
		displayScale: 1,
	});

	// There is no top edge handle: the rotation icon sits above the box and the
	// two would land on each other.
	expect(
		handles.map((handle) =>
			handle.id.kind === "corner"
				? `corner:${handle.id.corner.y}-${handle.id.corner.x}`
				: handle.id.kind === "edge"
					? `edge:${handle.id.side}`
					: handle.id.kind,
		),
	).toEqual([
		"rotation",
		"feather",
		"corner:top-left",
		"corner:top-right",
		"corner:bottom-right",
		"corner:bottom-left",
		"edge:left",
		"edge:right",
		"edge:bottom",
	]);

	// The corners are the rect's own corners: 1280 +/- 128, 720 +/- 90.
	expect(
		handles
			.filter((handle) => handle.id.kind === "corner")
			.map((handle) => [handle.x, handle.y]),
	).toEqual([
		[1152, 630],
		[1408, 630],
		[1408, 810],
		[1152, 810],
	]);

	// The icons sit outside the box, 20 screen pixels clear of its edge.
	expect(handles[0]).toEqual({
		id: { kind: "rotation" },
		x: 1280,
		y: 610,
		cursor: "crosshair",
		kind: "icon",
		icon: "rotate",
	});
	expect(handles[1]?.y).toBe(830);
});

test("no generated mask produces a handle off the number line", () => {
	// Without a second implementation to diff against, what is left to check is
	// that the geometry stays well-formed under rotation — a NaN reaching the
	// overlay renderer draws nothing and reports nothing.
	const rng = createRng({ seed: 0x1a5ec0de });
	let rotatedCount = 0;

	for (let iteration = 0; iteration < 2_000; iteration += 1) {
		const rotation = rng.range({ min: -360, max: 360 });
		const bounds = {
			cx: rng.range({ min: -500, max: 2000 }),
			cy: rng.range({ min: -500, max: 2000 }),
			width: rng.range({ min: 1, max: 1920 }),
			height: rng.range({ min: 1, max: 1080 }),
			rotation: 0,
		};
		if (rotation !== 0) {
			rotatedCount += 1;
		}

		const handles = getBoxMaskHandlePositions({
			centerX: rng.range({ min: 0, max: 1 }),
			centerY: rng.range({ min: 0, max: 1 }),
			width: rng.range({ min: 0.01, max: 1 }),
			height: rng.range({ min: 0.01, max: 1 }),
			rotation,
			feather: rng.range({ min: 0, max: 50 }),
			sizeMode: rng.pick({
				from: ["uniform", "width-height", "height-only", "width-only"],
			}),
			showScaleHandle: rng.bool(),
			bounds,
			displayScale: rng.pick({ from: [0.25, 1, 2] }),
		});

		expect(handles.length).toBeGreaterThan(0);
		for (const handle of handles) {
			expect(Number.isFinite(handle.x)).toBe(true);
			expect(Number.isFinite(handle.y)).toBe(true);
		}
	}

	expect(rotatedCount).toBeGreaterThan(0);
});
