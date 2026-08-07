import { describe, expect, mock, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks, VideoElement } from "@/timeline";
import {
	buildTransitionInstance,
	registerDefaultTransitions,
	transitionsRegistry,
} from "@/transitions";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

interface FrameRequest {
	sinkKey: string;
	time: number;
}

const requests: FrameRequest[] = [];

/**
 * Stands in for the decoder cache, reproducing the part that matters here: one
 * decode position per `sinkKey`, where a newer request supersedes an older one
 * and hands back whatever frame that position last produced.
 */
const generations = new Map<string, number>();
const held = new Map<string, number>();

await mock.module("@/services/video-cache/service", () => ({
	videoCache: {
		getSampleAt: async ({
			mediaId,
			sinkKey = mediaId,
			time,
		}: {
			mediaId: string;
			sinkKey?: string;
			time: number;
		}) => {
			requests.push({ sinkKey, time });
			const mine = (generations.get(sinkKey) ?? 0) + 1;
			generations.set(sinkKey, mine);
			await Promise.resolve();

			if (generations.get(sinkKey) !== mine) {
				const stale = held.get(sinkKey);
				return stale === undefined
					? {
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WebCodecs shim
							toVideoFrame: () => ({ ts: stale }) as unknown as VideoFrame,
							displayWidth: 1920,
							displayHeight: 1080,
							timestamp: stale,
							duration: 1 / 30,
						}
					: null;
			}
			held.set(sinkKey, time);
			return {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- WebCodecs shim
				toVideoFrame: () => ({ ts: time }) as unknown as VideoFrame,
				displayWidth: 1920,
				displayHeight: 1080,
				timestamp: time,
				duration: 1 / 30,
			};
		},
	},
}));

const { buildScene } = await import("@/services/renderer/scene-builder");
const { resolveRenderTree } = await import("@/services/renderer/resolve");
const { VideoNode } = await import("@/services/renderer/nodes/video-node");

if (!transitionsRegistry.has("dissolve")) {
	registerDefaultTransitions();
}

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function buildAsset({ id }: { id: string }): MediaAsset {
	return {
		id,
		name: id,
		type: "video",
		file: new File([new Uint8Array([0])], `${id}.mp4`, { type: "video/mp4" }),
		url: `blob:${id}`,
		width: 1920,
		height: 1080,
	};
}

function buildVideoElement(
	overrides: Partial<VideoElement> & { id: string; mediaId: string },
): VideoElement {
	return {
		type: "video",
		name: overrides.id,
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { opacity: 1, volume: 1 },
		...overrides,
	};
}

