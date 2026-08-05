import { describe, expect, test } from "bun:test";
import type { VideoElement, VideoTrack } from "@/timeline";
import {
	buildTransitionInstance,
	clampTransitionDuration,
	findTransitionCuts,
	findTransitions,
	getMaxTransitionDuration,
	getTransitionBindingsForElement,
	getTransitionCutForElement,
	hasActiveTransition,
	getTransitionRenderExtension,
	registerDefaultTransitions,
	resolveTransitionFrame,
	stripTransitionIn,
	transitionsRegistry,
} from "@/transitions";
import type { ElementTransition } from "@/transitions/types";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

if (!transitionsRegistry.has("dissolve")) {
	registerDefaultTransitions();
}

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
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

function buildTrack({
	elements,
}: {
	elements: VideoTrack["elements"];
}): VideoTrack {
	return {
		id: "track-1",
		type: "video",
		name: "track-1",
		muted: false,
		hidden: false,
		elements,
	};
}

function buildTransition(
	overrides: Partial<ElementTransition> = {},
): ElementTransition {
	return {
		...buildTransitionInstance({ transitionType: "dissolve" }),
		duration: seconds({ value: 1 }),
		...overrides,
	};
}

/** Two 10s clips butted together at t=10, with no transition between them. */
function buildAdjacentPair() {
	return buildTrack({
		elements: [
			buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME }),
			buildVideoElement({ id: "b", startTime: seconds({ value: 10 }) }),
		],
	});
}

/**
 * The same two clips with a 1s transition on the cut. Neither clip moves — the
 * window straddles t=10, taking half a second from each side.
 */
function buildTransitionPair({
	transition = buildTransition(),
}: { transition?: ElementTransition } = {}) {
	return buildTrack({
		elements: [
			buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME }),
			buildVideoElement({
				id: "b",
				startTime: seconds({ value: 10 }),
				transitionIn: transition,
			}),
		],
	});
}

describe("findTransitions", () => {
	test("centres the window on the cut the two clips share", () => {
		const placements = findTransitions({ track: buildTransitionPair() });

		expect(placements).toHaveLength(1);
		expect(placements[0].cut).toBe(seconds({ value: 10 }));
		expect(placements[0].duration).toBe(seconds({ value: 1 }));
		expect(placements[0].windowStart).toBe(seconds({ value: 9.5 }));
		expect(placements[0].windowEnd).toBe(seconds({ value: 10.5 }));
		expect(placements[0].outgoingId).toBe("a");
		expect(placements[0].incomingId).toBe("b");
		expect(placements[0].sides.map((side) => side.role)).toEqual([
			"outgoing",
			"incoming",
		]);
	});

	/** Neither clip moves and the project keeps its length. */
	test("leaves both clips exactly where they were", () => {
		const track = buildTransitionPair();
		const [a, b] = track.elements;

		expect(a.startTime).toBe(ZERO_MEDIA_TIME);
		expect(b.startTime).toBe(seconds({ value: 10 }));
		expect(a.duration).toBe(seconds({ value: 10 }));
		expect(b.duration).toBe(seconds({ value: 10 }));
	});

	/**
	 * A transition joins two clips, so it has nothing to do without a neighbour.
	 * Fading a lone clip against the background is a separate feature.
	 */
	test("ignores a transition on a clip that opens the track", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({
					id: "a",
					startTime: ZERO_MEDIA_TIME,
					transitionIn: buildTransition(),
				}),
			],
		});

		expect(findTransitions({ track })).toHaveLength(0);
	});

	test("ignores a transition when a gap separates the clips", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "b",
					// A second of daylight between them: no cut, so nothing to bridge.
					startTime: seconds({ value: 11 }),
					transitionIn: buildTransition(),
				}),
			],
		});

		expect(findTransitions({ track })).toHaveLength(0);
	});

	test("clamps a window that would outrun the shorter neighbour", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({
					id: "a",
					startTime: ZERO_MEDIA_TIME,
					duration: seconds({ value: 2 }),
				}),
				buildVideoElement({
					id: "b",
					startTime: seconds({ value: 2 }),
					duration: seconds({ value: 10 }),
					transitionIn: buildTransition({ duration: seconds({ value: 8 }) }),
				}),
			],
		});

		const placements = findTransitions({ track });

		expect(placements).toHaveLength(1);
		expect(placements[0].duration).toBe(seconds({ value: 2 }));
		expect(placements[0].windowStart).toBe(seconds({ value: 1 }));
		expect(placements[0].windowEnd).toBe(seconds({ value: 3 }));
	});
});

