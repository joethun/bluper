import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	/**
	 * The imported file, while the editor still holds it: everything the user
	 * just dropped in has one, and so does everything loaded back from OPFS in
	 * the browser build.
	 *
	 * The desktop build has no `File` for assets it loads from disk — see
	 * `path`. Read bytes through {@link createMediaSource} rather than reaching
	 * for `file` directly, so both cases work.
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
