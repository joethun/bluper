import { buildDefaultParamValues } from "@/params/registry";
import { generateUUID } from "@/utils/id";
import { adjustmentsRegistry } from "./registry";
import type {
	Adjustment,
	AdjustmentDefinition,
	AdjustmentOverlay,
	ResolvedAdjustments,
} from "./types";

export { registerDefaultAdjustments } from "./definitions";
export { hashResolvedAdjustments, paintAdjustedLayer } from "./paint";
export type * from "./types";

export function getAdjustmentDefinition({
	adjustmentType,
}: {
	adjustmentType: string;
}): AdjustmentDefinition {
	return adjustmentsRegistry.get(adjustmentType);
}

export function buildAdjustmentInstance({
	adjustmentType,
}: {
	adjustmentType: string;
}): Adjustment {
	const definition = getAdjustmentDefinition({ adjustmentType });

	return {
		id: generateUUID(),
		type: adjustmentType,
		params: buildDefaultParamValues(definition.params),
		enabled: true,
	};
}

/**
 * Folds a stack (or several stacked adjustment layers) into one CSS filter chain
 * plus the passes that a filter cannot express. Returns `null` when nothing in
 * the stack does anything, so the renderer can keep uploading raw frames.
 */
export function resolveAdjustmentStacks({
	stacks,
}: {
	stacks: Adjustment[][];
}): ResolvedAdjustments | null {
	const filters: string[] = [];
	const overlays: AdjustmentOverlay[] = [];

	for (const stack of stacks) {
		for (const adjustment of stack) {
			if (!adjustment.enabled) {
				continue;
			}
			if (!adjustmentsRegistry.has(adjustment.type)) {
				continue;
			}

			const contribution = adjustmentsRegistry
				.get(adjustment.type)
				.resolve({ params: adjustment.params });
			filters.push(...contribution.filters);
			overlays.push(...contribution.overlays);
		}
	}

	if (filters.length === 0 && overlays.length === 0) {
		return null;
	}

	return { filter: filters.join(" "), overlays };
}
