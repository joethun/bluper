import { describe, expect, test } from "bun:test";
import { freezeFrameInTracks } from "@/freeze";
import type { ImageElement, SceneTracks, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

const IDS = { frozenElementId: "frozen-1", splitElementId: "tail-1" };

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: value * TICKS_PER_SECOND });
}

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "clip",
		type: "video",
		name: "Clip",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: seconds({ value: 10 }),
		mediaId: "media-1",
		params: { opacity: 1, volume: 1 },
		...overrides,
	};
}

function buildTracks({
	elements,
}: {
	elements: (VideoElement | ImageElement)[];
}): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements,
		},
		audio: [],
	};
}

function freeze({
	tracks,
	freezeTime,
	freezeDuration = seconds({ value: 3 }),
	elementId = "clip",
}: {
	tracks: SceneTracks;
	freezeTime: number;
	freezeDuration?: number;
	elementId?: string;
}) {
	return freezeFrameInTracks({
		tracks,
		trackId: "main",
		elementId,
		freezeTime: mediaTime({ ticks: freezeTime }),
		freezeDuration: mediaTime({ ticks: freezeDuration }),
		ids: IDS,
	});
}

describe("freezeFrameInTracks", () => {
	test("cuts the clip and holds the frame the cut landed on", () => {
		const tracks = buildTracks({ elements: [buildVideoElement()] });

		const result = freeze({ tracks, freezeTime: seconds({ value: 4 }) });

		const elements = result?.main.elements ?? [];
		expect(elements).toHaveLength(3);

		const [left, still, tail] = elements;
		expect(left.id).toBe("clip");
		expect(left.startTime).toBe(ZERO_MEDIA_TIME);
		expect(left.duration).toBe(seconds({ value: 4 }));

		expect(still.id).toBe("frozen-1");
		expect(still.startTime).toBe(seconds({ value: 4 }));
		expect(still.duration).toBe(seconds({ value: 3 }));
		expect(still.type === "video" && still.freeze).toEqual({
			sourceTime: seconds({ value: 4 }),
		});

		expect(tail.id).toBe("tail-1");
		expect(tail.startTime).toBe(seconds({ value: 7 }));
		expect(tail.duration).toBe(seconds({ value: 6 }));
	});

	test("keeps each half's trim consistent with the source it still covers", () => {
		const tracks = buildTracks({ elements: [buildVideoElement()] });

		const [left, , tail] =
			freeze({ tracks, freezeTime: seconds({ value: 4 }) })?.main.elements ??
			[];

		expect(left.trimStart).toBe(ZERO_MEDIA_TIME);
		expect(left.trimEnd).toBe(seconds({ value: 6 }));
		expect(tail.trimStart).toBe(seconds({ value: 4 }));
		expect(tail.trimEnd).toBe(ZERO_MEDIA_TIME);

		// trimStart + covered source + trimEnd == sourceDuration, on both halves.
		expect(left.trimStart + left.duration + left.trimEnd).toBe(
			seconds({ value: 10 }),
		);
		expect(tail.trimStart + tail.duration + tail.trimEnd).toBe(
			seconds({ value: 10 }),
		);
	});

	test("slides everything downstream on the track right by the hold", () => {
		const tracks = buildTracks({
			elements: [
				buildVideoElement(),
				buildVideoElement({
					id: "later",
					startTime: seconds({ value: 12 }),
					duration: seconds({ value: 2 }),
				}),
			],
		});

		const later = freeze({
			tracks,
			freezeTime: seconds({ value: 4 }),
		})?.main.elements.find((element) => element.id === "later");

		expect(later?.startTime).toBe(seconds({ value: 15 }));
		expect(later?.duration).toBe(seconds({ value: 2 }));
	});

	test("leaves clips that end before the cut where they are", () => {
		const tracks = buildTracks({
			elements: [
				buildVideoElement({
					id: "earlier",
					startTime: ZERO_MEDIA_TIME,
					duration: seconds({ value: 2 }),
				}),
				buildVideoElement({ startTime: seconds({ value: 2 }) }),
			],
		});

		const earlier = freeze({
			tracks,
			freezeTime: seconds({ value: 5 }),
		})?.main.elements.find((element) => element.id === "earlier");

		expect(earlier?.startTime).toBe(ZERO_MEDIA_TIME);
	});

	test("inserts without cutting when the playhead is on the clip's start", () => {
		const tracks = buildTracks({
			elements: [buildVideoElement({ startTime: seconds({ value: 2 }) })],
		});

		const elements =
			freeze({ tracks, freezeTime: seconds({ value: 2 }) })?.main.elements ??
			[];

		expect(elements).toHaveLength(2);
		expect(elements[0].id).toBe("frozen-1");
		expect(elements[0].startTime).toBe(seconds({ value: 2 }));
		expect(elements[1].id).toBe("clip");
		expect(elements[1].startTime).toBe(seconds({ value: 5 }));
		expect(elements[1].duration).toBe(seconds({ value: 10 }));
	});

	test("appends without cutting when the playhead is on the clip's end", () => {
		const tracks = buildTracks({ elements: [buildVideoElement()] });

		const elements =
			freeze({ tracks, freezeTime: seconds({ value: 10 }) })?.main.elements ??
			[];

		expect(elements).toHaveLength(2);
		expect(elements[0].id).toBe("clip");
		expect(elements[0].duration).toBe(seconds({ value: 10 }));
		expect(elements[1].id).toBe("frozen-1");
		expect(elements[1].startTime).toBe(seconds({ value: 10 }));
	});

	test("splits a retimed clip on the source frame that was on screen", () => {
		const tracks = buildTracks({
			elements: [
				buildVideoElement({
					duration: seconds({ value: 5 }),
					retime: { rate: 2 },
				}),
			],
		});

		const [left, still, tail] =
			freeze({ tracks, freezeTime: seconds({ value: 2 }) })?.main.elements ??
			[];

		// Two seconds into a double-speed clip is four seconds into the source.
		expect(still.type === "video" && still.freeze).toEqual({
			sourceTime: seconds({ value: 4 }),
		});
		expect(left.trimEnd).toBe(seconds({ value: 6 }));
		expect(tail.trimStart).toBe(seconds({ value: 4 }));
		// The two halves still account for the whole source between them.
		expect(left.trimEnd + tail.trimStart).toBe(seconds({ value: 10 }));
	});

	test("the still itself is silent, unretimed and holds one frame", () => {
		const tracks = buildTracks({
			elements: [buildVideoElement({ retime: { rate: 2 } })],
		});

		const still = freeze({
			tracks,
			freezeTime: seconds({ value: 4 }),
		})?.main.elements.find((element) => element.id === "frozen-1");

		expect(still?.params.muted).toBe(true);
		expect(still?.type === "video" && still.retime).toBeUndefined();
		expect(still?.trimEnd).toBe(ZERO_MEDIA_TIME);
	});

	test("does not touch the tracks it was handed", () => {
		const tracks = buildTracks({ elements: [buildVideoElement()] });

		freeze({ tracks, freezeTime: seconds({ value: 4 }) });

		expect(tracks.main.elements).toHaveLength(1);
		expect(tracks.main.elements[0].duration).toBe(seconds({ value: 10 }));
	});

	test("declines a clip kind that cannot be frozen", () => {
		// An image is already a still; there is nothing to freeze it into.
		const tracks = buildTracks({
			elements: [
				{
					id: "clip",
					type: "image",
					name: "Photo",
					startTime: ZERO_MEDIA_TIME,
					duration: seconds({ value: 10 }),
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					mediaId: "media-1",
					params: { opacity: 1 },
				},
			],
		});

		expect(freeze({ tracks, freezeTime: seconds({ value: 4 }) })).toBeNull();
	});

	/**
	 * The still takes over the edge the clip used to meet its neighbour on, so it
	 * has to take the transition with it. Left behind, the transition would
	 * re-target the new boundary between the still and the clip it was cut from —
	 * blending a held frame into the frame it was taken from, which reads as the
	 * transition having disappeared.
	 */
	test("hands a leading transition to a still frozen at the clip's start", () => {
		const transition = {
			id: "t1",
			type: "dissolve",
			duration: seconds({ value: 1 }),
			params: {},
		};
		const tracks = buildTracks({
			elements: [
				buildVideoElement({ id: "before", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "clip",
					startTime: seconds({ value: 10 }),
					transitionIn: transition,
				}),
			],
		});

		const elements =
			freeze({ tracks, freezeTime: seconds({ value: 10 }) })?.main.elements ??
			[];
		const still = elements.find((element) => element.id === "frozen-1");
		const clip = elements.find((element) => element.id === "clip");

		expect(still?.type === "video" && still.transitionIn).toEqual(transition);
		expect(clip).not.toHaveProperty("transitionIn");
	});

	/**
	 * The blended frame is rendered up front and handed in as an image. The still
	 * has to carry none of the clip's own look, because all of it — transform,
	 * opacity, effects, and the blend itself — is already in those pixels.
	 */
	test("inserts a baked image, stripped of the clip's own look, when given one", () => {
		const tracks = buildTracks({
			elements: [
				buildVideoElement({
					params: { opacity: 0.5, volume: 1 },
					effects: [
						{ id: "e1", type: "blur", params: { intensity: 50 }, enabled: true },
					],
				}),
			],
		});

		const result = freezeFrameInTracks({
			tracks,
			trackId: "main",
			elementId: "clip",
			freezeTime: seconds({ value: 4 }),
			freezeDuration: seconds({ value: 3 }),
			bakedMediaId: "baked-1",
			ids: IDS,
		});

		const still = result?.main.elements.find(
			(element) => element.id === "frozen-1",
		);

		expect(still?.type).toBe("image");
		expect(still?.type === "image" && still.mediaId).toBe("baked-1");
		expect(still?.params).toEqual({ opacity: 1 });
		expect(still).not.toHaveProperty("effects");
		expect(still?.duration).toBe(seconds({ value: 3 }));
		expect(still?.startTime).toBe(seconds({ value: 4 }));
		// No freeze marker: the picture is baked, not re-sampled from the source.
		expect(still).not.toHaveProperty("freeze");
	});

	test("holds a source frame when no baked image is supplied", () => {
		const tracks = buildTracks({ elements: [buildVideoElement()] });

		const still = freeze({ tracks, freezeTime: seconds({ value: 4 }) })?.main
			.elements[1];

		expect(still?.type).toBe("video");
		expect(still?.type === "video" && still.freeze).toEqual({
			sourceTime: seconds({ value: 4 }),
		});
	});

	test("declines a playhead outside the clip, or an element that is gone", () => {
		const tracks = buildTracks({
			elements: [buildVideoElement({ startTime: seconds({ value: 5 }) })],
		});

		expect(freeze({ tracks, freezeTime: seconds({ value: 2 }) })).toBeNull();
		expect(freeze({ tracks, freezeTime: seconds({ value: 99 }) })).toBeNull();
		expect(
			freeze({
				tracks,
				freezeTime: seconds({ value: 6 }),
				elementId: "missing",
			}),
		).toBeNull();
	});
});
