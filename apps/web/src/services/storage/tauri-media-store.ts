/**
 * Media store backed by the real filesystem, used by the desktop shell.
 *
 * Files live in a per-project directory under the app's data folder. Nothing
 * about a stored file is ever loaded into the page:
 *
 * - Writing streams the `File` to disk in bounded chunks over a binary IPC
 *   body (see `tauri-runtime.ts`), so importing a 10 GB clip costs one chunk
 *   of memory.
 * - Reading hands back a path and an `asset:` URL. The WebView answers range
 *   requests against that URL, so `<video>` playback and Mediabunny's
 *   `UrlSource` pull only the bytes they need.
 *
 * This is why the desktop build has no storage quota: there is no origin
 * sandbox involved, just files on disk.
 */

import {
	TauriWriteStream,
	tauriClearMedia,
	tauriConvertFileSrc,
	tauriListMedia,
	tauriMediaPath,
	tauriMediaSize,
	tauriRemoveMedia,
} from "@/lib/tauri-runtime";
import type { MediaStore, StoredMedia } from "./types";

/**
 * Bytes read out of the source `File` at a time. The source is disk-backed
 * (it came from a file input, a drop, or the clipboard), so slicing it doesn't
 * read anything until the slice is awaited.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

export class TauriMediaStore implements MediaStore {
	private projectId: string;

	constructor({ projectId }: { projectId: string }) {
		this.projectId = projectId;
	}

	async put({ key, file }: { key: string; file: File }): Promise<void> {
		const path = await tauriMediaPath({
			projectId: this.projectId,
			mediaId: key,
		});
		const stream = await TauriWriteStream.open({ path });
		try {
			let offset = 0;
			while (offset < file.size) {
				const end = Math.min(offset + CHUNK_BYTES, file.size);
				const slice = new Uint8Array(
					await file.slice(offset, end).arrayBuffer(),
				);
				await stream.write({ bytes: slice });
				offset = end;
			}
			await stream.close();
		} catch (error) {
			// A half-written media file would load as a corrupt clip later, so
			// remove it rather than leave it behind.
			await stream.abort().catch(() => {});
			throw error;
		}
	}

	async resolve({ key }: { key: string }): Promise<StoredMedia | null> {
		const size = await tauriMediaSize({
			projectId: this.projectId,
			mediaId: key,
		});
		if (size === null) return null;

		const path = await tauriMediaPath({
			projectId: this.projectId,
			mediaId: key,
		});
		return { kind: "path", path, url: tauriConvertFileSrc(path), size };
	}

	async remove(key: string): Promise<void> {
		await tauriRemoveMedia({ projectId: this.projectId, mediaId: key });
	}

	async list(): Promise<string[]> {
		return await tauriListMedia({ projectId: this.projectId });
	}

	async clear(): Promise<void> {
		await tauriClearMedia({ projectId: this.projectId });
	}
}
