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
	 * Where the media lives on the real filesystem. Its presence is what marks
	 * an asset as read through `url` instead of through `file`.
	 *
	 * For a referenced asset this is the user's own file; for a copied one it
	 * is the app's copy in the project media folder. Nothing downstream needs
	 * to tell them apart — both are a path the decoders can open.
	 */
	path?: string;
	/**
	 * Set when the asset is a reference to the user's own file rather than a
	 * copy of it. Holds the path as it was imported, which is the identity a
	 * relink restores; `path` is the same file resolved for this run, and is
	 * absent while the file cannot be found.
	 */
	sourcePath?: string;
	/**
	 * A referenced file that was not where the project left it. The asset keeps
	 * every piece of metadata it was imported with — duration, dimensions,
	 * thumbnail — so the timeline still lays out correctly and only the pixels
	 * are missing, which is what makes relinking worth offering.
	 */
	missing?: boolean;
	/**
	 * A scratch file already holding this media's bytes, written by the probe.
	 *
	 * Transient, and never persisted: the store moves the file into place and
	 * the field is gone by the time the asset is read back. It exists so that
	 * media which has to be copied is written once rather than twice — a probe
	 * needs the bytes on disk before it can say anything, and those are the same
	 * bytes the store was about to ask for.
	 */
	stagedPath?: string;
	/** Byte size of the media, whether or not a `File` is around to ask. */
	size?: number;
	lastModified?: number;
	url?: string;
}