describe("findTransitionCuts", () => {
	test("reports the join two clips share, transition or not", () => {
		const cuts = findTransitionCuts({ track: buildAdjacentPair() });

		expect(cuts).toHaveLength(1);
		expect(cuts[0]).toMatchObject({
			outgoingId: "a",
			incomingId: "b",
			time: seconds({ value: 10 }),
			transition: null,
		});
		expect(cuts[0].maxDuration).toBe(seconds({ value: 10 }));
	});

	test("reports the transition already on a join", () => {
		const cuts = findTransitionCuts({ track: buildTransitionPair() });

		expect(cuts[0].transition).not.toBeNull();
	});

	test("reports no join for a lone clip, so a drop has nowhere to land", () => {
		expect(
			findTransitionCuts({
				track: buildTrack({ elements: [buildVideoElement({ id: "a" })] }),
			}),
		).toHaveLength(0);
	});

	test("reports no join across a gap", () => {
		expect(
			findTransitionCuts({
				track: buildTrack({
					elements: [
						buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME }),
						buildVideoElement({ id: "b", startTime: seconds({ value: 11 }) }),
					],
				}),
			}),
		).toHaveLength(0);
	});

	test("caps a join at the shorter of its two clips", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({
					id: "a",
					startTime: ZERO_MEDIA_TIME,
					duration: seconds({ value: 3 }),
				}),
				buildVideoElement({
					id: "b",
					startTime: seconds({ value: 3 }),
					duration: seconds({ value: 9 }),
				}),
			],
		});

		expect(getMaxTransitionDuration({ track, elementId: "b" })).toBe(
			seconds({ value: 3 }),
		);
		expect(getTransitionCutForElement({ track, elementId: "a" })).toBeNull();
	});

	/**
	 * A clip in the middle of a run can be the incoming side of one transition and
	 * the outgoing side of the next. Each half is capped at half the clip, so the two
	 * windows can touch but never overlap — otherwise the renderer would have to pick
	 * one arbitrarily for the frames they both claimed.
	 */
	test("keeps two transitions on one clip from overlapping each other", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({
					id: "a",
					startTime: ZERO_MEDIA_TIME,
					duration: seconds({ value: 4 }),
				}),
				buildVideoElement({
					id: "b",
					startTime: seconds({ value: 4 }),
					duration: seconds({ value: 4 }),
					transitionIn: buildTransition({ duration: seconds({ value: 4 }) }),
				}),
				buildVideoElement({
					id: "c",
					startTime: seconds({ value: 8 }),
					duration: seconds({ value: 4 }),
					transitionIn: buildTransition({ duration: seconds({ value: 4 }) }),
				}),
			],
		});

		const bindings = getTransitionBindingsForElement({
			placements: findTransitions({ track }),
			elementId: "b",
		});

		expect(bindings).toHaveLength(2);
		const incoming = bindings.find((binding) => binding.role === "incoming");
		const outgoing = bindings.find((binding) => binding.role === "outgoing");
		expect(incoming?.windowEnd).toBeLessThanOrEqual(outgoing?.windowStart ?? 0);
	});
});

describe("clampTransitionDuration", () => {
	test("caps at the shorter of the two clips", () => {
		expect(
			clampTransitionDuration({
				duration: seconds({ value: 5 }),
				outgoingDuration: seconds({ value: 3 }),
				incomingDuration: seconds({ value: 8 }),
			}),
		).toBe(seconds({ value: 3 }));
	});

	test("leaves a duration both clips can absorb alone", () => {
		expect(
			clampTransitionDuration({
				duration: seconds({ value: 1 }),
				outgoingDuration: seconds({ value: 3 }),
				incomingDuration: seconds({ value: 8 }),
			}),
		).toBe(seconds({ value: 1 }));
	});
});

describe("getTransitionBindingsForElement", () => {
	test("binds the incoming clip to its own side of the cut", () => {
		const bindings = getTransitionBindingsForElement({
			placements: findTransitions({ track: buildTransitionPair() }),
			elementId: "b",
		});

		expect(bindings).toHaveLength(1);
		expect(bindings[0].role).toBe("incoming");
		expect(bindings[0].windowStart).toBe(seconds({ value: 9.5 }));
		expect(bindings[0].windowEnd).toBe(seconds({ value: 10.5 }));
	});

	test("binds the previous clip to the outgoing side of the same cut", () => {
		const bindings = getTransitionBindingsForElement({
			placements: findTransitions({ track: buildTransitionPair() }),
			elementId: "a",
		});

		expect(bindings).toHaveLength(1);
		expect(bindings[0].role).toBe("outgoing");
	});

	/**
	 * The window deliberately runs outside both clips: that overhang is where each one
	 * reaches into the footage its trim is hiding, which is what keeps the picture
	 * moving through the blend.
	 */
	test("gives each side the reach it needs past its own edge", () => {
		const placements = findTransitions({ track: buildTransitionPair() });
		const incoming = getTransitionRenderExtension({
			bindings: getTransitionBindingsForElement({ placements, elementId: "b" }),
		});
		const outgoing = getTransitionRenderExtension({
			bindings: getTransitionBindingsForElement({ placements, elementId: "a" }),
		});

		expect(incoming.head).toBe(seconds({ value: 0.5 }));
		expect(incoming.tail).toBe(ZERO_MEDIA_TIME);
		expect(outgoing.tail).toBe(seconds({ value: 0.5 }));
		expect(outgoing.head).toBe(ZERO_MEDIA_TIME);
	});

	test("asks for no reach at all without a transition", () => {
		expect(getTransitionRenderExtension({ bindings: [] })).toEqual({
			head: ZERO_MEDIA_TIME,
			tail: ZERO_MEDIA_TIME,
		});
	});
});

