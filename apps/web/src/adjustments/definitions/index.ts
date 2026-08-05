import { adjustmentsRegistry } from "@/adjustments/registry";
import { basicAdjustment } from "./basic";
import { colorAdjustment } from "./color";
import { lightAdjustment } from "./light";
import { stylizeAdjustment } from "./stylize";

/** The order the Adjustment panel lists them in. */
const DEFAULT_ADJUSTMENTS = [
	basicAdjustment,
	lightAdjustment,
	colorAdjustment,
	stylizeAdjustment,
];

export function registerDefaultAdjustments(): void {
	for (const definition of DEFAULT_ADJUSTMENTS) {
		adjustmentsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
