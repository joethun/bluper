import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const { buildMoveGroup, resolveGroupMove, resolveGroupMoveSnap } = await import(
	"@/wasm/group-move"
);
const { computeGroupResize } = await import("@/wasm/group-resize");
const { buildTimelineSnapPoints, resolveTimelineSnap } = await import(
	"@/wasm/snapping"
);
type MediaTime = import("@/wasm/media-time").MediaTime;

/**
 * Group moves, group resizes and snapping crossed to Rust together. These are
 * boundary tests rather than logic tests — the logic is covered by the unit tests
 * in `editor-core` — and they exist because a struct that serialises as a map
 * arrives in JavaScript as a `Map`, which reads as an object full of
 * `undefined`. That failure passed 195 Rust tests and 56 TypeScript ones once
 * already, so every new return shape gets checked here.
 */

const TICK = 1;
const SECOND = 120_000;

/**
 * The generated signatures take the untyped element model — Rust flattens it and
 * tsify cannot render that as valid TypeScript — so both a tick count and a
 * scene have to be widened on the way in. Funnelled through one place each.
 */
function ticks(count: number): MediaTime {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return count as MediaTime;
}

function wasmTracks(tracks: unknown): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return tracks as never;
}

function element({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}) {
	return {
		id,
		name: id,
		type: "text" as const,
		duration: ticks(duration),
		startTime: ticks(startTime),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: { text: "hello" },
	};
}

function scene({
	overlayElements,
	mainElements = [],
}: {
	overlayElements: ReturnType<typeof element>[];
	mainElements?: ReturnType<typeof element>[];
}) {
	return {
		overlay: [
			{
				id: "overlay-1",
				name: "Text 1",
				type: "text" as const,
				hidden: false,
				elements: overlayElements,
			},
		],
		main: {
			id: "main-1",
			name: "Main Track",
			type: "video" as const,
			muted: false,
			hidden: false,
			elements: mainElements,
		},
		audio: [],
	};
}

describe("building a move group", () => {
	it("records each member's offset from the anchor", () => {
		const tracks = scene({
			overlayElements: [
				element({ id: "a", startTime: 0, duration: SECOND }),
				element({ id: "b", startTime: 2 * SECOND, duration: SECOND }),
			],
		});

		const group = buildMoveGroup({
			anchorRef: { trackId: "overlay-1", elementId: "a" },
			selectedElements: [{ trackId: "overlay-1", elementId: "b" }],
			tracks: wasmTracks(tracks),
		});

		expect(group).not.toBeNull();
		expect(group).not.toBeInstanceOf(Map);
		expect(group?.members).toHaveLength(2);
		expect(group?.anchor.elementId).toBe("a");
		expect(group?.anchor.timeOffset).toBe(ticks(0));
		expect(group?.members[1].timeOffset).toBe(ticks(2 * SECOND));
		expect(group?.members[1].duration).toBe(ticks(SECOND));
		expect(group?.members[1].trackSection).toBe("overlay");
	});

	it("answers null when the anchor is not on the track it claims", () => {
		const tracks = scene({
			overlayElements: [element({ id: "a", startTime: 0, duration: SECOND })],
		});
		expect(
			buildMoveGroup({
				anchorRef: { trackId: "overlay-1", elementId: "missing" },
				selectedElements: [],
				tracks: wasmTracks(tracks),
			}),
		).toBeNull();
	});
});

