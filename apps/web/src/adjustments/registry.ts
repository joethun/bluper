import { DefinitionRegistry } from "@/params/registry";
import type { AdjustmentDefinition } from "@/adjustments/types";

class AdjustmentsRegistry extends DefinitionRegistry<
	string,
	AdjustmentDefinition
> {
	constructor() {
		super("adjustment");
	}
}

export const adjustmentsRegistry = new AdjustmentsRegistry();
