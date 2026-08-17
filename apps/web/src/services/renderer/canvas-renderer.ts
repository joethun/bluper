import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

/**
 * Renders run one at a time, process-wide.
 *
 * Everything a render touches outside its own instance is shared: one
 * `wasmCompositor` with one GL context, one texture cache and one output
 * canvas; one pool of scratch surfaces; and the scene nodes themselves, which
 * the resolver writes its per-frame state onto. The preview loop guards its own
 * re-entry, but a snapshot, an eyedropper sample, a project thumbnail and a
 * freeze bake each build a renderer of their own and can start in the middle of
 * a preview frame — several of them against the *same* render tree. Two passes
 * then interleave their texture uploads and close each other's decoded frames,
 * and the picture tears or goes to garbage.
 *
 * Serialising here rather than at each call site means a new entry point cannot
 * forget: the cost is that an off-screen render waits for the frame in flight,
 * which is a millisecond or two on work that is already off the hot path.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function runExclusively<T>(fn: () => Promise<T>): Promise<T> {
	// Chained off a settled tail rather than the previous result, so one render
	// throwing does not reject every render queued behind it.
	const result = renderQueue.then(fn, fn);
	renderQueue = result.catch(() => undefined);
	return result;
}

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		return wasmCompositor.getCanvas();
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		await runExclusively(() => this.renderLocked({ node, time }));
	}

	private async renderLocked({
		node,
		time,
	}: {
		node: AnyBaseNode;
		time: number;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		// The copy is inside the same critical section as the render: the
		// compositor draws into one canvas that it reuses, so a render starting
		// between the two would be the frame this one reads back.
		await runExclusively(() =>
			this.renderToCanvasLocked({ node, time, targetCanvas }),
		);
	}

	private async renderToCanvasLocked({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.renderLocked({ node, time });

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		measureSpanSync({
			name: "drawImage",
			fn: () => {
				// Cleared first because callers reuse their canvas across frames —
				// the exporter draws every frame into the same one — and a frame
				// with transparency would otherwise composite over its predecessor.
				ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
				ctx.drawImage(
					wasmCompositor.getCanvas(),
					0,
					0,
					targetCanvas.width,
					targetCanvas.height,
				);
			},
		});
		onRenderPerfFrameComplete();
	}
}
