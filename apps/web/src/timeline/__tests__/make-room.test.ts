import { describe, expect, test } from "bun:test";
import type { SceneTracks, VideoElement } from "@/timeline";
import { shiftElementsClearOfElement } from "@/timeline/make-room";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 100 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(elements: VideoElement[]): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements,
		},
		audio: [],
	};
}

function startsOf({ tracks }: { tracks: SceneTracks }): number[] {
	return tracks.main.elements.map((element) => element.startTime);
}

describe("shiftElementsClearOfElement", () => {
	test("pushes a butt-joined neighbour clear of a clip that grew", () => {
		// A clip slowed to half speed: 100 ticks of timeline become 200.
		const grown = buildVideoElement({ duration: mediaTime({ ticks: 200 }) });
		const tracks = buildTracks([
			grown,
			buildVideoElement({ id: "video-2", startTime: mediaTime({ ticks: 100 }) }),
		]);

		expect(
			startsOf({
				tracks: shiftElementsClearOfElement({
					tracks,
					trackId: "main-track",
					element: grown,
				}),
			}),
		).toEqual([0, 200]);
	});

	test("keeps the spacing of clips further down the track", () => {
		const grown = buildVideoElement({ duration: mediaTime({ ticks: 200 }) });
		const tracks = buildTracks([
			grown,
			buildVideoElement({ id: "video-2", startTime: mediaTime({ ticks: 100 }) }),
			buildVideoElement({ id: "video-3", startTime: mediaTime({ ticks: 400 }) }),
		]);

		// Everything after the collision moves by the same 100 ticks, so the gap
		// between the trailing clips survives.
		expect(
			startsOf({
				tracks: shiftElementsClearOfElement({
					tracks,
					trackId: "main-track",
					element: grown,
				}),
			}),
		).toEqual([0, 200, 500]);
	});

	test("takes up only the overlap, not the whole growth", () => {
		const grown = buildVideoElement({ duration: mediaTime({ ticks: 200 }) });
		const tracks = buildTracks([
			grown,
			buildVideoElement({ id: "video-2", startTime: mediaTime({ ticks: 150 }) }),
		]);

		// The clip grew by 100 but only ran 50 into its neighbour.
		expect(
			startsOf({
				tracks: shiftElementsClearOfElement({
					tracks,
					trackId: "main-track",
					element: grown,
				}),
			}),
		).toEqual([0, 200]);
	});

	test("leaves a neighbour with room to spare where it is", () => {
		const grown = buildVideoElement({ duration: mediaTime({ ticks: 200 }) });
		const tracks = buildTracks([
			grown,
			buildVideoElement({ id: "video-2", startTime: mediaTime({ ticks: 900 }) }),
		]);

		expect(
			startsOf({
				tracks: shiftElementsClearOfElement({
					tracks,
					trackId: "main-track",
					element: grown,
				}),
			}),
		).toEqual([0, 900]);
	});

	test("ignores clips on other tracks", () => {
		const grown = buildVideoElement({ duration: mediaTime({ ticks: 200 }) });
		const tracks: SceneTracks = {
			...buildTracks([grown]),
			overlay: [
				{
					id: "overlay-track",
					type: "video",
					name: "Overlay",
					muted: false,
					hidden: false,
					elements: [
						buildVideoElement({
							id: "video-2",
							startTime: mediaTime({ ticks: 100 }),
						}),
					],
				},
			],
		};

		const result = shiftElementsClearOfElement({
			tracks,
			trackId: "main-track",
			element: grown,
		});

		expect(result.overlay[0].elements[0].startTime).toBe(
			mediaTime({ ticks: 100 }),
		);
	});
});
