import { describe, expect, test } from "bun:test";
import { hasPreviewOverlayChange } from "@/timeline/preview-overlay";
import { mediaTime } from "@/wasm";

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
