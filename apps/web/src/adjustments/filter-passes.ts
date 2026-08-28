import { buildAdjustmentFilterPassesValue as _buildAdjustmentFilterPassesValue } from "bluper-wasm";
import type { EffectPass } from "@/effects/types";

/**
 * Turns an adjustment's CSS filter chain into compositor shader passes. Owned
 * by `editor-core::adjustments::filter_passes` — see that module for why the
 * translation exists at all (WebKitGTK accepts `ctx.filter` and ignores it).
 */

export function buildAdjustmentFilterPasses({
	filter,
}: {
	filter: string;
}): EffectPass[] {
	return _buildAdjustmentFilterPassesValue({ filter }).passes;
}
