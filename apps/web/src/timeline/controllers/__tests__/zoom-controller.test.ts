import { describe, expect, test } from "bun:test";
import {
	ZoomController,
	type ZoomConfig,
	type ZoomConfigRef,
} from "@/timeline/controllers/zoom-controller";
import { mediaTime, TICKS_PER_SECOND, type MediaTime } from "@/wasm";

interface FakeScrollElement {
	scrollLeft: number;
	scrollWidth: number;
}

const ZERO = mediaTime({ ticks: 0 });

function asDiv(el: FakeScrollElement): HTMLDivElement {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test double: we only access `scrollLeft` and `scrollWidth`
	return el as unknown as HTMLDivElement;
}

function makeConfig({
	minZoom,
	getMaxScrollLeft,
	tracksScrollEl,
	rulerScrollEl,
	getCurrentPlayheadTime = () => ZERO,
}: {
	minZoom: number;
	getMaxScrollLeft: (args: { zoomLevel: number }) => number;
	tracksScrollEl: FakeScrollElement | null;
	rulerScrollEl?: FakeScrollElement | null;
	getCurrentPlayheadTime?: () => MediaTime;
}): { configRef: ZoomConfigRef; config: ZoomConfig } {
	const config: ZoomConfig = {
		minZoom,
		getContainerEl: () => null,
		getTracksScrollEl: () => (tracksScrollEl ? asDiv(tracksScrollEl) : null),
		getRulerScrollEl: () => (rulerScrollEl ? asDiv(rulerScrollEl) : null),
		getMaxScrollLeft,
		getCurrentPlayheadTime,
		seek: () => {},
		setTimelineViewState: () => {},
	};
	const ref: ZoomConfigRef = { current: config };
	return { configRef: ref, config };
}

function disableScheduledSave(): void {
	globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- stub
}

describe("ZoomController.applyZoomLayout", () => {
	test("keeps scrollLeft constant so the zero-second mark stays anchored", () => {
		disableScheduledSave();
		const tracks = { scrollLeft: 320, scrollWidth: 5000 };
		const ruler = { scrollLeft: 320, scrollWidth: 5000 };
		const { configRef } = makeConfig({
			minZoom: 0.1,
			getMaxScrollLeft: () => 4000,
			tracksScrollEl: tracks,
			rulerScrollEl: ruler,
		});
		const controller = new ZoomController({
			configRef,
			initialZoom: 1,
		});

		controller.setZoomLevel(2);
		controller.applyZoomLayout(2);

		expect(tracks.scrollLeft).toBe(320);
		expect(ruler.scrollLeft).toBe(320);
	});

	test("still anchors on zero when the playhead sits far from zero", () => {
		disableScheduledSave();
		const tracks = { scrollLeft: 800, scrollWidth: 5000 };
		const ruler = { scrollLeft: 800, scrollWidth: 5000 };
		const playhead = mediaTime({ ticks: 12 * TICKS_PER_SECOND });
		const { configRef } = makeConfig({
			minZoom: 0.1,
			getMaxScrollLeft: () => 4000,
			tracksScrollEl: tracks,
			rulerScrollEl: ruler,
			getCurrentPlayheadTime: () => playhead,
		});
		const controller = new ZoomController({
			configRef,
			initialZoom: 1,
		});

		controller.setZoomLevel(3);
		controller.applyZoomLayout(3);

		expect(tracks.scrollLeft).toBe(800);
		expect(ruler.scrollLeft).toBe(800);
	});

	test("clamps scrollLeft when zooming in shrinks the timeline below it", () => {
		disableScheduledSave();
		const tracks = { scrollLeft: 1500, scrollWidth: 5000 };
		const ruler = { scrollLeft: 1500, scrollWidth: 5000 };
		const { configRef } = makeConfig({
			minZoom: 0.1,
			getMaxScrollLeft: ({ zoomLevel }) => 50 * zoomLevel,
			tracksScrollEl: tracks,
			rulerScrollEl: ruler,
		});
		const controller = new ZoomController({
			configRef,
			initialZoom: 1,
		});

		controller.setZoomLevel(20);
		controller.applyZoomLayout(20);

		expect(tracks.scrollLeft).toBe(50 * 20);
		expect(ruler.scrollLeft).toBe(50 * 20);
	});

	test("does not move scrollLeft when zoom does not change", () => {
		disableScheduledSave();
		const tracks = { scrollLeft: 200, scrollWidth: 5000 };
		const ruler = { scrollLeft: 200, scrollWidth: 5000 };
		const { configRef } = makeConfig({
			minZoom: 0.1,
			getMaxScrollLeft: () => 4000,
			tracksScrollEl: tracks,
			rulerScrollEl: ruler,
		});
		const controller = new ZoomController({
			configRef,
			initialZoom: 1.5,
		});

		controller.applyZoomLayout(1.5);

		expect(tracks.scrollLeft).toBe(200);
		expect(ruler.scrollLeft).toBe(200);
	});
});