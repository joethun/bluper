import { DefinitionRegistry } from "@/params/registry";
import type { GraphicDefinition } from "./types";

class GraphicsRegistry extends DefinitionRegistry<string, GraphicDefinition> {
	constructor() {
		super("graphic");
	}
}

export const graphicsRegistry = new GraphicsRegistry();
