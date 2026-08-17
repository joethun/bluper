/**
 * Streams an export straight onto the filesystem on the desktop build.
 *
 * The encoders write into the returned `WritableStream` and every chunk goes to
 * disk as it is produced, so a two-hour 4K render costs one chunk of memory
 * rather than the size of the finished file. That matters more here than it
 * looks: the browser fallback collects the whole export into a `Blob`, and a
 * `Blob` big enough to hold a long render can no longer be handed to anything
 * that wants a single `ArrayBuffer`.
 *
 * The file is written into the app's cache directory and moved to wherever the
 * user asks for it once the export finishes. Writing it there directly would
 * leave a half-finished video sitting at the destination if the export was
 * cancelled or crashed.
 */

import type { StreamTargetChunk } from "mediabunny";
import {
	TauriWriteStream,
	tauriAvailable,
	tauriRemoveFile,
	tauriScratchPath,
} from "@/lib/tauri-runtime";

export type TauriExportTargetHandle = {
	/** Where the encoders write. Chunks reach the file as they arrive. */
	writableStream: WritableStream<StreamTargetChunk>;
	/** Absolute path of the scratch file holding the export. */
	path: string;
	/** Closes the stream and deletes the scratch file. Idempotent. */
	dispose: () => Promise<void>;
};

export class TauriExportTarget {
	static isSupported(): boolean {
		return tauriAvailable();
	}

	static async create({
		extension,
	}: {
		extension: string;
	}): Promise<TauriExportTargetHandle> {
		if (!TauriExportTarget.isSupported()) {
			throw new Error("The Tauri export target needs the desktop runtime");
		}

		const name = `${crypto.randomUUID()}.${extension}`;
		const path = await tauriScratchPath({ name });
		const stream = await TauriWriteStream.open({ path });

		let disposed = false;
		const dispose = async () => {
			if (disposed) return;
			disposed = true;
			// `abort` closes and deletes in one step when the stream is still
			// open; once it has been closed the file has to be removed by path.
			await stream.abort().catch(() => {});
			await tauriRemoveFile({ path }).catch(() => {});
		};

		const writableStream = new WritableStream<StreamTargetChunk>({
			async write(chunk) {
				// `position` is not optional here the way it is for a plain append:
				// finalising an MP4 seeks back to patch sizes into boxes written
				// much earlier, and dropping it would corrupt the file.
				await stream.write({ bytes: chunk.data, position: chunk.position });
			},
			async close() {
				await stream.close();
			},
			async abort() {
				await dispose();
			},
		});

		return { writableStream, path, dispose };
	}
}
