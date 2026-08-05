import { describe, expect, test } from "bun:test";
import {
	buildTransitionInstance,
	drawTransitionShape,
	getTransitionDefinition,
	isShapeFullyOpaque,
	isShapeFullyTransparent,
	registerDefaultTransitions,
	transitionsRegistry,
} from "@/transitions";
import type { TransitionShape } from "@/transitions/types";

if (!transitionsRegistry.has("tiles")) {
	registerDefaultTransitions();
}

interface DrawnRect {
	x: number;
	y: number;
	width: number;
	height: number;
	alpha: number;
}

/**
 * Stands in for a 2D context, recording the tiles that were painted. Only the
 * calls `drawTiles` makes are implemented — enough to check the grid's geometry
 * without a real canvas, which bun has no DOM for.
 */
function recordingContext() {
	const rects: DrawnRect[] = [];
	const state = { globalAlpha: 1, fillStyle: "" };
	return {
		rects,
		ctx: {
			get globalAlpha() {
				return state.globalAlpha;
			},
			set globalAlpha(value: number) {
				state.globalAlpha = value;
			},
			get fillStyle() {
				return state.fillStyle;
			},
			set fillStyle(value: string) {
				state.fillStyle = value;
			},
			// Positional, because that is the canvas signature being stood in for.
			// eslint-disable-next-line bluper/prefer-object-params
			fillRect(x: number, y: number, width: number, height: number) {
				rects.push({ x, y, width, height, alpha: state.globalAlpha });
			},
		},
	};
}

function drawTiles({
	shape,
	width = 1920,
	height = 1080,
}: {
	shape: Partial<Extract<TransitionShape, { kind: "tiles" }>>;
	width?: number;
	height?: number;
}) {
	const { ctx, rects } = recordingContext();
	drawTransitionShape({
		// The recording context implements exactly the surface `drawTiles` touches.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		ctx: ctx as unknown as CanvasRenderingContext2D,
		shape: {
			kind: "tiles",
			progress: 0.5,
			count: 6,
			stagger: 0.6,
			...shape,
		},
		width,
		height,
	});
	return rects;
}

function coveredArea({ rects }: { rects: DrawnRect[] }): number {
	return rects.reduce((total, rect) => total + rect.width * rect.height, 0);
}

describe("tiles transition", () => {
	test("is registered and reveals only the incoming clip", () => {
		const definition = getTransitionDefinition({ transitionType: "tiles" });
		const frame = definition.resolve({
			progress: 0.5,
			params: { tiles: 6, stagger: 60 },
			width: 1920,
			height: 1080,
		});

		expect(definition.name).toBe("Tiles");
		// Masking the outgoing clip would reveal the background rather than the
		// other clip, the same reason the other wipes only touch the incoming side.
		expect(frame.outgoing.shape).toBeNull();
		expect(frame.incoming.shape).toMatchObject({
			kind: "tiles",
			progress: 0.5,
		});
	});

	test("builds with a usable grid and stagger out of the box", () => {
		const instance = buildTransitionInstance({ transitionType: "tiles" });

		expect(instance.params.tiles).toBe(6);
		expect(instance.params.stagger).toBe(60);
	});

	test("falls back to the defaults for junk params", () => {
		const definition = getTransitionDefinition({ transitionType: "tiles" });
		const frame = definition.resolve({
			progress: 0.5,
			params: {},
			width: 1920,
			height: 1080,
		});

		expect(frame.incoming.shape).toMatchObject({ count: 6, stagger: 0.6 });
	});

	test("clamps the grid to something drawable", () => {
		const definition = getTransitionDefinition({ transitionType: "tiles" });
		const tooFew = definition.resolve({
			progress: 0.5,
			params: { tiles: 0 },
			width: 1920,
			height: 1080,
		});
		const tooMany = definition.resolve({
			progress: 0.5,
			params: { tiles: 500 },
			width: 1920,
			height: 1080,
		});

		expect(tooFew.incoming.shape).toMatchObject({ count: 2 });
		expect(tooMany.incoming.shape).toMatchObject({ count: 24 });
	});
});

