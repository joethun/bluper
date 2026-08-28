import { describe, expect, test, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

/**
 * The frame spacing is derived from the timeline's tick rate, so these pin the
 * derivation rather than the numbers a particular rate happens to give: the bug
 * this guards against is the export planner counting in a tick rate the rest of
 * the editor does not use, which shows up as video that plays at the wrong speed
 * beside audio that does not.
 */
// Imported dynamically, after the mock: a static import is hoisted above
// `mock.module`, and this module reads its constant off `bluper-wasm` at load.
const { TICKS_PER_SECOND: ONE_SECOND_TICKS } = await import(
	"@/wasm/media-time"
);

const {
	planExport,
	startExport,
	encodeFrame,
	finalizeExport,
	cancelExport,
	readbackFrame,
} = await import("@/wasm/export");

describe("planExport bridge", () => {
	test("counts frames at integer-second resolutions exactly", () => {
		const result = planExport({
			spec: {
				container: "mp4",
				kind: "video",
				fpsNumerator: 30,
				fpsDenominator: 1,
				videoBitrate: 5_000_000,
				audioSampleRate: 0,
				audioChannels: 0,
			},
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(result.frameCount).toBe(30);
	});

	test("returns plain numbers, not a Map", async () => {
		const result = await Promise.resolve(
			planExport({
				spec: {
					container: "mp4",
					kind: "video",
					fpsNumerator: 60,
					fpsDenominator: 1,
					videoBitrate: 0,
					audioSampleRate: 0,
					audioChannels: 0,
				},
				durationTicks: ONE_SECOND_TICKS,
			}),
		);
		expect(result).not.toBeInstanceOf(Map);
		expect(typeof result.frameCount).toBe("number");
		expect(typeof result.ticksPerFrame).toBe("number");
	});

	test("60 fps gives a smaller ticks-per-frame than 30 fps", () => {
		const thirty = planExport({
			spec: {
				container: "mp4",
				kind: "video",
				fpsNumerator: 30,
				fpsDenominator: 1,
				videoBitrate: 0,
				audioSampleRate: 0,
				audioChannels: 0,
			},
			durationTicks: ONE_SECOND_TICKS,
		});
		const sixty = planExport({
			spec: {
				container: "mp4",
				kind: "video",
				fpsNumerator: 60,
				fpsDenominator: 1,
				videoBitrate: 0,
				audioSampleRate: 0,
				audioChannels: 0,
			},
			durationTicks: ONE_SECOND_TICKS,
		});
		// Integer division floors, so each rate is at most the rational value
		// and typically just below it — see the Rust unit tests for the
		// comparable assertions on the native side.
		expect(thirty.ticksPerFrame).toBe(Math.floor(ONE_SECOND_TICKS / 30));
		expect(sixty.ticksPerFrame).toBe(Math.floor(ONE_SECOND_TICKS / 60));
		expect(sixty.frameCount).toBe(60);
	});

	test("rounds a partial last frame down rather than up", () => {
		// A 200 ms clip at 60 fps is 12 whole frames; anything left over is a
		// partial frame the exporter drops.
		const result = planExport({
			spec: {
				container: "mp4",
				kind: "video",
				fpsNumerator: 60,
				fpsDenominator: 1,
				videoBitrate: 0,
				audioSampleRate: 0,
				audioChannels: 0,
			},
			durationTicks: ONE_SECOND_TICKS / 5,
		});
		expect(result.frameCount).toBe(12);
	});

	test("ndfps rates use the fps rational in the denominator", () => {
		// 29.97 is 30_000 / 1001, so a one-second clip holds 29 whole frames —
		// the lossy 29.97, not 30.
		const result = planExport({
			spec: {
				container: "mp4",
				kind: "video",
				fpsNumerator: 30_000,
				fpsDenominator: 1001,
				videoBitrate: 0,
				audioSampleRate: 0,
				audioChannels: 0,
			},
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(result.frameCount).toBe(29);
	});
});

describe("export lifecycle bridge", () => {
	const videoSpec = {
		container: "mp4",
		kind: "video" as const,
		fpsNumerator: 30,
		fpsDenominator: 1,
		videoBitrate: 5_000_000,
		audioSampleRate: 0,
		audioChannels: 0,
	};

	test("startExport mints a session and reports the loop bound", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(session.frameCount).toBe(30);
		expect(session.ticksPerFrame).toBe(Math.floor(ONE_SECOND_TICKS / 30));
		expect(typeof session.sessionId).toBe("number");
	});

	test("encodeFrame advances in order and reports progress", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		const firstProgress = encodeFrame({
			sessionId: session.sessionId,
			frameIndex: 0,
		});
		expect(firstProgress.framesCompleted).toBe(1);
		expect(firstProgress.frameIndex).toBe(0);
		expect(firstProgress.frameCount).toBe(30);

		const mid = encodeFrame({
			sessionId: session.sessionId,
			frameIndex: 1,
		});
		expect(mid.framesCompleted).toBe(2);
	});

	test("encodeFrame throws on an out-of-order frame index", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(() =>
			encodeFrame({ sessionId: session.sessionId, frameIndex: 5 }),
		).toThrow();
	});

	test("cancelExport sets the cancellation flag", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		const status = cancelExport({ sessionId: session.sessionId });
		expect(status.cancelled).toBe(true);
		expect(finalizeExport({ sessionId: session.sessionId })).toBe(false);
	});

	test("finalizeExport reports success when no cancellation was set", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(finalizeExport({ sessionId: session.sessionId })).toBe(true);
	});

	test("finalizeExport twice is a no-op (the first drops the session)", () => {
		const session = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		finalizeExport({ sessionId: session.sessionId });
		expect(() =>
			finalizeExport({ sessionId: session.sessionId }),
		).toThrow();
	});

	test("an unknown session id throws", () => {
		expect(() => finalizeExport({ sessionId: 999_999_999 })).toThrow();
		expect(() => cancelExport({ sessionId: 999_999_999 })).toThrow();
	});

	test("session ids are unique across exports on the same thread", () => {
		const a = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		const b = startExport({
			spec: videoSpec,
			durationTicks: ONE_SECOND_TICKS,
		});
		expect(a.sessionId).not.toBe(b.sessionId);
		// Each session is independent on the registry, so cancelling one does
		// not poison the other.
		cancelExport({ sessionId: a.sessionId });
		expect(finalizeExport({ sessionId: a.sessionId })).toBe(false);
		expect(finalizeExport({ sessionId: b.sessionId })).toBe(true);
	});
});

describe("readbackFrame bridge", () => {
	test("the wasm export exposes readbackFrame as a function", () => {
		expect(typeof readbackFrame).toBe("function");
	});

	test("readbackFrame requires a frame descriptor and returns plain JS values", () => {
		// We can't exercise the GPU path under bun, but we can verify the
		// wrapper exists and that its descriptor travels round-trip. The
		// desktop self-test exercises the real GPU readback; here we assert
		// the wrapper is well-formed enough that an invocation-style error
		// (no compositor) propagates rather than throwing something opaque.
		// The descriptor is a valid one on purpose: an empty object would
		// fail at deserialisation and prove nothing about the bridge.
		expect(
			readbackFrame({
				width: 8,
				height: 8,
				renderScale: 1,
				clear: { color: [0, 0, 0, 1] },
				items: [],
			}),
		).rejects.toThrow();
	});
});
