import { stickersRegistry } from "./registry";
import { parseStickerId } from "./sticker-id";
import { registerDefaultStickerProviders } from "./providers";
import type { StickerResolveOptions } from "@/stickers/types";

/**
 * A 1x1 transparent GIF, for a sticker whose provider no longer exists.
 *
 * Projects outlive providers: the flags provider was removed, and a project
 * saved while it existed still names it on its elements. The timeline resolves
 * a sticker id during render, so throwing there would take out the whole
 * timeline over one element that can only ever be blank — the element stays,
 * named as the user named it, and draws nothing.
 */
const MISSING_STICKER_URL =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function resolveStickerId({
	stickerId,
	options,
}: {
	stickerId: string;
	options?: StickerResolveOptions;
}): string {
	registerDefaultStickerProviders();

	try {
		const parsedStickerId = parseStickerId({ stickerId });
		if (!stickersRegistry.has(parsedStickerId.providerId)) {
			return MISSING_STICKER_URL;
		}

		return stickersRegistry.get(parsedStickerId.providerId).resolveUrl({
			stickerId,
			options,
		});
	} catch (error) {
		console.warn(`Could not resolve sticker "${stickerId}":`, error);
		return MISSING_STICKER_URL;
	}
}
