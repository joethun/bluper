import type { MediaType } from "@/media/types";
import type {
	TProject,
	TProjectMetadata,
	TTimelineViewState,
} from "@/project/types";
import type { TScene } from "@/timeline";

export interface StorageAdapter<T> {
	get(key: string): Promise<T | null>;
	set(args: { key: string; value: T }): Promise<void>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

/**
 * A stored media file. There is one shape because there is one place media
 * lives: a real file on the real filesystem. It is read through `url` (Tauri's
 * `asset:` protocol, which serves range requests) rather than as a `File`,
 * because materialising one would mean copying every byte through IPC into the
 * page.
 *
 * `kind` is kept as a discriminant even with a single member so that a caller
 * holding one still has to say which shape it expects.
 */
export type StoredMedia = {
	kind: "path";
	path: string;
	url: string;
	size: number;
};

/**
 * Where a project's media bytes live — the app's data directory, one folder per
 * project. Metadata (name, dimensions, duration) lives in IndexedDB alongside
 * this and is small enough not to care.
 */
export interface MediaStore {
	/** Writes a file, replacing anything already stored under `key`. */
	put(args: { key: string; file: File }): Promise<void>;
	/**
	 * Takes over a file already on disk, moving it under `key`. Used for media
	 * the probe had to write out anyway, so its bytes cross the disk once
	 * instead of twice; `from` no longer exists afterwards.
	 */
	adopt(args: { key: string; from: string }): Promise<void>;
	/** Describes the stored file, or null when there isn't one. */
	resolve(args: { key: string }): Promise<StoredMedia | null>;
	remove(key: string): Promise<void>;
	list(): Promise<string[]>;
	clear(): Promise<void>;
}

export interface MediaAssetData {
	id: string;
	name: string;
	type: MediaType;
	size: number;
	lastModified: number;
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	ephemeral?: boolean;
	thumbnailUrl?: string;
	/**
	 * Set for media imported by reference: the user's own path, which is the
	 * only copy there is. Absent for media the store holds bytes for, which is
	 * anything that arrived as bytes with no path behind it.
	 */
	sourcePath?: string;
}

export type SerializedScene = Omit<TScene, "createdAt" | "updatedAt"> & {
	createdAt: string;
	updatedAt: string;
};

type SerializedProjectMetadata = Omit<
	TProjectMetadata,
	"createdAt" | "updatedAt"
> & {
	createdAt: string;
	updatedAt: string;
};

export type SerializedProject = Omit<TProject, "metadata" | "scenes"> & {
	metadata: SerializedProjectMetadata;
	scenes: SerializedScene[];
	timelineViewState?: TTimelineViewState;
};

export interface StorageConfig {
	projectsDb: string;
	mediaDb: string;
	version: number;
}
