import { describe, expect, it, mock } from "bun:test";
import * as wasmNative from "bluper-wasm-native";

mock.module("bluper-wasm", () => wasmNative);

const {
	NO_CROP,
	getCropPlacement,
	hashCrop,
	readCropFromParams,
	resolveCropRect,
	setCropEdge,
} = await import("@/wasm/crop");
const { getMaxFadeDuration, resolveFadeOpacity, withFadeEdge } = await import(
	"@/wasm/fades"
);
type MediaTime = import("@/wasm/media-time").MediaTime;

/**
 * Cropping and fading crossed to Rust together. The rules are covered by the
 * unit tests in `editor-core::clip`; these check the boundary — that the insets,
 * rects and fade configs arrive as readable objects rather than as `Map`s, and
 * that an absent fade comes back as `undefined` rather than as an empty object.
 */

function ticks(count: number): MediaTime {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return count as MediaTime;
}

function wasmArg(value: unknown): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as never;
}

describe("cropping", () => {
	it("reads the four insets off an element's params", () => {
		const crop = readCropFromParams({
			params: { "crop.left": 0.1, "crop.top": 0.2, other: "ignored" },
		});
		expect(crop).not.toBeInstanceOf(Map);
		expect(crop).toEqual({ left: 0.1, top: 0.2, right: 0, bottom: 0 });
	});

	it("answers no rect when nothing is cropped", () => {
		expect(resolveCropRect({ crop: NO_CROP, width: 100, height: 100 })).toBeNull();
		expect(
			resolveCropRect({ crop: undefined, width: 100, height: 100 }),
		).toBeNull();
		expect(hashCrop({ crop: NO_CROP })).toBe("");
	});

	it("cuts the rect to whole pixels", () => {
		const rect = resolveCropRect({
			crop: { left: 0.1, top: 0.2, right: 0.1, bottom: 0.2 },
			width: 100,
			height: 100,
		});
		expect(rect).not.toBeInstanceOf(Map);
		expect(rect).toEqual({ x: 10, y: 20, width: 80, height: 60 });
	});

	it("stops an edge before it crosses its opposite", () => {
		const next = setCropEdge({
			crop: { left: 0, top: 0, right: 0.5, bottom: 0 },
			edge: "left",
			value: 0.9,
		});
		expect(next.left).toBeCloseTo(0.48, 12);
		expect(next.right).toBe(0.5);
	});

	it("places the kept region inside the layer's own box", () => {
		const cropRect = resolveCropRect({
			crop: { left: 0.5, top: 0, right: 0, bottom: 0 },
			width: 100,
			height: 100,
		});
		const placement = getCropPlacement({ cropRect, width: 100, height: 100 });
		expect(placement).not.toBeInstanceOf(Map);
		expect(placement).toEqual({
			keptFractionX: 0.5,
			keptFractionY: 1,
			centerFractionX: 0.25,
			centerFractionY: 0,
		});
	});

	it("keeps an uncropped clip on its whole box", () => {
		expect(
			getCropPlacement({ cropRect: null, width: 100, height: 100 }),
		).toEqual({
			keptFractionX: 1,
			keptFractionY: 1,
			centerFractionX: 0,
			centerFractionY: 0,
		});
	});

	it("hashes equivalent crops to the same key", () => {
		expect(hashCrop({ crop: { left: 0.6, top: 0, right: 0.6, bottom: 0 } })).toBe(
			hashCrop({ crop: { left: 0.7, top: 0, right: 0.7, bottom: 0 } }),
		);
	});
});

describe("fading", () => {
	it("leaves a clip alone with no fade set", () => {
		expect(
			resolveFadeOpacity({ fade: undefined, clipTime: 0, duration: 1_000 }),
		).toBe(1);
	});

	it("ramps up and back down", () => {
		const fade = { in: ticks(100), out: ticks(100) };
		expect(resolveFadeOpacity({ fade, clipTime: 0, duration: 1_000 })).toBe(0);
		expect(resolveFadeOpacity({ fade, clipTime: 50, duration: 1_000 })).toBe(0.5);
		expect(resolveFadeOpacity({ fade, clipTime: 500, duration: 1_000 })).toBe(1);
		expect(resolveFadeOpacity({ fade, clipTime: 1_000, duration: 1_000 })).toBe(
			0,
		);
	});

	it("holds each ramp to half the clip when both are set", () => {
		const fade = { in: ticks(1_000), out: ticks(1_000) };
		expect(resolveFadeOpacity({ fade, clipTime: 500, duration: 1_000 })).toBe(1);
	});

	it("writes one edge and keeps the other", () => {
		expect(
			withFadeEdge({
				fade: { in: ticks(100) },
				edge: "out",
				duration: ticks(200),
			}),
		).toEqual({ in: ticks(100), out: ticks(200) });
	});

	it("drops the config when the last ramp is zeroed", () => {
		expect(
			withFadeEdge({
				fade: { in: ticks(100) },
				edge: "in",
				duration: ticks(0),
			}),
		).toBeUndefined();
	});

	it("halves the limit for one edge once the other ramps", () => {
		const element = {
			id: "a",
			name: "a",
			type: "video" as const,
			mediaId: "media-1",
			duration: ticks(1_000),
			startTime: ticks(0),
			trimStart: ticks(0),
			trimEnd: ticks(0),
			params: {},
		};
		expect(
			getMaxFadeDuration({ element: wasmArg(element), edge: "in" }),
		).toBe(ticks(1_000));
		expect(
			getMaxFadeDuration({
				element: wasmArg({ ...element, fade: { out: 200 } }),
				edge: "in",
			}),
		).toBe(ticks(500));
	});
});
