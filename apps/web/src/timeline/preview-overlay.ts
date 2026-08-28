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

/**
 * Lays a preview patch over an element.
 *
 * Every field replaces wholesale except `params`, which merges key by key. A
 * patch names the one param it is dragging — the text being typed, the volume
 * being scrubbed — and means nothing by the ones it leaves out, so replacing the
 * whole bag would silently drop the clip's font, colour and everything else the
 * moment a preview got committed.
 */
export function mergePreviewOverlay<TBase extends Partial<TimelineElement>>({
	base,
	overlay,
}: {
	base: TBase;
	overlay: Partial<TimelineElement>;
}): TBase {
	const merged = { ...base, ...overlay } as TBase;
	if (!overlay.params) {
		return merged;
	}
	return {
		...merged,
		params: { ...base.params, ...overlay.params },
	} as TBase;
}
