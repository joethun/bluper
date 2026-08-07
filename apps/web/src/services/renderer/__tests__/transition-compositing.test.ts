import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { FrameItemDescriptor } from "@/services/renderer/compositor/types";
import type { SceneTracks, VideoElement } from "@/timeline";
import {
	buildTransitionInstance,
	registerDefaultTransitions,
	transitionsRegistry,
} from "@/transitions";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * A frame of pixels standing in for a decoded video frame. The compositor only
 * needs something it can measure and upload. The WebCodecs global isn't
 * available in this runtime, so we hand the mock an object and let the test
 * happily treat it as a VideoFrame — the production path never touches this
 * file.
 */
/* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
   WebCodecs `VideoFrame` is a browser global; this test runtime has no such
   global so we work around it with an `unknown` shim. */
const frameVideoFrame = { ts: 0 } as unknown as VideoFrame;

await mock.module("@/services/video-cache/service", () => ({
	videoCache: {
		getSampleAt: async ({ time }: { time: number }) => {
			await Promise.resolve();
			return {
				toVideoFrame: () => frameVideoFrame,
				displayWidth: 1920,
				displayHeight: 1080,
				timestamp: time,
				duration: 1 / 30,
			};
		},
	},
}));

const { buildScene } = await import("@/services/renderer/scene-builder");
const { resolveRenderTree } = await import("@/services/renderer/resolve");
const { buildFrameDescriptor } = await import(
	"@/services/renderer/compositor/frame-descriptor"
);

if (!transitionsRegistry.has("dissolve")) {
	registerDefaultTransitions();
}

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function buildAsset(): MediaAsset {
	return {
		id: "media-1",
		name: "media-1",
		type: "video",
		file: new File([new Uint8Array([0])], "media-1.mp4", { type: "video/mp4" }),
		url: "blob:media-1",
		width: 1920,
		height: 1080,
	};
}

function buildVideoElement(
	overrides: Partial<VideoElement> & { id: string },
): VideoElement {
	return {
		type: "video",
		name: overrides.id,
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { opacity: 1, volume: 1 },
		...overrides,
	};
}

/** A 10s clip split at 5s with a half-second cross-fade on the join. */
function buildSplitScene({ transitionType }: { transitionType: string }) {
	const tracks: SceneTracks = {
		overlay: [],
		main: {
			id: "main",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [
				buildVideoElement({ id: "left", trimEnd: seconds({ value: 5 }) }),
				buildVideoElement({
					id: "right",
					startTime: seconds({ value: 5 }),
					trimStart: seconds({ value: 5 }),
					transitionIn: {
						...buildTransitionInstance({ transitionType }),
						duration: seconds({ value: 0.5 }),
					},
				}),
			],
		},
		audio: [],
	};
	return { mediaAssets: [buildAsset()], tracks };
}

const canvasSize = { width: 1920, height: 1080 };

/**
 * Resolving and descriptor building read only the canvas dimensions off the
 * renderer, so a pair of numbers stands in for the real WebGPU-backed one.
 */
function rendererStub() {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return canvasSize as never;
}

type LayerItem = Extract<FrameItemDescriptor, { type: "layer" }>;

async function layersAt({
	time,
	transitionType = "dissolve",
}: {
	time: number;
	transitionType?: string;
}) {
	const { mediaAssets, tracks } = buildSplitScene({ transitionType });
	const root = buildScene({
		tracks,
		mediaAssets,
		duration: seconds({ value: 10 }),
		canvasSize,
		background: { type: "color", color: "#000000" },
	});
	await resolveRenderTree({
		node: root,
		renderer: rendererStub(),
		time: seconds({ value: time }),
	});
	const { frame } = await buildFrameDescriptor({
		node: root,
		renderer: rendererStub(),
	});
	// The scene background is a layer too; only the clips are of interest here.
	return frame.items.filter(
		(item): item is LayerItem =>
			item.type === "layer" && item.textureId.endsWith(":source"),
	);
}

describe("transition compositing", () => {
	test("mid-dissolve both clips are on the frame at once", async () => {
		const layers = await layersAt({ time: 5 });
		expect(
			layers.length,
			"a cross-fade needs both clips composited together",
		).toBe(2);
	});

	/**
	 * The clips composite in timeline order, so the incoming one lands on top and
	 * fades up over an outgoing side that stays opaque underneath. Cross-fading
	 * both towards 50% instead would let the black background show through the
	 * middle of every cut.
	 */
	test("the outgoing side holds while the incoming side fades up over it", async () => {
		const [outgoing, incoming] = await layersAt({ time: 5 });
		expect(outgoing.opacity).toBe(1);
		expect(incoming.opacity).toBeGreaterThan(0);
		expect(incoming.opacity).toBeLessThan(1);
	});

	test("the blend progresses steadily across the window", async () => {
		// The window is half a second wide, centred on the 5s cut.
		const progression: number[] = [];
		for (const time of [4.8, 4.9, 5, 5.1, 5.2]) {
			const layers = await layersAt({ time });
			progression.push(layers[layers.length - 1].opacity);
		}

		for (let index = 1; index < progression.length; index++) {
			expect(
				progression[index],
				`opacity should climb at step ${index}`,
			).toBeGreaterThan(progression[index - 1]);
		}
	});

	test("outside the window only one clip is composited, fully opaque", async () => {
		for (const time of [2, 8]) {
			const layers = await layersAt({ time });
			expect(layers.length, `t=${time}`).toBe(1);
			expect(layers[0].opacity, `t=${time}`).toBe(1);
		}
	});

	test("a wipe reveals by geometry, so the incoming side carries a mask", async () => {
		const layers = await layersAt({ time: 5, transitionType: "wipe-left" });
		expect(layers.length).toBe(2);
		expect(layers.some((layer) => layer.mask !== null)).toBe(true);
	});
});
