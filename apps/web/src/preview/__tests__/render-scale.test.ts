import { expect, test } from "bun:test";
import {
	fitScaleToDisplay,
	RenderScaleController,
} from "@/preview/render-scale";

const CANVAS = { canvasWidth: 1920, canvasHeight: 1080 };

test("a canvas shown at its own size renders every pixel", () => {
	expect(
		fitScaleToDisplay({
			...CANVAS,
			displayWidth: 1920,
			displayHeight: 1080,
		}),
	).toBe(1);
});

test("a canvas shown smaller than it is drops to the smallest scale that still covers the display", () => {
	// 700 / 1920 is under a half and over a quarter, so a half is the smallest
	// step that still has a rendered pixel for every pixel on screen.
	expect(
		fitScaleToDisplay({
			...CANVAS,
			displayWidth: 700,
			displayHeight: 394,
		}),
	).toBe(1 / 2);
	expect(
		fitScaleToDisplay({
			...CANVAS,
			displayWidth: 300,
			displayHeight: 169,
		}),
	).toBe(1 / 4);
});

test("a retina display needs the pixels its ratio asks for", () => {
	// The same 700pt panel covers 1400 device pixels at 2x, which is past half of
	// 1920 and so needs the full raster.
	expect(
		fitScaleToDisplay({
			...CANVAS,
			displayWidth: 700,
			displayHeight: 394,
			devicePixelRatio: 2,
		}),
	).toBe(1);
});

test("zooming past 100% never asks for more than the canvas has", () => {
	expect(
		fitScaleToDisplay({
			...CANVAS,
			displayWidth: 8000,
			displayHeight: 4500,
		}),
	).toBe(1);
});

test("an unmeasured viewport renders at full resolution rather than guessing", () => {
	expect(
		fitScaleToDisplay({ ...CANVAS, displayWidth: 0, displayHeight: 0 }),
	).toBe(1);
});

test("standing still renders at the display fit whatever playback learned", () => {
	const controller = new RenderScaleController();
	overrunFor({ controller, frames: 40 });

	expect(controller.scaleFor({ ceilingScale: 1, isMoving: false })).toBe(1);
	// Pausing forgets the overruns, so resuming starts from the top again.
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1);
});

test("a moving playhead that keeps missing its slot steps down, and stops at the floor", () => {
	const controller = new RenderScaleController();

	overrunFor({ controller, frames: 4 });
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1 / 2);

	overrunFor({ controller, frames: 4 });
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1 / 4);

	// Two steps is as far as it goes on its own: past that the preview stops
	// being worth looking at.
	overrunFor({ controller, frames: 100 });
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1 / 4);
});

test("one slow frame does not drop the resolution", () => {
	const controller = new RenderScaleController();

	overrunFor({ controller, frames: 3 });
	controller.recordFrame({ durationMs: 1, budgetMs: 16 });
	overrunFor({ controller, frames: 3 });

	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1);
});

test("comfortable frames win the resolution back", () => {
	const controller = new RenderScaleController();
	overrunFor({ controller, frames: 4 });
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1 / 2);

	underrunFor({ controller, frames: 24 });
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1);
});

test("a frame that fits without headroom leaves the scale where it is", () => {
	const controller = new RenderScaleController();
	// 90% of the budget: keeping up, but not by enough to justify asking for
	// four times the pixels.
	for (let index = 0; index < 200; index++) {
		controller.recordFrame({ durationMs: 14.4, budgetMs: 16 });
	}
	expect(controller.scaleFor({ ceilingScale: 1, isMoving: true })).toBe(1);
});

test("stepping down starts from the display fit, not from full resolution", () => {
	const controller = new RenderScaleController();
	overrunFor({ controller, frames: 4 });

	expect(controller.scaleFor({ ceilingScale: 1 / 2, isMoving: true })).toBe(
		1 / 4,
	);
});

function overrunFor({
	controller,
	frames,
}: {
	controller: RenderScaleController;
	frames: number;
}): void {
	for (let index = 0; index < frames; index++) {
		controller.recordFrame({ durationMs: 40, budgetMs: 16 });
	}
}

function underrunFor({
	controller,
	frames,
}: {
	controller: RenderScaleController;
	frames: number;
}): void {
	for (let index = 0; index < frames; index++) {
		controller.recordFrame({ durationMs: 2, budgetMs: 16 });
	}
}
