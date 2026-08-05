import type { TimelineElement } from "@/timeline/types";

/**
 * Whether a preview patch changes anything the overlay is already holding.
 *
 * A key the overlay has not seen yet always counts as a change. Comparing such a
 * key against the missing entry instead would read as "no change" whenever the
 * patch clears a field to `undefined` — and since committing bails on an empty
 * overlay, clearing a field would silently do nothing at all.
 */
export function hasPreviewOverlayChange({
	existingOverlay,
	updates,
}: {
	existingOverlay: Partial<TimelineElement> | undefined;
	updates: Partial<TimelineElement>;
}): boolean {
	const patched = Object.entries(updates);
	if (!existingOverlay) {
		return patched.length > 0;
	}

	// Entries rather than indexing: a key explicitly set to `undefined` is still
	// an own key, so this distinguishes "held as undefined" from "never patched".
	const held = new Map<string, unknown>(Object.entries(existingOverlay));
	return patched.some(([key, value]) => {
		if (!held.has(key)) {
			return true;
		}
		return !Object.is(held.get(key), value);
	});
}
