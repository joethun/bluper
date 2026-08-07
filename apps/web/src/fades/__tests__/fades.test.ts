import { describe, expect, test } from "bun:test";
import {
	getMaxFadeDuration,
	hasActiveFade,
	resolveFadeOpacity,
	withFadeEdge,
} from "@/fades";
import type { TextElement, VideoElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function buildElement(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "clip",
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

const duration = seconds({ value: 10 });

describe("resolveFadeOpacity", () => {
	test("leaves a clip alone with no fade set", () => {
		expect(
			resolveFadeOpacity({ fade: undefined, clipTime: 0, duration }),
		).toBe(1);
	});

	test("ramps up over the head and stays put afterwards", () => {
		const fade = { in: seconds({ value: 2 }) };

		expect(resolveFadeOpacity({ fade, clipTime: 0, duration })).toBe(0);
		expect(
			resolveFadeOpacity({
				fade,
				clipTime: seconds({ value: 1 }),
				duration,
			}),
		).toBeCloseTo(0.5, 2);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 2 }), duration }),
		).toBe(1);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 8 }), duration }),
		).toBe(1);
	});

	test("ramps down over the tail", () => {
		const fade = { out: seconds({ value: 2 }) };

		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 7 }), duration }),
		).toBe(1);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 9 }), duration }),
		).toBeCloseTo(0.5, 2);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 10 }), duration }),
		).toBe(0);
	});

	/** Both ramps on one clip have to share it, or neither would reach full. */
	test("meets in the middle when both ramps would overlap", () => {
		const fade = { in: seconds({ value: 8 }), out: seconds({ value: 8 }) };

		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 5 }), duration }),
		).toBeCloseTo(1, 2);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 2.5 }), duration }),
		).toBeCloseTo(0.5, 2);
		expect(
			resolveFadeOpacity({ fade, clipTime: seconds({ value: 7.5 }), duration }),
		).toBeCloseTo(0.5, 2);
	});

	test("never leaves the 0..1 range", () => {
		const fade = { in: seconds({ value: 2 }), out: seconds({ value: 2 }) };

		for (const at of [-1, 0, 1, 5, 9, 10, 11]) {
			const opacity = resolveFadeOpacity({
				fade,
				clipTime: seconds({ value: at }),
				duration,
			});
			expect(opacity).toBeGreaterThanOrEqual(0);
			expect(opacity).toBeLessThanOrEqual(1);
		}
	});
});

describe("getMaxFadeDuration", () => {
	test("offers the whole clip when only one edge fades", () => {
		expect(
			getMaxFadeDuration({ element: buildElement(), edge: "in" }),
		).toBe(duration);
	});

	test("offers half the clip when the other edge already fades", () => {
		expect(
			getMaxFadeDuration({
				element: buildElement({ fade: { out: seconds({ value: 1 }) } }),
				edge: "in",
			}),
		).toBe(seconds({ value: 5 }));
	});
});

describe("withFadeEdge", () => {
	test("sets one edge without disturbing the other", () => {
		expect(
			withFadeEdge({
				fade: { out: seconds({ value: 1 }) },
				edge: "in",
				duration: seconds({ value: 2 }),
			}),
		).toEqual({ in: seconds({ value: 2 }), out: seconds({ value: 1 }) });
	});

	test("drops the config once neither edge ramps", () => {
		expect(
			withFadeEdge({
				fade: { in: seconds({ value: 2 }) },
				edge: "in",
				duration: ZERO_MEDIA_TIME,
			}),
		).toBeUndefined();
	});

	test("keeps the surviving edge when the other is cleared", () => {
		expect(
			withFadeEdge({
				fade: { in: seconds({ value: 2 }), out: seconds({ value: 3 }) },
				edge: "in",
				duration: ZERO_MEDIA_TIME,
			}),
		).toEqual({ out: seconds({ value: 3 }) });
	});
});

describe("hasActiveFade", () => {
	test("is false without a fade, or with zero-length ramps", () => {
		expect(hasActiveFade({ element: buildElement() })).toBe(false);
		expect(
			hasActiveFade({
				element: buildElement({ fade: { in: ZERO_MEDIA_TIME } }),
			}),
		).toBe(false);
	});

	test("is true once either edge ramps", () => {
		expect(
			hasActiveFade({
				element: buildElement({ fade: { out: seconds({ value: 1 }) } }),
			}),
		).toBe(true);
	});

	test("reads a fade off a text clip", () => {
		const element: TextElement = {
			id: "title",
			type: "text",
			name: "Title",
			startTime: ZERO_MEDIA_TIME,
			duration,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			params: { content: "Hello", opacity: 1 },
			fade: { in: seconds({ value: 1 }) },
		};

		expect(hasActiveFade({ element })).toBe(true);
		expect(getMaxFadeDuration({ element, edge: "out" })).toBe(
			seconds({ value: 5 }),
		);
	});
});
