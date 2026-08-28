import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import {
	describeParityMismatch,
	createRng,
	type Rng,
} from "@/testing/parity";
import type {
	AudioTrack,
	ElementType,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline/types";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

// Imported after the mock, not statically at the top: a top-level `import` is
// hoisted above `mock.module`, so it would load the bundler-target package that
// `bun test` cannot initialise. A full-suite run hides that — some earlier file
// has already installed the process-global mock — so this file would only fail
// when run on its own.
const ported = await import("@/wasm/drop-target");
const { mediaTime, ZERO_MEDIA_TIME } = await import("@/wasm/media-time");

/**
 * Drop-target resolution, moving to `editor-core::timeline::drop_target`.
 *
 * Both sides reach the same Rust placement resolver, so what this pins is the
 * geometry on top of it: which row a pixel offset lands in, what a pointer in
 * the gap between two rows means, and how near a transition drag has to be to a
 * cut before it snaps.
 */

const TICKS_PER_SECOND = 120_000;

/** Every overlay row this generates, so tracks and elements stay pairable. */
const OVERLAY_KINDS = ["video", "text", "graphic", "effect"] as const;

const ELEMENT_TYPES: readonly ElementType[] = [
	"video",
	"image",
	"text",
	"audio",
	"sticker",
	"graphic",
	"effect",
	"adjustment",
];

function baseElement({
	id,
	startTicks,
	durationTicks,
}: {
	id: string;
	startTicks: number;
	durationTicks: number;
}) {
	return {
		id,
		name: id,
		duration: mediaTime({ ticks: durationTicks }),
		startTime: mediaTime({ ticks: startTicks }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function elementOfKind({
	kind,
	id,
	startTicks,
	durationTicks,
}: {
	kind: (typeof OVERLAY_KINDS)[number] | "audio";
	id: string;
	startTicks: number;
	durationTicks: number;
}): TimelineElement {
	const base = baseElement({ id, startTicks, durationTicks });
	switch (kind) {
		case "video":
			return { ...base, type: "video", mediaId: "media" };
		case "text":
			return { ...base, type: "text" };
		case "graphic":
			return { ...base, type: "graphic", definitionId: "definition" };
		case "effect":
			return { ...base, type: "effect", effectType: "blur" };
		case "audio":
			return { ...base, type: "audio", sourceType: "upload", mediaId: "media" };
	}
}

/**
 * Clips laid left to right, most of them abutting. Abutting video clips are
 * what produce transition cuts, so the gaps are deliberately the minority —
 * otherwise the transition half of the run would never find anything to snap
 * to.
 */
function elementsFor({
	rng,
	kind,
	trackId,
}: {
	rng: Rng;
	kind: (typeof OVERLAY_KINDS)[number] | "audio";
	trackId: string;
}): TimelineElement[] {
	const count = rng.int({ min: 0, max: 4 });
	const elements: TimelineElement[] = [];
	let cursor = rng.int({ min: 0, max: TICKS_PER_SECOND });

	for (let index = 0; index < count; index += 1) {
		const durationTicks = rng.int({
			min: TICKS_PER_SECOND / 2,
			max: 2 * TICKS_PER_SECOND,
		});
		elements.push(
			elementOfKind({
				kind,
				id: `${trackId}-e${index}`,
				startTicks: cursor,
				durationTicks,
			}),
		);
		cursor += durationTicks;
		if (rng.float() < 0.3) {
			cursor += rng.int({ min: 1, max: TICKS_PER_SECOND });
		}
	}

	return elements;
}

/**
 * A track union member is narrower than what a generator can build — a video
 * track's `elements` is `(VideoElement | ImageElement)[]`, not
 * `TimelineElement[]` — so every fixture is widened through this one place
 * rather than one cast per construction site.
 */
function asTrack<TTrack extends TimelineTrack>({
	track,
}: {
	track: object;
}): TTrack {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return track as unknown as TTrack;
}

function trackOfKind({
	rng,
	kind,
	id,
}: {
	rng: Rng;
	kind: (typeof OVERLAY_KINDS)[number];
	id: string;
}): TimelineTrack {
	const elements = elementsFor({ rng, kind, trackId: id });
	const base = { id, name: id, type: kind, elements, hidden: false };
	return asTrack({
		track: kind === "video" ? { ...base, muted: rng.bool() } : base,
	});
}

function sceneFor({ rng }: { rng: Rng }): SceneTracks {
	const overlay = Array.from(
		{ length: rng.int({ min: 0, max: 3 }) },
		(_unused, index) =>
			trackOfKind({
				rng,
				kind: rng.pick({ from: OVERLAY_KINDS }),
				id: `overlay-${index}`,
			}),
	);
	const main = asTrack<VideoTrack>({
		track: {
			id: "main",
			name: "main",
			type: "video",
			elements: elementsFor({ rng, kind: "video", trackId: "main" }),
			muted: false,
			hidden: false,
		},
	});
	const audio = Array.from(
		{ length: rng.int({ min: 0, max: 2 }) },
		(_unused, index) => {
			const id = `audio-${index}`;
			return asTrack<AudioTrack>({
				track: {
					id,
					name: id,
					type: "audio",
					elements: elementsFor({ rng, kind: "audio", trackId: id }),
					muted: rng.bool(),
				},
			});
		},
	);

	return {
		overlay: overlay.map((track) => asTrack<SceneTracks["overlay"][number]>({ track })),
		main,
		audio,
	};
}

function orderedTracks({ tracks }: { tracks: SceneTracks }): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function allElementIds({ tracks }: { tracks: SceneTracks }): string[] {
	return orderedTracks({ tracks }).flatMap((track) =>
		track.elements.map((element) => element.id),
	);
}

test("no generated drag breaks the drop-target invariants", () => {
	// A boundary that stopped deserialising would refuse every drag and agree
	// with itself on every refusal, so the run has to prove it found real
	// targets: reused rows, hit-tested clips, and snapped transition cuts.
	let reusedRows = 0;
	let hitElements = 0;
	let snappedCuts = 0;

	const rng = createRng({ seed: 0xd0f7a6 });
	const generate = () => {
			const tracks = sceneFor({ rng });
			const ids = allElementIds({ tracks });
			return {
				tracks,
				elementType: rng.pick({ from: ELEMENT_TYPES }),
				mouseX: rng.range({ min: -60, max: 600 }),
				mouseY: rng.range({ min: -40, max: 320 }),
				// Never zero: a zero scale makes the TypeScript divide by zero
				// and `mediaTime` throw on the infinity that comes back, which
				// says nothing about the port.
				pixelsPerSecond: rng.pick({ from: [50, 100] }),
				zoomLevel: rng.range({ min: 0.25, max: 4 }),
				playheadTicks: rng.int({ min: 0, max: 6 * TICKS_PER_SECOND }),
				isExternalDrop: rng.float() < 0.25,
				durationTicks: rng.int({
					min: TICKS_PER_SECOND / 4,
					max: 3 * TICKS_PER_SECOND,
				}),
				verticalDragDirection: rng.pick({
					from: ["up", "down", null, undefined] as const,
				}),
				startTimeOverrideTicks:
					rng.float() < 0.2 ? rng.int({ min: 0, max: 4 * TICKS_PER_SECOND }) : null,
				excludeElementId:
					ids.length > 0 && rng.float() < 0.35
						? rng.pick({ from: ids })
						: undefined,
				targetElementTypes:
					rng.float() < 0.4
						? [rng.pick({ from: ELEMENT_TYPES }), rng.pick({ from: ELEMENT_TYPES })]
						: undefined,
				sourceTrackId:
					rng.float() < 0.3
						? rng.pick({ from: orderedTracks({ tracks }) }).id
						: undefined,
			};
	};

	for (let iteration = 0; iteration < 1_000; iteration += 1) {
		const input = generate();
		{
			const dropTarget = ported.computeDropTarget({
				elementType: input.elementType,
				mouseX: input.mouseX,
				mouseY: input.mouseY,
				tracks: input.tracks,
				playheadTime: mediaTime({ ticks: input.playheadTicks }),
				isExternalDrop: input.isExternalDrop,
				elementDuration: mediaTime({ ticks: input.durationTicks }),
				pixelsPerSecond: input.pixelsPerSecond,
				zoomLevel: input.zoomLevel,
				verticalDragDirection: input.verticalDragDirection,
				startTimeOverride:
					input.startTimeOverrideTicks === null
						? undefined
						: mediaTime({ ticks: input.startTimeOverrideTicks }),
				excludeElementId: input.excludeElementId,
				targetElementTypes: input.targetElementTypes,
				sourceTrackId: input.sourceTrackId,
			});
			const transition = ported.computeTransitionDropTarget({
				mouseX: input.mouseX,
				mouseY: input.mouseY,
				tracks: input.tracks,
				pixelsPerSecond: input.pixelsPerSecond,
				zoomLevel: input.zoomLevel,
			});

			if (!dropTarget.isNewTrack) reusedRows += 1;
			if (dropTarget.targetElement !== null) hitElements += 1;
			if (transition !== null) snappedCuts += 1;

			const ordered = orderedTracks({ tracks: input.tracks });
			const lineY = ported.getDropLineY({ dropTarget, tracks: ordered });

			// A row index must name a real row or the append slot past the last.
			expect(dropTarget.trackIndex).toBeGreaterThanOrEqual(0);
			expect(dropTarget.trackIndex).toBeLessThanOrEqual(ordered.length);
			// The drop line is a screen offset: finite, never behind the ruler,
			// and `+0` rather than `-0` at the top (Rust's `Sum for f64` folds
			// from `-0.0`, which is how a `-0` shipped here once already).
			expect(Number.isFinite(lineY)).toBe(true);
			expect(Object.is(lineY, -0)).toBe(false);
			expect(lineY).toBeGreaterThanOrEqual(0);
			// A hit-tested clip has to be one that is actually on the timeline.
			// It may well be the one named by `excludeElementId`: that argument
			// frees the dragged clip's own span from the *occupancy* check so it
			// does not collide with itself, which is a different question from
			// what sits under the cursor.
			if (dropTarget.targetElement !== null) {
				expect(allElementIds({ tracks: input.tracks })).toContain(
					dropTarget.targetElement.elementId,
				);
			}
			// A transition only exists at a seam between two clips.
			if (transition !== null) {
				expect(Number.isFinite(Number(transition.seamTime))).toBe(true);
			}
		}
	}

	expect(reusedRows).toBeGreaterThan(0);
	expect(hitElements).toBeGreaterThan(0);
	expect(snappedCuts).toBeGreaterThan(0);
});
