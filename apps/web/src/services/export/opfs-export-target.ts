/**
 * Streams an export directly into the Origin Private File System. Encoders
 * write into the returned `WritableStream`; the bytes hit disk in OPFS as
 * they're produced, so total memory use is bounded by the in-flight chunk
 * rather than the full file. The page later asks the export Service Worker
 * to hand the file back to the user as a download.
 *
 * OPFS support is a hard requirement for this class. Callers must check
 * {@link OPFSExportTarget.isSupported} first and fall back to a Blob path
 * otherwise.
 */

import type { StreamTargetChunk } from "mediabunny";

const EXPORT_DIR = "exports";

export type OPFSExportTargetHandle = {
	/**
	 * The file inside OPFS. Medibunny writes its encoded output here through
	 * the stream. The cast bridges mediabunny's `StreamTargetChunk` shape
	 * (`{ type, data, position }`) to `FileSystemWritableFileStream.write()`,
	 * which accepts the same command at runtime even though the
	 * `WritableStream<BufferSource>` base type doesn't say so.
	 */
	writableStream: WritableStream<StreamTargetChunk>;
	/** Identifier handed to the Service Worker when the file is delivered. */
	id: string;
	/** Removes the file from OPFS. Idempotent; safe to call after success. */
	dispose: () => Promise<void>;
};

export class OPFSExportTarget {
	static isSupported(): boolean {
		return (
			typeof navigator !== "undefined" &&
			"storage" in navigator &&
			typeof navigator.storage?.getDirectory === "function"
		);
	}

	static async create(): Promise<OPFSExportTargetHandle> {
		if (!OPFSExportTarget.isSupported()) {
			throw new Error("OPFS is not supported in this browser");
		}

		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
		const id = crypto.randomUUID();
		const fileHandle = await dir.getFileHandle(id, { create: true });
		const fileWritable = await fileHandle.createWritable();

		const dispose = async () => {
			try {
				await fileWritable.close();
			} catch {
				// Already closed.
			}
			try {
				await dir.removeEntry(id);
			} catch {
				// Already removed.
			}
		};

		// The cast bridges mediabunny's `StreamTargetChunk` shape
		// (`{ type, data, position }`) to `FileSystemWritableFileStream.write()`,
		// which accepts the same command at runtime even though the
		// `WritableStream<BufferSource>` base type doesn't say so. There's no
		// sound way to express this in TypeScript — `FileSystemWritableFileStream`
		// is intentionally typed too narrow for what the spec actually allows.
		const writableStream =
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			fileWritable as unknown as WritableStream<StreamTargetChunk>;

		return { writableStream, id, dispose };
	}
}
