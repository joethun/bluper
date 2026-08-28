import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const {
	canElementHaveTransition,
	findTransitionCutAtTime,
	findTransitionCuts,
	findTransitions,
	getActiveTransitionBinding,
	getTransitionBindingsForElement,
	getTransitionCutForElement,
	getTransitionRenderExtension,
	stripTransitionIn,
} = await import("@/wasm/transitions");
type MediaTime = import("@/wasm/media-time").MediaTime;

/**
 * Transition pairing crossed to Rust. The rules themselves are covered by the
 * unit tests in `editor-core::transitions::pairing`; these check the boundary —
 * that placements, cuts and bindings arrive as readable objects rather than as
 * `Map`s, and that `stripTransitionIn` hands an element back with every other
 * field it went in with.
 */

const SECOND = 120_000;

function ticks(count: number): MediaTime {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return count as MediaTime;
}

function wasmArg(value: unknown): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as never;
}

function video({
	id,
	startTime,
	duration,
	transitionDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	transitionDuration?: number;
}) {
	return {
		id,
		name: id,
		type: "video" as const,
		mediaId: "media-1",
		duration: ticks(duration),
		startTime: ticks(startTime),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: {},
		...(transitionDuration === undefined
			? {}
			: {
					transitionIn: {
						id: `${id}-transition`,
						type: "crossDissolve",
						duration: ticks(transitionDuration),
						params: {},
					},
				}),
	};
}

function videoTrack(elements: ReturnType<typeof video>[]) {
	return {
		id: "track-1",
		name: "Main Track",
		type: "video" as const,
		muted: false,
		hidden: false,
		elements,
	};
}

describe("finding transitions on a track", () => {
	it("returns a readable placement straddling the cut", () => {
		const track = videoTrack([
			video({ id: "a", startTime: 0, duration: SECOND }),
			video({
				id: "b",
				startTime: SECOND,
				duration: SECOND,
				transitionDuration: 12_000,
			}),
		]);

		const placements = findTransitions({ track: wasmArg(track) });
		expect(placements).not.toBeInstanceOf(Map);
		expect(placements).toHaveLength(1);

		const placement = placements[0];
		expect(placement).not.toBeInstanceOf(Map);
		expect(placement.trackId).toBe("track-1");
		expect(placement.outgoingId).toBe("a");
		expect(placement.incomingId).toBe("b");
		expect(placement.cut).toBe(ticks(SECOND));
		expect(placement.duration).toBe(ticks(12_000));
		expect(placement.windowStart).toBe(ticks(SECOND - 6_000));
		expect(placement.windowEnd).toBe(ticks(SECOND + 6_000));
		expect(placement.transition.type).toBe("crossDissolve");
		expect(placement.transition.params).not.toBeInstanceOf(Map);
		expect(placement.sides).toHaveLength(2);
		expect(placement.sides[0].role).toBe("outgoing");
		expect(placement.sides[1].headExtension).toBe(ticks(6_000));
	});

	it("reports a cut whether or not it carries a transition", () => {
		const track = videoTrack([
			video({ id: "a", startTime: 0, duration: SECOND }),
			video({ id: "b", startTime: SECOND, duration: SECOND }),
		]);

		const cuts = findTransitionCuts({ track: wasmArg(track) });
		expect(cuts).toHaveLength(1);
		expect(cuts[0]).not.toBeInstanceOf(Map);
		expect(cuts[0].transition).toBeNull();
		expect(cuts[0].maxDuration).toBe(ticks(SECOND));

		expect(
			getTransitionCutForElement({ track: wasmArg(track), elementId: "b" })
				?.incomingId,
		).toBe("b");
		expect(
			getTransitionCutForElement({ track: wasmArg(track), elementId: "a" }),
		).toBeNull();
	});
});

