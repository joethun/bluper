import { describe, expect, test } from "bun:test";
import {
	buildFrozenElement,
	canFreezeElementAtTime,
	findFreezeTarget,
	getSourceTimeAtTimelineTime,
	isFreezableElement,
	isFrozenElement,
	resolveSampledSourceTime,
} from "@/freeze";
import { buildCurveRetime, buildRetimeCurvePreset } from "@/retime";
import type {
	SceneTracks,
	TextElement,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: value * TICKS_PER_SECOND });
}

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Clip",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: { opacity: 1, volume: 1 },
		...overrides,
	};
}

function buildTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "text-1",
		type: "text",
		name: "Text",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "hello" },
		...overrides,
	};
}

function buildTrack({
	id,
	elements,
}: {
	id: string;
	elements: VideoTrack["elements"];
}): VideoTrack {
	return {
		id,
		type: "video",
		name: id,
		muted: false,
		hidden: false,
		elements,
	};
}

function buildTracks({
	main,
	overlay = [],
}: {
	main: VideoTrack;
	overlay?: VideoTrack[];
}): SceneTracks {
	return { overlay, main, audio: [] };
}

describe("isFreezableElement", () => {
	test("accepts video and rejects everything else", () => {
		expect(isFreezableElement(buildVideoElement())).toBe(true);
		expect(isFreezableElement(buildTextElement())).toBe(false);
	});
});

describe("getSourceTimeAtTimelineTime", () => {
	test("maps a timeline time onto the source, honouring the trim", () => {
		const element = buildVideoElement({
			startTime: seconds({ value: 4 }),
			trimStart: seconds({ value: 2 }),
		});

		expect(
			getSourceTimeAtTimelineTime({ element, time: seconds({ value: 7 }) }),
		).toBe(seconds({ value: 5 }));
	});

	test("folds retime in, so a slowed clip holds the frame that is on screen", () => {
		const element = buildVideoElement({ retime: { rate: 0.5 } });

		// Half speed: four seconds into the clip is two seconds into the source.
		expect(
			getSourceTimeAtTimelineTime({ element, time: seconds({ value: 4 }) }),
		).toBe(seconds({ value: 2 }));
	});

	test("a still maps every timeline time to its one held frame", () => {
		const element = buildVideoElement({
			freeze: { sourceTime: seconds({ value: 3 }) },
		});

		expect(
			getSourceTimeAtTimelineTime({ element, time: seconds({ value: 9 }) }),
		).toBe(seconds({ value: 3 }));
	});

	test("clamps past the end of what the clip shows", () => {
		const element = buildVideoElement({ duration: seconds({ value: 2 }) });

		expect(
			getSourceTimeAtTimelineTime({ element, time: seconds({ value: 5 }) }),
		).toBe(seconds({ value: 2 }));
	});
});

describe("buildFrozenElement", () => {
	const source = buildVideoElement({
		name: "Beach",
		trimStart: seconds({ value: 1 }),
		trimEnd: seconds({ value: 2 }),
		retime: { rate: 2 },
		transitionIn: {
			id: "transition-1",
			type: "fade",
			duration: seconds({ value: 1 }),
			params: {},
		},
		animations: { "transform.positionX": { keys: [] } },
		params: { opacity: 1, volume: 1 },
	});
	const frozen = buildFrozenElement({
		element: source,
		sourceTime: seconds({ value: 6 }),
		startTime: seconds({ value: 4 }),
		duration: seconds({ value: 3 }),
		id: "frozen-1",
	});

	test("pins the sampled frame and collapses the trim onto it", () => {
		expect(frozen.freeze).toEqual({ sourceTime: seconds({ value: 6 }) });
		expect(frozen.trimStart).toBe(seconds({ value: 6 }));
		expect(frozen.trimEnd).toBe(ZERO_MEDIA_TIME);
		expect(isFrozenElement({ element: frozen })).toBe(true);
	});

	test("takes the requested identity and placement", () => {
		expect(frozen.id).toBe("frozen-1");
		expect(frozen.name).toBe("Beach (frozen)");
		expect(frozen.startTime).toBe(seconds({ value: 4 }));
		expect(frozen.duration).toBe(seconds({ value: 3 }));
	});

	test("drops what a single held frame cannot have", () => {
		expect(frozen.params.muted).toBe(true);
		expect(frozen.retime).toBeUndefined();
		expect(frozen.transitionIn).toBeUndefined();
		expect(frozen.animations).toBeUndefined();
	});

	test("leaves the clip it was sampled from untouched", () => {
		expect(source.freeze).toBeUndefined();
		expect(source.retime).toEqual({ rate: 2 });
		expect(source.params.muted).toBeUndefined();
	});
});

