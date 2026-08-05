import { DefinitionRegistry } from "@/params/registry";
import type { TransitionDefinition } from "@/transitions/types";

class TransitionsRegistry extends DefinitionRegistry<
	string,
	TransitionDefinition
> {
	constructor() {
		super("transition");
	}
}

export const transitionsRegistry = new TransitionsRegistry();
