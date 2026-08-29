import { buildAdjustmentFilterPassesValue as _buildAdjustmentFilterPassesValue } from "bluper-wasm";
import type { EffectPass } from "@/effects/types";

/**
 * Turns an adjustment's CSS filter chain into compositor shader passes. Owned
 * by `editor-core::adjustments::filter_passes` — see that module for why the
 * translation exists at all (WebKitGTK accepts `ctx.filter` and ignores it).
 */

/**
 * How many distinct filter strings to remember. The translation is a pure
 * function of the string, and the string is what a *value* produces — so a
 * static adjustment asks for the same one every frame, and an animated one
 * walks a range of them. A few hundred covers a scrub over animated
 * adjustments on several layers; past that the oldest entry goes, which costs
 * one call to rebuild.
 */
const CACHE_LIMIT = 256;

const cache = new Map<string, EffectPass[]>();

/**
 * Memoized on the filter string, which is what actually varies.
 *
 * `frame-descriptor` calls this for every adjusted layer on every frame
 * wherever `supportsCanvasFilter()` is false — which is the WebKitGTK path,
 * so on Linux it is every frame of every preview. The translation itself is a
 * parse of a short string, but it is a parse on the far side of the wasm
 * boundary and it hands back a serialised `Vec` of passes, and neither of
 * those is worth paying for a filter that has not changed since the last
 * frame.
 *
 * The returned array is shared between callers. Nothing downstream writes to
 * it — the passes are read into uniforms and dropped — and freezing it here
 * would cost more than it caught.
 */
export function buildAdjustmentFilterPasses({
	filter,
}: {
	filter: string;
}): EffectPass[] {
	const cached = cache.get(filter);
	if (cached) {
		// Re-inserted so the eviction below drops what is genuinely coldest
		// rather than whatever was translated longest ago.
		cache.delete(filter);
		cache.set(filter, cached);
		return cached;
	}

	const passes = _buildAdjustmentFilterPassesValue({ filter }).passes;
	cache.set(filter, passes);
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next();
		if (!oldest.done) {
			cache.delete(oldest.value);
		}
	}
	return passes;
}
