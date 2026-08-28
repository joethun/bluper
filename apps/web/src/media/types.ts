import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	/**
	 * The imported file, while the editor still holds it. Everything the user
	 * just dropped in, picked, or pasted has one — that is the only way a
	 * `File` enters the app.
	 *
	 * An asset reloaded from the media store has none: it is on disk and read
	 * through `path` / `url` instead, because materialising a `File` would copy
	 * every byte into the page. Read bytes through {@link createMediaSource}
	 * rather than reaching for `file` directly, so both cases work.
	 */
	file?: File;
	/**
	 * Desktop only: where the media lives on the real filesystem. Its presence
	 * is what marks an asset as read through `url` instead of through `file`.
	 */
	path?: string;
	/** Byte size of the media, whether or not a `File` is around to ask. */
	size?: number;
	lastModified?: number;
	url?: string;
}
