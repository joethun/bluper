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
 * A stored media file, described in whichever way lets the editor read it
 * without copying it into memory first.
 *
 * - `file`: OPFS hands back a `File` whose bytes stay on disk until something
 *   reads a slice of them, so the browser build passes it around directly.
 * - `path`: the desktop build has a real file on the real filesystem. It is
 *   read through `url` (Tauri's `asset:` protocol, which serves range
 *   requests) rather than as a `File`, because materialising one would mean
 *   copying every byte through IPC into the page.
 */
export type StoredMedia =
	| { kind: "file"; file: File }
	| { kind: "path"; path: string; url: string; size: number };

/**
 * Where a project's media bytes live. Metadata (name, dimensions, duration)
 * lives in IndexedDB alongside this and is small enough not to care.
 */
export interface MediaStore {
	/** Writes a file, replacing anything already stored under `key`. */
	put(args: { key: string; file: File }): Promise<void>;
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

// TypeScript type augmentation to add async iterator methods to FileSystemDirectoryHandle
// These methods are part of the File System Access API spec but may not be in all type definitions
declare global {
	interface FileSystemDirectoryHandle {
		keys(): AsyncIterableIterator<string>;
		values(): AsyncIterableIterator<FileSystemHandle>;
		entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
	}
}
