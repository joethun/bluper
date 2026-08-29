import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { sceneHasMedia } = await import(
	"@/timeline/hooks/use-timeline-has-media"
);
import type { ImageElement, SceneTracks, VideoElement } from "@/timeline/types";

function videoElement(): VideoElement {
	return {
		id: "el-1",
		type: "video",
		startTime: 0 as never,
		duration: 1000 as never,
		trimStart: 0 as never,
		trimEnd: 0 as never,
		params: {},
		mediaId: "media-1",
	} as unknown as VideoElement;
}

function imageElement(): ImageElement {
	return {
		id: "el-1",
		type: "image",
		startTime: 0 as never,
		duration: 1000 as never,
		trimStart: 0 as never,
		trimEnd: 0 as never,
		params: {},
		mediaId: "media-1",
	} as unknown as ImageElement;
}

function emptyScene(): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		overlay: [],
		audio: [],
	};
}

function mainWithVideo(): SceneTracks {
	return {
		...emptyScene(),
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [videoElement()],
		},
	};
}

describe("sceneHasMedia", () => {
	it("returns false for a scene with no video or image tracks", () => {
		expect(sceneHasMedia({ tracks: emptyScene() })).toBe(false);
	});

	it("returns true when the main video track has elements", () => {
		expect(sceneHasMedia({ tracks: mainWithVideo() })).toBe(true);
	});

	it("returns true when an overlay video track has elements", () => {
		const tracks: SceneTracks = {
			...emptyScene(),
			overlay: [
				{
					id: "overlay-1",
					name: "Overlay",
					type: "video",
					muted: false,
					hidden: false,
					elements: [imageElement()],
				},
			],
		};
		expect(sceneHasMedia({ tracks })).toBe(true);
	});

	it("returns false when an overlay track has only text or graphic elements", () => {
		const tracks: SceneTracks = {
			...emptyScene(),
			overlay: [
				{
					id: "text-1",
					name: "Text",
					type: "text",
					hidden: false,
					elements: [],
				},
				{
					id: "graphic-1",
					name: "Graphic",
					type: "graphic",
					hidden: false,
					elements: [],
				},
			],
		};
		expect(sceneHasMedia({ tracks })).toBe(false);
	});
});