describe("hasActiveTransition", () => {
	test("is true for a stored transition that still joins two clips", () => {
		expect(
			hasActiveTransition({ track: buildTransitionPair(), elementId: "b" }),
		).toBe(true);
	});

	test("is false once the previous clip is dragged away", () => {
		const track = buildTrack({
			elements: [
				buildVideoElement({ id: "a", startTime: ZERO_MEDIA_TIME }),
				buildVideoElement({
					id: "b",
					startTime: seconds({ value: 12 }),
					transitionIn: buildTransition(),
				}),
			],
		});

		expect(hasActiveTransition({ track, elementId: "b" })).toBe(false);
	});

	test("is false for a clip with no transition stored", () => {
		expect(
			hasActiveTransition({ track: buildAdjacentPair(), elementId: "b" }),
		).toBe(false);
	});
});

describe("stripTransitionIn", () => {
	test("drops the transition so a split tail does not inherit it", () => {
		const element = buildVideoElement({ transitionIn: buildTransition() });

		expect(stripTransitionIn({ element })).not.toHaveProperty("transitionIn");
	});

	test("returns an element without a transition untouched", () => {
		const element = buildVideoElement();

		expect(stripTransitionIn({ element })).toBe(element);
	});
});

describe("resolveTransitionFrame", () => {
	const width = 1920;
	const height = 1080;

	function bindingFor({ track }: { track: VideoTrack }) {
		return getTransitionBindingsForElement({
			placements: findTransitions({ track }),
			elementId: "b",
		})[0];
	}

	function frameAt({ time }: { time: number }) {
		return resolveTransitionFrame({
			binding: bindingFor({ track: buildTransitionPair() }),
			time: seconds({ value: time }),
			width,
			height,
		});
	}

	test("holds the outgoing clip at full opacity through a fade", () => {
		expect(frameAt({ time: 9.5 }).outgoing.opacity).toBe(1);
		expect(frameAt({ time: 10.5 }).outgoing.opacity).toBe(1);
	});

	test("brings the incoming clip up across the window", () => {
		expect(frameAt({ time: 9.5 }).incoming.opacity).toBeCloseTo(0, 2);
		expect(frameAt({ time: 10 }).incoming.opacity).toBeCloseTo(0.5, 2);
		expect(frameAt({ time: 10.5 }).incoming.opacity).toBeCloseTo(1, 2);
	});

	/**
	 * "Flash white" hides the incoming clip for the first half of the window,
	 * which is exactly when the wash ramps up. The renderer therefore cannot drop
	 * a hidden side without also dropping the flash it carries.
	 */
	test("ramps the flash wash while the incoming clip is still hidden", () => {
		const frame = resolveTransitionFrame({
			binding: bindingFor({
				track: buildTransitionPair({
					transition: buildTransition({ type: "flash-white" }),
				}),
			}),
			time: seconds({ value: 9.75 }),
			width,
			height,
		});

		expect(frame.incoming.opacity).toBe(0);
		expect(frame.overlay?.color).toBe("#ffffff");
		expect(frame.overlay?.opacity).toBeGreaterThan(0);
	});

	test("masks only the incoming clip during a wipe", () => {
		const frame = resolveTransitionFrame({
			binding: bindingFor({
				track: buildTransitionPair({
					transition: buildTransition({ type: "wipe-right" }),
				}),
			}),
			time: seconds({ value: 9.5 }),
			width,
			height,
		});

		// Masking the outgoing clip would reveal the background, not the other clip:
		// the incoming clip composites on top, so the hole has to be punched in it.
		expect(frame.outgoing.shape).toBeNull();
		expect(frame.incoming.shape).toMatchObject({
			kind: "linear",
			angleDegrees: 0,
		});
	});

	test("falls back to untouched sides for an unregistered type", () => {
		const frame = resolveTransitionFrame({
			binding: bindingFor({
				track: buildTransitionPair({
					transition: buildTransition({ type: "does-not-exist" }),
				}),
			}),
			time: seconds({ value: 9.5 }),
			width,
			height,
		});

		expect(frame.incoming.opacity).toBe(1);
		expect(frame.outgoing.opacity).toBe(1);
		expect(frame.incoming.shape).toBeNull();
	});
});