describe("tiles mask", () => {
	test("paints nothing at the start of the window", () => {
		expect(drawTiles({ shape: { progress: 0 } })).toHaveLength(0);
	});

	/**
	 * The reveal has to finish. A tile still short of its cell at the end would leave
	 * a permanent grid of the outgoing clip showing through.
	 */
	test("covers the box exactly once every tile has landed", () => {
		const rects = drawTiles({ shape: { progress: 1 } });

		expect(coveredArea({ rects })).toBe(1920 * 1080);
		expect(rects.every((rect) => rect.alpha === 1)).toBe(true);
	});

	/**
	 * Tiles are grown towards integer cell edges so neighbours meet exactly. Landing
	 * on fractional edges would leave an antialiased seam across the whole blend.
	 */
	test("lands tiles on whole pixels so no seam is left between them", () => {
		const rects = drawTiles({
			shape: { progress: 1 },
			width: 1000,
			height: 700,
		});

		for (const rect of rects) {
			expect(Number.isInteger(rect.x)).toBe(true);
			expect(Number.isInteger(rect.y)).toBe(true);
			expect(Number.isInteger(rect.width)).toBe(true);
			expect(Number.isInteger(rect.height)).toBe(true);
		}
	});

	/**
	 * A whole grid rarely divides a frame evenly, so cells come out near-square
	 * rather than square — but the grid has to transpose with the clip so a portrait
	 * video does not get six wide letterbox strips.
	 */
	test("transposes the grid with the clip and keeps cells near-square", () => {
		const landscape = drawTiles({
			shape: { progress: 1 },
			width: 1920,
			height: 1080,
		});
		const portrait = drawTiles({
			shape: { progress: 1 },
			width: 1080,
			height: 1920,
		});

		const gridOf = (rects: DrawnRect[]) => ({
			columns: new Set(rects.map((rect) => rect.x)).size,
			rows: new Set(rects.map((rect) => rect.y)).size,
		});

		expect(landscape).toHaveLength(portrait.length);
		for (const cell of [landscape[0], portrait[0]]) {
			const aspect =
				Math.max(cell.width, cell.height) / Math.min(cell.width, cell.height);
			expect(aspect).toBeLessThan(1.3);
		}
		// The count sits on the long axis, so the grid turns with the clip.
		expect(gridOf(landscape).columns).toBeGreaterThan(gridOf(landscape).rows);
		expect(gridOf(portrait).rows).toBeGreaterThan(gridOf(portrait).columns);
	});

	test("grows tiles from their cell centre rather than a corner", () => {
		const partial = drawTiles({ shape: { progress: 0.2, stagger: 0 } });
		const full = drawTiles({ shape: { progress: 1, stagger: 0 } });
		const centreOf = (rect: DrawnRect) => ({
			x: rect.x + rect.width / 2,
			y: rect.y + rect.height / 2,
		});

		expect(partial).toHaveLength(full.length);
		expect(partial[0].width).toBeLessThan(full[0].width);
		expect(centreOf(partial[0]).x).toBeCloseTo(centreOf(full[0]).x, 5);
		expect(centreOf(partial[0]).y).toBeCloseTo(centreOf(full[0]).y, 5);
	});

	test("covers more of the frame as the window runs on", () => {
		const areas = [0.25, 0.5, 0.75, 1].map((progress) =>
			coveredArea({ rects: drawTiles({ shape: { progress } }) }),
		);

		for (let index = 1; index < areas.length; index++) {
			expect(areas[index]).toBeGreaterThan(areas[index - 1]);
		}
	});

	/** Staggering is what makes it a wave rather than a grid-shaped dissolve. */
	test("brings tiles in one after another when staggered", () => {
		const staggered = drawTiles({ shape: { progress: 0.5, stagger: 1 } });
		const together = drawTiles({ shape: { progress: 0.5, stagger: 0 } });

		// Half way through, only some of the grid has arrived.
		expect(staggered.length).toBeGreaterThan(0);
		expect(staggered.length).toBeLessThan(together.length);
	});

	/** The wave runs along the diagonal, so the near corner lands first. */
	test("arrives from the top-left corner", () => {
		const rects = drawTiles({ shape: { progress: 0.3, stagger: 1 } });
		const first = rects[0];
		const furthest = rects[rects.length - 1];

		expect(first.x + first.y).toBeLessThan(furthest.x + furthest.y);
	});

	test("brings every tile in together when not staggered", () => {
		const rects = drawTiles({ shape: { progress: 0.5, stagger: 0 } });
		const alphas = new Set(rects.map((rect) => rect.alpha));

		expect(alphas.size).toBe(1);
		// Nothing is held back, so the whole grid is on screen from the first frame.
		expect(rects).toHaveLength(
			drawTiles({ shape: { progress: 1, stagger: 0 } }).length,
		);
	});

	/**
	 * The renderer skips the mask entirely at the ends of the window, so these have
	 * to agree with what the raster would draw or a frame gets lost.
	 */
	test("reports its own ends the way the renderer expects", () => {
		const shape = (progress: number): TransitionShape => ({
			kind: "tiles",
			progress,
			count: 6,
			stagger: 0.6,
		});

		expect(isShapeFullyTransparent({ shape: shape(0) })).toBe(true);
		expect(isShapeFullyOpaque({ shape: shape(1) })).toBe(true);
		expect(isShapeFullyTransparent({ shape: shape(0.5) })).toBe(false);
		expect(isShapeFullyOpaque({ shape: shape(0.5) })).toBe(false);
	});
});
