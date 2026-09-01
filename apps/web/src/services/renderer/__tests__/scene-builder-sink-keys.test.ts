import { expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
// `scene-builder` reaches `@/wasm` for tick maths through `@/freeze`, and the
// bundler-target wasm cannot initialise under `bun test`. Swap the raw package
// for the nodejs-target build of the same crate, the way the animation tests do,
// so the real façade loads rather than a stub that agrees with anything.
mock.module("bluper-wasm", () => wasmNative);

const { buildScene } = await import("@/services/renderer/scene-builder");
const { VideoNode } = await import("@/services/renderer/nodes/video-node");
const { BlurBackgroundNode } = await import(
	"@/services/renderer/nodes/blur-background-node"
);
const { mediaTimeFromSeconds } = await import("@/wasm");
const { DEFAULT_FPS } = await import("@/fps/defaults");

import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement } from "@/timeline";
import type { TBackground } from "@/project/types";

const MEDIA_X = "media-x";
const MEDIA_Y = "media-y";

function asset({ id }: { id: string }): MediaAsset {
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		// A path *and* a url is what makes `createMediaSource` hand back a
		// disk-backed reference, which is the only kind the scene builder keeps.
		path: `/tmp/${id}.mp4`,
		url: `asset://${id}.mp4`,
	} as MediaAsset;
}

/** A video clip, timed in seconds so the cases read as timelines. */
function clip({
	id,
	mediaId,
	startSeconds,
	durationSeconds,
	trimStartSeconds,
}: {
	id: string;
	mediaId: string;
	startSeconds: number;
	durationSeconds: number;
	trimStartSeconds: number;
}): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId,
		startTime: mediaTimeFromSeconds({ seconds: startSeconds }),
		duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
		trimStart: mediaTimeFromSeconds({ seconds: trimStartSeconds }),
		trimEnd: mediaTimeFromSeconds({ seconds: 0 }),
		params: {},
	};
}

function sinkKeysOf({
	elements,
	background = { type: "color", color: "#000000" },
}: {
	elements: VideoElement[];
	background?: TBackground;
}): {
	video: (string | undefined)[];
	backdrop: (string | undefined)[];
} {
	const tracks: SceneTracks = {
		overlay: [],
		audio: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements,
		},
	};

	const mediaIds = [...new Set(elements.map((element) => element.mediaId))];
	const scene = buildScene({
		canvasSize: { width: 320, height: 240 },
		tracks,
		mediaAssets: mediaIds.map((id) => asset({ id })),
		duration: mediaTimeFromSeconds({ seconds: 120 }),
		background,
		fps: DEFAULT_FPS,
	});

	// A node carries no element id, so the two lists are read positionally: the
	// scene builder emits one node per clip in start-time order, and `elements`
	// is written that way in every case below.
	const video: (string | undefined)[] = [];
	const backdrop: (string | undefined)[] = [];
	for (const node of scene.children) {
		if (node instanceof VideoNode) video.push(node.params.sinkKey);
		if (node instanceof BlurBackgroundNode) backdrop.push(node.params.sinkKey);
	}

	expect(video.length).toBe(elements.length);
	return { video, backdrop };
}

test("a split clip keeps one decoder across the cut", () => {
	// B enters on the very frame A stopped before, so one iterator running
	// forwards serves both and the cut costs nothing.
	const { video } = sinkKeysOf({
		elements: [
			clip({
				id: "a",
				mediaId: MEDIA_X,
				startSeconds: 0,
				durationSeconds: 10,
				trimStartSeconds: 0,
			}),
			clip({
				id: "b",
				mediaId: MEDIA_X,
				startSeconds: 10,
				durationSeconds: 10,
				trimStartSeconds: 10,
			}),
		],
	});

	const [a, b] = video;
	expect(b).toBe(a);
});

test("two trims of one file butted together decode separately", () => {
	// The join that stuttered: B reads somewhere else in the same file, so
	// sharing A's decoder means seeking it inside the render pass at the cut —
	// and a prewarm cannot open a decoder under a key A is already using.
	const { video } = sinkKeysOf({
		elements: [
			clip({
				id: "a",
				mediaId: MEDIA_X,
				startSeconds: 0,
				durationSeconds: 5,
				trimStartSeconds: 0,
			}),
			clip({
				id: "b",
				mediaId: MEDIA_X,
				startSeconds: 5,
				durationSeconds: 5,
				trimStartSeconds: 20,
			}),
		],
	});

	const [a, b] = video;
	expect(a).toBeDefined();
	expect(b).toBeDefined();
	expect(b).not.toBe(a);
});

test("a shot used twice gets a decoder per use", () => {
	// A/B/A: the second use of media X is continuous with the first in the file
	// but not on the timeline, and the first use's decoder is still open.
	const { video } = sinkKeysOf({
		elements: [
			clip({
				id: "x1",
				mediaId: MEDIA_X,
				startSeconds: 0,
				durationSeconds: 5,
				trimStartSeconds: 0,
			}),
			clip({
				id: "y1",
				mediaId: MEDIA_Y,
				startSeconds: 5,
				durationSeconds: 5,
				trimStartSeconds: 0,
			}),
			clip({
				id: "x2",
				mediaId: MEDIA_X,
				startSeconds: 10,
				durationSeconds: 5,
				trimStartSeconds: 5,
			}),
		],
	});

	const [x1, y1, x2] = video;
	expect(x2).not.toBe(x1);
	expect(y1).not.toBe(x1);
});

test("a blur backdrop reads the same decoder as the clip in front of it", () => {
	// Given a key of its own the backdrop would open a second decoder per clip
	// and miss the prewarm the foreground clip gets.
	const elements = [
		clip({
			id: "a",
			mediaId: MEDIA_X,
			startSeconds: 0,
			durationSeconds: 5,
			trimStartSeconds: 0,
		}),
		clip({
			id: "b",
			mediaId: MEDIA_X,
			startSeconds: 5,
			durationSeconds: 5,
			trimStartSeconds: 20,
		}),
	];
	const { video, backdrop } = sinkKeysOf({
		elements,
		background: { type: "blur", blurIntensity: 50 },
	});

	expect(backdrop).toEqual(video);
});