describe("resolving a move", () => {
	const tracks = scene({
		overlayElements: [
			element({ id: "a", startTime: 0, duration: SECOND }),
			element({ id: "b", startTime: 2 * SECOND, duration: SECOND }),
		],
	});
	const group = buildMoveGroup({
		anchorRef: { trackId: "overlay-1", elementId: "a" },
		selectedElements: [],
		tracks: wasmTracks(tracks),
	});

	it("plans a move onto the same track", () => {
		const result = resolveGroupMove({
			group: group!,
			tracks: wasmTracks(tracks),
			anchorStartTime: ticks(4 * SECOND),
			target: { kind: "existingTrack", anchorTargetTrackId: "overlay-1" },
		});

		expect(result).not.toBeNull();
		expect(result).not.toBeInstanceOf(Map);
		expect(result?.moves).toEqual([
			{
				sourceTrackId: "overlay-1",
				targetTrackId: "overlay-1",
				elementId: "a",
				newStartTime: ticks(4 * SECOND),
			},
		]);
		expect(result?.createTracks).toEqual([]);
		expect(result?.targetSelection).toEqual([
			{ trackId: "overlay-1", elementId: "a" },
		]);
	});

	it("refuses a move that would land on top of another clip", () => {
		expect(
			resolveGroupMove({
				group: group!,
				tracks: wasmTracks(tracks),
				anchorStartTime: ticks(2 * SECOND),
				target: { kind: "existingTrack", anchorTargetTrackId: "overlay-1" },
			}),
		).toBeNull();
	});

	it("never pushes a member before zero", () => {
		// One member per track: the existing-track resolution gives each member a
		// track of its own, so two clips sharing a track cannot move as a group.
		const twoTracks = {
			overlay: [
				{
					id: "overlay-1",
					name: "Text 1",
					type: "text" as const,
					hidden: false,
					elements: [element({ id: "a", startTime: 0, duration: SECOND })],
				},
				{
					id: "overlay-2",
					name: "Text 2",
					type: "text" as const,
					hidden: false,
					elements: [
						element({ id: "b", startTime: 2 * SECOND, duration: SECOND }),
					],
				},
			],
			main: {
				id: "main-1",
				name: "Main Track",
				type: "video" as const,
				muted: false,
				hidden: false,
				elements: [],
			},
			audio: [],
		};

		const trailingAnchor = buildMoveGroup({
			anchorRef: { trackId: "overlay-2", elementId: "b" },
			selectedElements: [{ trackId: "overlay-1", elementId: "a" }],
			tracks: wasmTracks(twoTracks),
		});
		expect(trailingAnchor?.members).toHaveLength(2);

		const result = resolveGroupMove({
			group: trailingAnchor!,
			tracks: wasmTracks(twoTracks),
			anchorStartTime: ticks(0),
			target: { kind: "existingTrack", anchorTargetTrackId: "overlay-2" },
		});

		// The anchor is two seconds behind the other member, so the earliest the
		// block can start is with that member at zero.
		expect(
			result?.moves.find((move) => move.elementId === "a")?.newStartTime,
		).toBe(ticks(0));
		expect(
			result?.moves.find((move) => move.elementId === "b")?.newStartTime,
		).toBe(ticks(2 * SECOND));
	});

	it("refuses a group whose members share a track, having no second track to give them", () => {
		const sameTrack = buildMoveGroup({
			anchorRef: { trackId: "overlay-1", elementId: "a" },
			selectedElements: [{ trackId: "overlay-1", elementId: "b" }],
			tracks: wasmTracks(tracks),
		});
		expect(
			resolveGroupMove({
				group: sameTrack!,
				tracks: wasmTracks(tracks),
				anchorStartTime: ticks(4 * SECOND),
				target: { kind: "existingTrack", anchorTargetTrackId: "overlay-1" },
			}),
		).toBeNull();
	});

	it("plans the tracks a move onto new tracks needs", () => {
		const result = resolveGroupMove({
			group: group!,
			tracks: wasmTracks(tracks),
			anchorStartTime: ticks(0),
			target: {
				kind: "newTracks",
				anchorInsertIndex: 0,
				newTrackIds: ["new-track-1"],
			},
		});

		expect(result?.createTracks).toEqual([
			{ id: "new-track-1", type: "text", index: 0 },
		]);
	});
});

