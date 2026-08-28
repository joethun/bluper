import {
	fitScaleToDisplayValue as _fitScaleToDisplayValue,
	getInitialRenderScaleState as _getInitialRenderScaleState,
	recordRenderFrame as _recordRenderFrame,
	renderScaleFor as _renderScaleFor,
	type RenderScaleState,
} from "bluper-wasm";

/**
 * How many of the project's pixels the preview actually draws. Owned by
 * `editor-core::preview::render_scale`, which holds both the display fit and
 * the adaptive ladder — see that module for why the lever exists at all.
 *
 * The Rust half is a pure step over an explicit state; the controller below is
 * the object the callers keep, and all it holds is that state.
 */

export function fitScaleToDisplay({
	canvasWidth,
	canvasHeight,
	displayWidth,
	displayHeight,
	devicePixelRatio = 1,
}: {
	canvasWidth: number;
	canvasHeight: number;
	displayWidth: number;
	displayHeight: number;
	devicePixelRatio?: number;
}): number {
	return _fitScaleToDisplayValue({
		canvasWidth,
		canvasHeight,
		displayWidth,
		displayHeight,
		devicePixelRatio,
	});
}

export class RenderScaleController {
	private state: RenderScaleState = _getInitialRenderScaleState();

	/**
	 * The scale to render the next frame at.
	 *
	 * `ceilingScale` is the display fit; `isMoving` is whether the playhead is
	 * running or being dragged. Standing still returns the ceiling and forgets
	 * what playback learned, so pausing always lands on the best picture the
	 * panel can show.
	 */
	scaleFor({
		ceilingScale,
		isMoving,
	}: {
		ceilingScale: number;
		isMoving: boolean;
	}): number {
		const decision = _renderScaleFor({
			state: this.state,
			ceilingScale,
			isMoving,
		});
		this.state = decision.state;
		return decision.scale;
	}

	/**
	 * Records how long a frame took against the time it had. Only called for
	 * frames rendered while moving: a paused render is off the hot path and how
	 * long it took says nothing about whether playback can keep up.
	 */
	recordFrame({
		durationMs,
		budgetMs,
	}: {
		durationMs: number;
		budgetMs: number;
	}): void {
		this.state = _recordRenderFrame({
			state: this.state,
			durationMs,
			budgetMs,
		});
	}

	reset(): void {
		this.state = _getInitialRenderScaleState();
	}
}
