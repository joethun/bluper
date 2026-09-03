import type { FrameRate } from "bluper-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
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
	/**
	 * What fraction of `width` x `height` to actually draw, in (0, 1]. Defaults
	 * to 1 — only the preview lowers it, and only while it is moving.
	 */
	scale?: number;
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

/**
 * Queues `fn` behind whatever renders are in flight.
 *
 * For teardown that frees something a render might be holding. A render is
 * asynchronous between resolving its frames and drawing them, so anything that
 * closes a `VideoFrame` from outside — the render tree being swapped out from
 * under the preview, say — has to wait its turn or it frees the frame the pass
 * in flight is about to draw, which on WebKitGTK is a use-after-free that takes
 * the web process down rather than throwing.
 */
export function runAfterRenders(fn: () => void): void {
	void runExclusively(async () => {
		fn();
	});
}

let nextRendererId = 0;

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;
	/**
	 * How much of the canvas resolution this renderer draws. Every coordinate it
	 * produces stays in canvas units; the scale only decides how many pixels
	 * those units land on — see `FrameDescriptor.renderScale`.
	 */
	scale: number;
	/**
	 * Namespaces this renderer's textures in the shared compositor cache.
	 *
	 * Texture ids are the node's position in the tree, so without this every
	 * renderer names its textures identically — and because a sync retires every
	 * id the incoming frame does not mention, a project thumbnail or a freeze
	 * bake would retire the preview's textures and close the `VideoFrame`s the
	 * preview's nodes are still holding. Prefixing keeps each renderer's
	 * textures to itself.
	 */
	readonly id: string;

	constructor({ width, height, fps, scale = 1 }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.scale = scale;
		this.id = `r${nextRendererId++}`;
	}

	/** The pixel size the frames this renderer draws come out at. */
	get deviceWidth(): number {
		return Math.max(1, Math.round(this.width * this.scale));
	}

	get deviceHeight(): number {
		return Math.max(1, Math.round(this.height * this.scale));
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.deviceWidth,
			height: this.deviceHeight,
		});
		return wasmCompositor.getCanvas();
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		await runExclusively(() => this.renderLocked({ node, time }));
		// Counted here rather than inside the lock so both entry points report a
		// frame. This one used not to, which meant `window.__renderPerf` produced
		// nothing at all while the preview was running — the loop it exists to
		// measure — and only flushed during an export or a thumbnail.
		onRenderPerfFrameComplete();
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
		const { frame, textures } = measureSpanSync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.deviceWidth,
			height: this.deviceHeight,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures({ textures, owner: this.id }),
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
		onRenderPerfFrameComplete();
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

		const source = wasmCompositor.getCanvas();
		measureSpanSync({
			name: "drawImage",
			fn: () => {
				// Cleared first because callers reuse their canvas across frames —
				// the exporter draws every frame into the same one — and a frame
				// with transparency would otherwise composite over its predecessor.
				// Measured at 0.66ms of the pair's 9.5ms at 1080p, so it is not
				// worth trading for a `copy` composite op and the alpha questions
				// that brings.
				ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
				// The scaling form of `drawImage` costs about 10% more than the
				// plain one even when the sizes already match, which for the
				// exporter — where source and target are both the project's
				// resolution — is every frame. Thumbnails and previews still need
				// the scale, so the size test picks the path rather than the
				// caller.
				if (
					source.width === targetCanvas.width &&
					source.height === targetCanvas.height
				) {
					ctx.drawImage(source, 0, 0);
				} else {
					ctx.drawImage(source, 0, 0, targetCanvas.width, targetCanvas.height);
				}
			},
		});
	}
}
