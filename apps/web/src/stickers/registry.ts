import type { StickerProvider } from "@/stickers/types";
import { DefinitionRegistry } from "@/params/registry";

class StickersRegistry extends DefinitionRegistry<string, StickerProvider> {
	constructor() {
		super("sticker provider");
	}
}

export const stickersRegistry = new StickersRegistry();