describe("finding the cut under the playhead", () => {
	const tracks = {
		overlay: [],
		main: videoTrack([
			video({ id: "a", startTime: 0, duration: SECOND }),
			video({ id: "b", startTime: SECOND, duration: SECOND }),
		]),
		audio: [],
	};

	it("accepts the slack the caller allows", () => {
		expect(
			findTransitionCutAtTime({
				tracks: wasmArg(tracks),
				time: ticks(SECOND + 50),
				toleranceTicks: 100,
			})?.incomingId,
		).toBe("b");
		expect(
			findTransitionCutAtTime({
				tracks: wasmArg(tracks),
				time: ticks(SECOND + 500),
				toleranceTicks: 100,
			}),
		).toBeNull();
	});
});

describe("bindings for one element", () => {
	const track = videoTrack([
		video({ id: "a", startTime: 0, duration: SECOND }),
		video({
			id: "b",
			startTime: SECOND,
			duration: SECOND,
			transitionDuration: 12_000,
		}),
	]);
	const placements = findTransitions({ track: wasmArg(track) });

	it("binds each side of the cut to its own clip", () => {
		const incoming = getTransitionBindingsForElement({
			placements,
			elementId: "b",
		});
		expect(incoming).toHaveLength(1);
		expect(incoming[0]).not.toBeInstanceOf(Map);
		expect(incoming[0].role).toBe("incoming");
		expect(incoming[0].headExtension).toBe(ticks(6_000));
		expect(incoming[0].transition.duration).toBe(ticks(12_000));

		const outgoing = getTransitionBindingsForElement({
			placements,
			elementId: "a",
		});
		expect(outgoing[0].role).toBe("outgoing");
		expect(outgoing[0].tailExtension).toBe(ticks(6_000));
	});

	it("grows the render window by the widest extension", () => {
		const bindings = getTransitionBindingsForElement({
			placements,
			elementId: "b",
		});
		expect(getTransitionRenderExtension({ bindings })).toEqual({
			head: ticks(6_000),
			tail: ticks(0),
		});
	});

	it("finds the binding covering an instant, including between ticks", () => {
		const bindings = getTransitionBindingsForElement({
			placements,
			elementId: "b",
		});
		expect(
			getActiveTransitionBinding({ bindings, time: SECOND }),
		).not.toBeNull();
		expect(
			getActiveTransitionBinding({ bindings, time: SECOND - 6_000 - 0.5 }),
		).toBeNull();
		expect(
			getActiveTransitionBinding({ bindings, time: SECOND - 6_000 + 0.5 }),
		).not.toBeNull();
		// Half-open at the far end.
		expect(
			getActiveTransitionBinding({ bindings, time: SECOND + 6_000 }),
		).toBeNull();
	});
});

describe("stripping a transition off a split half", () => {
	it("keeps every other field the element arrived with", () => {
		const element = video({
			id: "b",
			startTime: SECOND,
			duration: SECOND,
			transitionDuration: 12_000,
		});
		const stripped = stripTransitionIn({ element: wasmArg(element) });

		expect(stripped).not.toBeInstanceOf(Map);
		expect("transitionIn" in stripped).toBe(false);
		expect(stripped).toEqual(
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			video({ id: "b", startTime: SECOND, duration: SECOND }) as never,
		);
	});

	it("leaves an element that never had one alone", () => {
		const element = video({ id: "a", startTime: 0, duration: SECOND });
		expect(stripTransitionIn({ element: wasmArg(element) })).toEqual(
			wasmArg(element),
		);
	});
});

describe("which clips can carry a transition", () => {
	it("takes only the kinds with footage of their own", () => {
		expect(canElementHaveTransition({ element: { type: "video" } })).toBe(true);
		expect(canElementHaveTransition({ element: { type: "image" } })).toBe(true);
		expect(canElementHaveTransition({ element: { type: "text" } })).toBe(false);
		expect(canElementHaveTransition({ element: { type: "audio" } })).toBe(false);
	});
});