describe("resolveSampledSourceTime", () => {
	test("a still holds its frame no matter how far into the clip we are", () => {
		const freeze = { sourceTime: seconds({ value: 6 }) };

		expect(
			resolveSampledSourceTime({
				freeze,
				trimStart: seconds({ value: 6 }),
				clipTime: seconds({ value: 2 }),
			}),
		).toBe(seconds({ value: 6 }));
	});

	test("an ordinary clip walks the source from its trim", () => {
		expect(
			resolveSampledSourceTime({
				trimStart: seconds({ value: 1 }),
				clipTime: seconds({ value: 2 }),
			}),
		).toBe(seconds({ value: 3 }));
	});

	test("retime sets how fast an unfrozen clip walks it", () => {
		expect(
			resolveSampledSourceTime({
				trimStart: ZERO_MEDIA_TIME,
				clipTime: seconds({ value: 2 }),
				retime: { rate: 2 },
			}),
		).toBe(seconds({ value: 4 }));
	});

	/**
	 * A speed curve is an integral, so the source time it lands on is a fraction
	 * of a tick more often than not. Every sampled time still has to be a whole
	 * tick count — the renderer asks for one on every frame it draws.
	 */
	test("a speed curve still lands on whole ticks", () => {
		const clipDuration = seconds({ value: 5 });
		const retime = buildCurveRetime({
			curve: buildRetimeCurvePreset({ presetId: "montage" }),
		});

		for (const fraction of [0, 0.13, 0.37, 0.5, 0.81, 1]) {
			const sourceTime = resolveSampledSourceTime({
				trimStart: seconds({ value: 1 }),
				clipTime: clipDuration * fraction,
				clipDuration,
				retime,
			});

			expect(Number.isInteger(sourceTime)).toBe(true);
		}
	});
});

describe("canFreezeElementAtTime", () => {
	const element = buildVideoElement({
		startTime: seconds({ value: 2 }),
		duration: seconds({ value: 4 }),
	});

	test("covers the clip's start frame but not the frame at its end", () => {
		expect(
			canFreezeElementAtTime({ element, time: seconds({ value: 2 }) }),
		).toBe(true);
		expect(
			canFreezeElementAtTime({ element, time: seconds({ value: 4 }) }),
		).toBe(true);
		expect(
			canFreezeElementAtTime({ element, time: seconds({ value: 6 }) }),
		).toBe(false);
	});

	test("rejects times outside the clip and kinds that cannot be frozen", () => {
		expect(
			canFreezeElementAtTime({ element, time: seconds({ value: 1 }) }),
		).toBe(false);
		expect(
			canFreezeElementAtTime({
				element: buildTextElement(),
				time: ZERO_MEDIA_TIME,
			}),
		).toBe(false);
	});
});

describe("findFreezeTarget", () => {
	const mainClip = buildVideoElement({
		id: "main-clip",
		duration: seconds({ value: 10 }),
	});
	const overlayClip = buildVideoElement({
		id: "overlay-clip",
		startTime: seconds({ value: 2 }),
		duration: seconds({ value: 4 }),
	});
	const tracks = buildTracks({
		main: buildTrack({ id: "main", elements: [mainClip] }),
		overlay: [buildTrack({ id: "overlay", elements: [overlayClip] })],
	});

	test("prefers the layer on top when nothing is selected", () => {
		expect(
			findFreezeTarget({
				tracks,
				time: seconds({ value: 3 }),
				selectedElements: [],
			}),
		).toEqual({ trackId: "overlay", elementId: "overlay-clip" });
	});

	test("falls through to the main track where the overlay does not reach", () => {
		expect(
			findFreezeTarget({
				tracks,
				time: seconds({ value: 8 }),
				selectedElements: [],
			}),
		).toEqual({ trackId: "main", elementId: "main-clip" });
	});

	test("honours a single selection over what is on top", () => {
		expect(
			findFreezeTarget({
				tracks,
				time: seconds({ value: 3 }),
				selectedElements: [{ trackId: "main", elementId: "main-clip" }],
			}),
		).toEqual({ trackId: "main", elementId: "main-clip" });
	});

	test("ignores a selection the playhead is not over", () => {
		expect(
			findFreezeTarget({
				tracks,
				time: seconds({ value: 8 }),
				selectedElements: [{ trackId: "overlay", elementId: "overlay-clip" }],
			}),
		).toBeNull();
	});

	test("returns nothing past the end of every clip", () => {
		expect(
			findFreezeTarget({
				tracks,
				time: seconds({ value: 20 }),
				selectedElements: [],
			}),
		).toBeNull();
	});

	test("looks past a hidden layer to the one showing underneath", () => {
		const hiddenOverlay = buildTracks({
			main: buildTrack({ id: "main", elements: [mainClip] }),
			overlay: [
				{
					...buildTrack({ id: "overlay", elements: [overlayClip] }),
					hidden: true,
				},
			],
		});

		expect(
			findFreezeTarget({
				tracks: hiddenOverlay,
				time: seconds({ value: 3 }),
				selectedElements: [],
			}),
		).toEqual({ trackId: "main", elementId: "main-clip" });
	});

	test("skips a hidden clip on a visible track", () => {
		const hiddenClip = buildTracks({
			main: buildTrack({ id: "main", elements: [mainClip] }),
			overlay: [
				buildTrack({
					id: "overlay",
					elements: [{ ...overlayClip, hidden: true }],
				}),
			],
		});

		expect(
			findFreezeTarget({
				tracks: hiddenClip,
				time: seconds({ value: 3 }),
				selectedElements: [],
			}),
		).toEqual({ trackId: "main", elementId: "main-clip" });
	});

	test("honours a hidden clip when it is what the user selected", () => {
		const hiddenClip = buildTracks({
			main: buildTrack({ id: "main", elements: [mainClip] }),
			overlay: [
				buildTrack({
					id: "overlay",
					elements: [{ ...overlayClip, hidden: true }],
				}),
			],
		});

		expect(
			findFreezeTarget({
				tracks: hiddenClip,
				time: seconds({ value: 3 }),
				selectedElements: [{ trackId: "overlay", elementId: "overlay-clip" }],
			}),
		).toEqual({ trackId: "overlay", elementId: "overlay-clip" });
	});
});
