import { tauriAvailable } from "@/lib/tauri-runtime";
import type { StorageAdapter } from "./types";

export class OPFSAdapter implements StorageAdapter<File> {
	private directoryName: string;

	constructor(directoryName = "media") {
		this.directoryName = directoryName;
	}

	private async getDirectory(): Promise<FileSystemDirectoryHandle> {
		if (!OPFSAdapter.isSupported()) {
			throw new Error("OPFS is not available in this environment");
		}
		const opfsRoot = await navigator.storage.getDirectory();
		return await opfsRoot.getDirectoryHandle(this.directoryName, {
			create: true,
		});
	}

	async get(key: string): Promise<File | null> {
		try {
			const directory = await this.getDirectory();
			const fileHandle = await directory.getFileHandle(key);
			return await fileHandle.getFile();
		} catch (error) {
			if ((error as Error).name === "NotFoundError") {
				return null;
			}
			throw error;
		}
	}

	async set({
		key,
		value: file,
	}: {
		key: string;
		value: File;
	}): Promise<void> {
		const directory = await this.getDirectory();
		const fileHandle = await directory.getFileHandle(key, { create: true });
		const writable = await fileHandle.createWritable();

		await writable.write(file);
		await writable.close();
	}

	async remove(key: string): Promise<void> {
		try {
			const directory = await this.getDirectory();
			await directory.removeEntry(key);
		} catch (error) {
			if ((error as Error).name !== "NotFoundError") {
				throw error;
			}
		}
	}

	async list(): Promise<string[]> {
		const directory = await this.getDirectory();
		const keys: string[] = [];

		for await (const name of directory.keys()) {
			keys.push(name);
		}

		return keys;
	}

	async clear(): Promise<void> {
		const directory = await this.getDirectory();

		for await (const name of directory.keys()) {
			await directory.removeEntry(name);
		}
	}

	// Helper method to check OPFS support. Always false in the Tauri runtime,
	// on every platform: media belongs on the real filesystem there, so the
	// storage service routes through TauriFsAdapter instead. WebKitGTK forced
	// the issue by shipping OPFS broken or not at all, but the answer doesn't
	// change on WebView2, where OPFS works and is still the wrong home for a
	// multi-gigabyte clip — it would put the bytes back under a sandbox quota.
	static isSupported(): boolean {
		if (tauriAvailable()) return false;
		return (
			typeof navigator !== "undefined" &&
			"storage" in navigator &&
			typeof navigator.storage?.getDirectory === "function"
		);
	}
}
