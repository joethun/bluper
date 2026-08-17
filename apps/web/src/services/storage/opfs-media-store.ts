/**
 * Media store backed by the Origin Private File System, used by the browser
 * build. OPFS hands back a real `File` whose bytes stay on disk until a slice
 * is read, so media never has to be held in memory — but the whole store still
 * lives under the origin's storage quota, which is what the desktop build
 * exists to escape (see {@link TauriMediaStore}).
 */

import { OPFSAdapter } from "./opfs-adapter";
import type { MediaStore, StoredMedia } from "./types";

export class OpfsMediaStore implements MediaStore {
	private adapter: OPFSAdapter;

	constructor({ directoryName }: { directoryName: string }) {
		this.adapter = new OPFSAdapter(directoryName);
	}

	async put({ key, file }: { key: string; file: File }): Promise<void> {
		await this.adapter.set({ key, value: file });
	}

	async resolve({ key }: { key: string }): Promise<StoredMedia | null> {
		const file = await this.adapter.get(key);
		if (!file) return null;
		return { kind: "file", file };
	}

	async remove(key: string): Promise<void> {
		await this.adapter.remove(key);
	}

	async list(): Promise<string[]> {
		return await this.adapter.list();
	}

	async clear(): Promise<void> {
		await this.adapter.clear();
	}
}
