import { describe, expect, test } from "bun:test";
import type {
	AudioElement,
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { autoDeleteEmptyTracks } from "@/timeline/track-cleanup";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: `media-${id}`,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function buildOverlayTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: "video";
	elements?: VideoTrack["elements"];
}): VideoTrack;
function buildOverlayTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: "text";
	elements?: TextTrack["elements"];
}): TextTrack;
function buildOverlayTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: "video" | "text";
	elements?: VideoTrack["elements"] | TextTrack["elements"];
}): VideoTrack | TextTrack {
	const list = elements ?? [];
	if (type === "video") {
		return {
			id,
			type: "video",
			name: id,
			elements: list as VideoTrack["elements"], // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by type
			muted: false,
			hidden: false,
		};
	}
	return {
		id,
		type: "text",
		name: id,
		elements: list as TextTrack["elements"], // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by type
		hidden: false,
	};
}

function buildAudioTrack({
	id,
	elements = [],
}: {
	id: string;
	elements?: AudioTrack["elements"];
}): AudioTrack {
	const audioElements: AudioElement[] = [];
	for (const element of elements) {
		if (element) {
			audioElements.push(element as AudioElement);
		}
	}
	return {
		id,
		type: "audio",
		name: id,
		elements: audioElements,
		muted: false,
	};
}

function buildSceneTracks({
	overlay = [],
	main,
	audio = [],
}: {
	overlay?: Array<OverlayTrack>;
	main?: VideoTrack;
	audio?: Array<AudioTrack>;
}): SceneTracks {
	const defaultMain: VideoTrack = {
		id: "video-main",
		type: "video",
		name: "video-main",
		elements: [],
		muted: false,
		hidden: false,
	};
	return {
		overlay,
		main: main ?? defaultMain,
		audio,
	};
}

describe("autoDeleteEmptyTracks", () => {
	test("removes overlay and audio tracks that became empty", () => {
		const oldTracks = buildSceneTracks({
			overlay: [
				buildOverlayTrack({
					id: "video-1",
					type: "video",
					elements: [buildVideoElement({ id: "a", startTime: 0, duration: 5 })],
				}),
				buildOverlayTrack({ id: "text-1", type: "text" }),
			],
			audio: [
				buildAudioTrack({
					id: "audio-1",
					elements: [
						{
							id: "b",
							type: "audio",
							name: "b",
							startTime: mediaTime({ ticks: 0 }),
							duration: mediaTime({ ticks: 3 }),
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							params: { volume: 1, muted: false },
							sourceType: "upload",
							mediaId: "media-b",
						} as AudioElement,
					],
				}),
			],
		});

		const newTracks = buildSceneTracks({
			overlay: [
				buildOverlayTrack({ id: "video-1", type: "video" }),
				buildOverlayTrack({ id: "text-1", type: "text" }),
			],
			audio: [buildAudioTrack({ id: "audio-1" })],
		});

		const cleaned = autoDeleteEmptyTracks({
			tracks: newTracks,
			oldTracks,
		});

		expect(cleaned.overlay.map((track) => track.id)).toEqual(["text-1"]);
		expect(cleaned.audio).toEqual([]);
		expect(cleaned.main.id).toBe("video-main");
	});

	test("keeps tracks that were already empty so the user can author on them", () => {
		const oldTracks = buildSceneTracks({
			overlay: [buildOverlayTrack({ id: "video-1", type: "video" })],
		});

		const newTracks = buildSceneTracks({
			overlay: [buildOverlayTrack({ id: "video-1", type: "video" })],
		});

		const cleaned = autoDeleteEmptyTracks({
			tracks: newTracks,
			oldTracks,
		});

		expect(cleaned.overlay.map((track) => track.id)).toEqual(["video-1"]);
	});

	test("keeps tracks that just got added with no elements yet", () => {
		const oldTracks = buildSceneTracks({});

		const newTracks = buildSceneTracks({
			overlay: [buildOverlayTrack({ id: "video-new", type: "video" })],
		});

		const cleaned = autoDeleteEmptyTracks({
			tracks: newTracks,
			oldTracks,
		});

		expect(cleaned.overlay.map((track) => track.id)).toEqual(["video-new"]);
	});

	test("never deletes the main track even when it has no elements", () => {
		const oldTracks = buildSceneTracks({
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				elements: [buildVideoElement({ id: "a", startTime: 0, duration: 5 })],
				muted: false,
				hidden: false,
			},
		});

		const newTracks = buildSceneTracks({
			main: {
				id: "video-main",
				type: "video",
				name: "video-main",
				elements: [],
				muted: false,
				hidden: false,
			},
		});

		const cleaned = autoDeleteEmptyTracks({
			tracks: newTracks,
			oldTracks,
		});

		expect(cleaned.main.elements).toEqual([]);
		expect(cleaned.main.id).toBe("video-main");
	});

	test("passes through tracks that still have elements", () => {
		const element = buildVideoElement({
			id: "still-here",
			startTime: 0,
			duration: 5,
		});
		const oldTracks = buildSceneTracks({
			overlay: [
				buildOverlayTrack({
					id: "video-1",
					type: "video",
					elements: [element],
				}),
			],
		});

		const newTracks = buildSceneTracks({
			overlay: [
				buildOverlayTrack({
					id: "video-1",
					type: "video",
					elements: [element],
				}),
			],
		});

		const cleaned = autoDeleteEmptyTracks({
			tracks: newTracks,
			oldTracks,
		});

		expect(cleaned.overlay).toHaveLength(1);
		expect(cleaned.overlay[0]?.id).toBe("video-1");
		expect(cleaned.overlay[0]?.elements).toEqual([element]);
	});
});