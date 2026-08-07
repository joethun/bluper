import { describe, expect, test } from "bun:test";
import {
	hasPreviewOverlayChange,
	mergePreviewOverlay,
} from "@/timeline/preview-overlay";
import type { TextElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

describe("hasPreviewOverlayChange", () => {
	test("reports a change the first time a key is patched", () => {
		expect(
			hasPreviewOverlayChange({
				existingOverlay: undefined,
				updates: { duration: mediaTime({ ticks: 5 }) },
			}),
		).toBe(true);
	});

	/**
	 * Clearing a field is what a reset does. Treating it as "no change" left the
	 * overlay empty, and committing an empty overlay does nothing — so a reset
	 * button appeared to be dead.
	 */
	test("reports a change when a patch clears a field to undefined", () => {
		expect(
			hasPreviewOverlayChange({
				existingOverlay: undefined,
				updates: { fade: undefined },
			}),
		).toBe(true);
	});

	test("reports a change when a held value is cleared", () => {
		expect(
			hasPreviewOverlayChange({
				existingOverlay: { fade: { in: mediaTime({ ticks: 5 }) } },
				updates: { fade: undefined },
			}),
		).toBe(true);
	});

	test("stays quiet when the patch repeats what the overlay holds", () => {
		const fade = { in: mediaTime({ ticks: 5 }) };

		expect(
			hasPreviewOverlayChange({
				existingOverlay: { fade },
				updates: { fade },
			}),
		).toBe(false);
	});

	test("stays quiet when a cleared field is cleared again", () => {
		expect(
			hasPreviewOverlayChange({
				existingOverlay: { fade: undefined },
				updates: { fade: undefined },
			}),
		).toBe(false);
	});

	test("reports a change when any one key of several differs", () => {
		expect(
			hasPreviewOverlayChange({
				existingOverlay: { fade: undefined, name: "same" },
				updates: { fade: undefined, name: "different" },
			}),
		).toBe(true);
	});
});

function seconds({ value }: { value: number }) {
	return mediaTime({ ticks: Math.round(value * TICKS_PER_SECOND) });
}

function buildTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "title",
		type: "text",
		name: "Title",
		startTime: ZERO_MEDIA_TIME,
		duration: seconds({ value: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			content: "Hello",
			fontSize: 96,
			color: "#ff0000",
			fontFamily: "Inter",
			opacity: 1,
		},
		...overrides,
	};
}

describe("mergePreviewOverlay", () => {
	test("replaces plain fields wholesale", () => {
		const merged = mergePreviewOverlay({
			base: buildTextElement(),
			overlay: { duration: seconds({ value: 2 }) },
		});

		expect(merged.duration).toBe(seconds({ value: 2 }));
	});

	/**
	 * A patch names the one param being dragged and means nothing by the ones it
	 * omits. Replacing the whole bag wiped the clip's font, colour and background
	 * the moment a text edit was committed.
	 */
	test("keeps the params a patch does not mention", () => {
		const merged = mergePreviewOverlay({
			base: buildTextElement(),
			overlay: { params: { content: "Goodbye" } },
		});

		expect(merged.params).toEqual({
			content: "Goodbye",
			fontSize: 96,
			color: "#ff0000",
			fontFamily: "Inter",
			opacity: 1,
		});
	});

	test("leaves params untouched when the patch carries none", () => {
		const base = buildTextElement();
		const merged = mergePreviewOverlay({
			base,
			overlay: { startTime: seconds({ value: 1 }) },
		});

		expect(merged.params).toEqual(base.params);
	});

	test("does not mutate the element it merges onto", () => {
		const base = buildTextElement();
		mergePreviewOverlay({ base, overlay: { params: { content: "Goodbye" } } });

		expect(base.params.content).toBe("Hello");
	});
});
