import { describe, expect, test } from "bun:test";
import type { SceneTracks, VideoTrack } from "@/timeline";
import { findTransitionCutAtTime } from "@/transitions";
import { ZERO_MEDIA_TIME, mediaTime } from "@/wasm";

const CLIP = mediaTime({ ticks: 1000 });

function clip({ id, start }: { id: string; start: number }) {
	return {
		id,
		name: id,
		type: "video" as const,
		mediaId: "m1",
		duration: CLIP,
		startTime: mediaTime({ ticks: start }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function videoTrack({
	id,
	starts,
}: {
	id: string;
	starts: number[];
}): VideoTrack {
	return {
		id,
		name: id,
		type: "video",
		muted: false,
		hidden: false,
		elements: starts.map((start) => clip({ id: `${id}-${start}`, start })),
	};
}

/** Two clips butted together on main: the only join is at tick 1000. */
function tracksWithOneCut(): SceneTracks {
	return {
		overlay: [],
		main: videoTrack({ id: "main", starts: [0, 1000] }),
		audio: [],
	};
}

describe("findTransitionCutAtTime", () => {
	test("finds the join the playhead sits exactly on", () => {
		const cut = findTransitionCutAtTime({
			tracks: tracksWithOneCut(),
			time: mediaTime({ ticks: 1000 }),
			toleranceTicks: 0,
		});
		expect(cut?.trackId).toBe("main");
		// The transition is stored on the later clip.
		expect(cut?.incomingId).toBe("main-1000");
		expect(cut?.outgoingId).toBe("main-0");
	});

	test("accepts the playhead within the slack it is given", () => {
		const tracks = tracksWithOneCut();
		for (const ticks of [990, 1010]) {
			expect(
				findTransitionCutAtTime({
					tracks,
					time: mediaTime({ ticks }),
					toleranceTicks: 10,
				}),
				`${ticks} should land`,
			).not.toBeNull();
			expect(
				findTransitionCutAtTime({
					tracks,
					time: mediaTime({ ticks }),
					toleranceTicks: 0,
				}),
				`${ticks} should miss with no slack`,
			).toBeNull();
		}
	});

	test("finds nothing mid-clip", () => {
		expect(
			findTransitionCutAtTime({
				tracks: tracksWithOneCut(),
				time: mediaTime({ ticks: 500 }),
				toleranceTicks: 40,
			}),
		).toBeNull();
	});

	test("a gap between clips is not a join", () => {
		const tracks: SceneTracks = {
			overlay: [],
			main: videoTrack({ id: "main", starts: [0, 5000] }),
			audio: [],
		};
		expect(
			findTransitionCutAtTime({
				tracks,
				time: mediaTime({ ticks: 5000 }),
				toleranceTicks: 40,
			}),
		).toBeNull();
	});

	test("the selected element's track wins when two tracks are cut together", () => {
		const tracks: SceneTracks = {
			overlay: [videoTrack({ id: "overlay", starts: [0, 1000] })],
			main: videoTrack({ id: "main", starts: [0, 1000] }),
			audio: [],
		};
		const time = mediaTime({ ticks: 1000 });

		expect(
			findTransitionCutAtTime({ tracks, time, toleranceTicks: 0 })?.trackId,
			"overlay is scanned first, so it wins by default",
		).toBe("overlay");
		expect(
			findTransitionCutAtTime({
				tracks,
				time,
				toleranceTicks: 0,
				preferredTrackId: "main",
			})?.trackId,
		).toBe("main");
	});

	test("a preferred track with no join does not suppress the real one", () => {
		expect(
			findTransitionCutAtTime({
				tracks: tracksWithOneCut(),
				time: mediaTime({ ticks: 1000 }),
				toleranceTicks: 0,
				preferredTrackId: "some-other-track",
			})?.trackId,
		).toBe("main");
	});

	test("the nearest join wins when several are in range", () => {
		const tracks: SceneTracks = {
			overlay: [],
			main: videoTrack({ id: "main", starts: [0, 1000, 2000] }),
			audio: [],
		};
		expect(
			findTransitionCutAtTime({
				tracks,
				time: mediaTime({ ticks: 1900 }),
				toleranceTicks: 1000,
			})?.incomingId,
		).toBe("main-2000");
	});
});