describe("snapping", () => {
	const tracks = scene({
		overlayElements: [element({ id: "a", startTime: 0, duration: SECOND })],
	});

	it("offers both edges of every element, the playhead, and bookmarks in order", () => {
		const snapPoints = buildTimelineSnapPoints({
			tracks: wasmTracks(tracks),
			playheadTime: ticks(3 * SECOND),
			bookmarks: [{ time: ticks(5 * SECOND) }],
		});

		expect(snapPoints).not.toBeInstanceOf(Map);
		expect(snapPoints.map((point) => point.type)).toEqual([
			"element-start",
			"element-end",
			"playhead",
			"bookmark",
		]);
		expect(snapPoints[1].time).toBe(ticks(SECOND));
		expect(snapPoints[1].elementId).toBe("a");
	});

	it("leaves out the members being dragged", () => {
		const snapPoints = buildTimelineSnapPoints({
			tracks: wasmTracks(tracks),
			excludeElementIds: new Set(["a"]),
		});
		expect(snapPoints).toEqual([]);
	});

	it("takes the nearest candidate, or leaves the time alone", () => {
		const snapPoints = buildTimelineSnapPoints({
			tracks: wasmTracks(tracks),
		});

		const snapped = resolveTimelineSnap({
			targetTime: ticks(SECOND + 10 * TICK),
			snapPoints,
			maxSnapDistance: 100,
		});
		expect(snapped.snappedTime).toBe(ticks(SECOND));
		expect(snapped.snapPoint?.type).toBe("element-end");
		expect(snapped.snapDistance).toBe(10);

		const unsnapped = resolveTimelineSnap({
			targetTime: ticks(50 * SECOND),
			snapPoints,
			maxSnapDistance: 100,
		});
		expect(unsnapped.snappedTime).toBe(ticks(50 * SECOND));
		expect(unsnapped.snapPoint).toBeNull();
		expect(unsnapped.snapDistance).toBe(Infinity);
	});

	it("snaps a group by whichever of its edges is closest", () => {
		const twoTracks = scene({
			overlayElements: [
				element({ id: "a", startTime: 0, duration: SECOND }),
				element({ id: "b", startTime: 2 * SECOND, duration: SECOND }),
			],
			mainElements: [element({ id: "target", startTime: 10 * SECOND, duration: SECOND })],
		});
		const group = buildMoveGroup({
			anchorRef: { trackId: "overlay-1", elementId: "a" },
			selectedElements: [{ trackId: "overlay-1", elementId: "b" }],
			tracks: wasmTracks(twoTracks),
		});
		const snapPoints = buildTimelineSnapPoints({
			tracks: wasmTracks(twoTracks),
			excludeElementIds: new Set(["a", "b"]),
		});

		// The trailing member's start is a few ticks off the main clip's start, so
		// the anchor moves back by the same few ticks.
		const { snappedAnchorStartTime, snapPoint } = resolveGroupMoveSnap({
			group: group!,
			anchorStartTime: ticks(8 * SECOND + 5 * TICK),
			snapPoints,
			zoomLevel: 1,
		});
		expect(snapPoint?.elementId).toBe("target");
		expect(snappedAnchorStartTime).toBe(ticks(8 * SECOND));
	});
});

describe("computing a group resize", () => {
	const member = {
		trackId: "overlay-1",
		elementId: "a",
		startTime: ticks(0),
		duration: ticks(SECOND),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		leftNeighborBound: null,
		rightNeighborBound: null,
	};
	const fps = { numerator: 30, denominator: 1 };

	it("returns a readable patch, not a Map", () => {
		const result = computeGroupResize({
			members: [member],
			side: "right",
			deltaTime: ticks(4_000),
			fps,
		});

		expect(result).not.toBeInstanceOf(Map);
		expect(result.updates[0].patch).not.toBeInstanceOf(Map);
		expect(result.deltaTime).toBe(ticks(4_000));
		expect(result.updates[0].patch).toEqual({
			trimStart: ticks(0),
			trimEnd: ticks(0),
			startTime: ticks(0),
			duration: ticks(SECOND + 4_000),
		});
	});

	it("snaps the delta to a frame", () => {
		const result = computeGroupResize({
			members: [member],
			side: "right",
			deltaTime: ticks(4_100),
			fps,
		});
		expect(result.deltaTime).toBe(ticks(4_000));
	});

	it("stops the whole group at the tightest member's limit", () => {
		const result = computeGroupResize({
			members: [
				member,
				{
					...member,
					elementId: "b",
					startTime: ticks(2 * SECOND),
					rightNeighborBound: ticks(3 * SECOND + 4_000),
				},
			],
			side: "right",
			deltaTime: ticks(SECOND),
			fps,
		});
		expect(result.deltaTime).toBe(ticks(4_000));
	});

	it("resizes nothing for an empty selection", () => {
		const result = computeGroupResize({
			members: [],
			side: "right",
			deltaTime: ticks(4_000),
			fps,
		});
		expect(result.deltaTime).toBe(ticks(0));
		expect(result.updates).toEqual([]);
	});
});