function buildTracks({ elements }: { elements: VideoElement[] }): SceneTracks {
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

function transition({ durationSeconds }: { durationSeconds: number }) {
	return {
		...buildTransitionInstance({ transitionType: "dissolve" }),
		duration: seconds({ value: durationSeconds }),
	};
}

/**
 * A 10s clip cut in half at 5s, with a 0.5s cross-fade on the cut. Neither half
 * moves: the window straddles t=5, so each reaches a quarter second into the
 * material its trim is hiding — which for a split is the other half's footage.
 */
function buildSplitScene() {
	return {
		mediaAssets: [buildAsset({ id: "media-1" })],
		tracks: buildTracks({
			elements: [
				buildVideoElement({
					id: "left",
					mediaId: "media-1",
					trimEnd: seconds({ value: 5 }),
				}),
				buildVideoElement({
					id: "right",
					mediaId: "media-1",
					startTime: seconds({ value: 5 }),
					trimStart: seconds({ value: 5 }),
					transitionIn: transition({ durationSeconds: 0.5 }),
				}),
			],
		}),
	};
}

/**
 * Two separate 5s files butted at t=5 with the same cross-fade, each trimmed so
 * both sides have material to spare on the side the transition reaches into.
 */
function buildTwoFileScene() {
	return {
		mediaAssets: [buildAsset({ id: "media-1" }), buildAsset({ id: "media-2" })],
		tracks: buildTracks({
			elements: [
				buildVideoElement({
					id: "left",
					mediaId: "media-1",
					// A second of unused tail for the outgoing side to run into.
					trimEnd: seconds({ value: 1 }),
				}),
				buildVideoElement({
					id: "right",
					mediaId: "media-2",
					startTime: seconds({ value: 5 }),
					// A second of unused head for the incoming side to reach back into.
					trimStart: seconds({ value: 1 }),
					transitionIn: transition({ durationSeconds: 0.5 }),
				}),
			],
		}),
	};
}

function buildVideoNodes({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}) {
	const root = buildScene({
		tracks,
		mediaAssets,
		duration: seconds({ value: 10 }),
		canvasSize: { width: 1920, height: 1080 },
		background: { type: "color", color: "#000000" },
	});
	return {
		root,
		videoNodes: root.children.filter(
			(child): child is InstanceType<typeof VideoNode> =>
				child instanceof VideoNode,
		),
	};
}

async function shownFramesAt({
	scene,
	atSeconds,
}: {
	scene: ReturnType<typeof buildSplitScene>;
	atSeconds: number;
}) {
	const { root, videoNodes } = buildVideoNodes(scene);
	requests.length = 0;
	generations.clear();
	held.clear();

	await resolveRenderTree({
		node: root,
		// Resolving reads only the canvas dimensions off the renderer, so a real
		// one (which would need an OffscreenCanvas) is not required here.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		renderer: { width: 1920, height: 1080 } as never,
		time: seconds({ value: atSeconds }),
	});

	return videoNodes.map((node) => {
		const resolved = node.resolved;
		if (!resolved || !("source" in resolved)) return null;
		// The stub decoder stamps each frame's source time onto the canvas so the
		// test can see which frame a side ended up showing.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return (resolved.source as unknown as { ts?: number }).ts ?? null;
	});
}

/**
 * Between two different files, a transition is only worth anything if both sides
 * keep playing. Holding an edge frame on either half is what made a transition on
 * video read as a stutter with nothing to show for it, so each has to run into the
 * material its trim is hiding.
 */
describe("sampling across a transition between two files", () => {
	test("keeps both sides moving through the window", async () => {
		const scene = buildTwoFileScene();
		const lefts: (number | null)[] = [];
		const rights: (number | null)[] = [];

		// Not the very first instant: a cross-fade starts the incoming clip at zero
		// opacity, and a layer with nothing to show is dropped.
		for (const at of [4.8, 4.9, 5.0, 5.1]) {
			const [left, right] = await shownFramesAt({ scene, atSeconds: at });
			lefts.push(left);
			rights.push(right);
		}

		expect(lefts.every((frame) => frame !== null)).toBe(true);
		expect(rights.every((frame) => frame !== null)).toBe(true);
		for (let index = 1; index < lefts.length; index++) {
			expect(lefts[index - 1]).toBeLessThan(lefts[index] as number);
			expect(rights[index - 1]).toBeLessThan(rights[index] as number);
		}
	});

	/** The outgoing clip runs past its out-point, the incoming one before its in. */
	test("reaches into the material each clip's trim is hiding", async () => {
		const scene = buildTwoFileScene();

		await shownFramesAt({ scene, atSeconds: 5.2 });
		// `left` covers source 0..5 and has a second of tail spare; past the cut it
		// samples beyond 5 rather than pinning itself to its last visible frame.
		expect(
			requests.filter((r) => r.sinkKey === "media-1").some((r) => r.time > 5),
		).toBe(true);

		await shownFramesAt({ scene, atSeconds: 4.8 });
		// `right` starts at source 1; before the cut it reaches back below that.
		expect(
			requests.filter((r) => r.sinkKey === "media-2").some((r) => r.time < 1),
		).toBe(true);
	});

	/** Outside the window only the clip that owns the frame is on screen. */
	test("drops each side once the other clip owns the frame alone", async () => {
		const scene = buildTwoFileScene();

		const [leftBefore, rightBefore] = await shownFramesAt({
			scene,
			atSeconds: 4.6,
		});
		expect(leftBefore).not.toBeNull();
		expect(rightBefore).toBeNull();

		const [leftAfter, rightAfter] = await shownFramesAt({
			scene,
			atSeconds: 5.4,
		});
		expect(leftAfter).toBeNull();
		expect(rightAfter).not.toBeNull();
	});
});

/**
 * The reach stops where the file does. A clip already using every frame it has can
 * only hold its edge frame — there is genuinely nothing further to show — and it
 * must not ask the decoder for a time outside the media.
 */
describe("sampling with no handle left to spend", () => {
	function buildUntrimmedScene() {
		return {
			mediaAssets: [
				buildAsset({ id: "media-1" }),
				buildAsset({ id: "media-2" }),
			],
			tracks: buildTracks({
				elements: [
					buildVideoElement({ id: "left", mediaId: "media-1" }),
					buildVideoElement({
						id: "right",
						mediaId: "media-2",
						startTime: seconds({ value: 5 }),
						transitionIn: transition({ durationSeconds: 0.5 }),
					}),
				],
			}),
		};
	}

	test("never samples outside the source", async () => {
		const scene = buildUntrimmedScene();

		for (const at of [4.8, 5.0, 5.2]) {
			await shownFramesAt({ scene, atSeconds: at });
			expect(requests.every((r) => r.time >= 0)).toBe(true);
			// Both clips use source 0..5 whole, so nothing may be asked for past it.
			expect(requests.every((r) => r.time <= 5)).toBe(true);
		}
	});

	test("still shows both sides so the blend has something to mix", async () => {
		const scene = buildUntrimmedScene();
		const [left, right] = await shownFramesAt({ scene, atSeconds: 5.1 });

		expect(left).not.toBeNull();
		expect(right).not.toBeNull();
	});
});

/**
 * Two clips reading one file need two decode positions, because a single decoder
 * can only be in one place and the later request would supersede the earlier.
 */
describe("decoder assignment across a transition", () => {
	test("gives the incoming side its own decoder when both sides share a file", () => {
		const { videoNodes } = buildVideoNodes(buildSplitScene());
		const [left, right] = videoNodes;

		// The outgoing side keeps the shared decoder, so an ordinary timeline never
		// pays for a second one.
		expect(left.params.sinkKey).toBeUndefined();
		expect(right.params.sinkKey).toBe("media-1:right");
	});

	test("leaves both sides sharing per-asset decoders for different files", () => {
		const { videoNodes } = buildVideoNodes({
			mediaAssets: [
				buildAsset({ id: "media-1" }),
				buildAsset({ id: "media-2" }),
			],
			tracks: buildTracks({
				elements: [
					buildVideoElement({ id: "left", mediaId: "media-1" }),
					buildVideoElement({
						id: "right",
						mediaId: "media-2",
						startTime: seconds({ value: 4.5 }),
						transitionIn: transition({ durationSeconds: 0.5 }),
					}),
				],
			}),
		});

		expect(videoNodes.every((node) => node.params.sinkKey === undefined)).toBe(
			true,
		);
	});

	test("leaves a split alone until a transition spans the cut", () => {
		const { videoNodes } = buildVideoNodes({
			mediaAssets: [buildAsset({ id: "media-1" })],
			tracks: buildTracks({
				elements: [
					buildVideoElement({ id: "left", mediaId: "media-1" }),
					buildVideoElement({
						id: "right",
						mediaId: "media-1",
						startTime: seconds({ value: 5 }),
						trimStart: seconds({ value: 5 }),
					}),
				],
			}),
		});

		expect(videoNodes.every((node) => node.params.sinkKey === undefined)).toBe(
			true,
		);
	});

	/** A lone clip has no cut, so its stored transition never plays. */
	test("leaves a lone clip on the shared decoder", () => {
		const { videoNodes } = buildVideoNodes({
			mediaAssets: [buildAsset({ id: "media-1" })],
			tracks: buildTracks({
				elements: [
					buildVideoElement({
						id: "only",
						mediaId: "media-1",
						transitionIn: transition({ durationSeconds: 0.5 }),
					}),
				],
			}),
		});

		expect(videoNodes[0].params.sinkKey).toBeUndefined();
	});
});
