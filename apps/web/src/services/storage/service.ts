import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { getMediaMimeTypeFromName } from "@/media/file-types";
import { IndexedDBAdapter, deleteDatabase } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import { OpfsMediaStore } from "./opfs-media-store";
import { TauriMediaStore } from "./tauri-media-store";
import { tauriAvailable } from "@/lib/tauri-runtime";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import type {
	MediaAssetData,
	MediaStore,
	StorageConfig,
	SerializedProject,
	SerializedScene,
	StoredMedia,
} from "./types";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

/**
 * The `asset:` protocol types a response by sniffing its first bytes and, when
 * that fails, by its file extension. Media is stored under its id, so an SVG —
 * the one image format with no magic number — arrives as text and an `<img>`
 * refuses to draw it. SVGs are markup and small, so read that one case into a
 * typed blob URL; everything else streams straight off disk.
 */
async function resolveDesktopMediaUrl({
	stored,
	metadata,
}: {
	stored: Extract<StoredMedia, { kind: "path" }>;
	metadata: MediaAssetData;
}): Promise<string> {
	const isSvg =
		metadata.type === "image" && metadata.name.toLowerCase().endsWith(".svg");
	if (!isSvg) return stored.url;

	try {
		const response = await fetch(stored.url);
		const text = await response.text();
		if (!text.trim().startsWith("<svg")) return stored.url;
		return URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
	} catch {
		return stored.url;
	}
}

/**
 * Object URL for media read back out of OPFS.
 *
 * A stored file is keyed by its id, so the `File` handed back carries no
 * extension and, with it, no type — and a typeless blob URL is one the platform
 * decoders have to sniff. They sniff containers with a magic number well enough
 * and SVG not at all, which is why that case was special before; giving the blob
 * the type its original name implies covers every other format the same way, and
 * costs nothing, because blob parts are references rather than copies.
 */
async function resolveStoredMediaUrl({
	file,
	metadata,
}: {
	file: File;
	metadata: MediaAssetData;
}): Promise<string> {
	if (file.type) return URL.createObjectURL(file);

	const mimeType = getMediaMimeTypeFromName({ name: metadata.name });
	if (mimeType) {
		return URL.createObjectURL(
			new File([file], metadata.name, { type: mimeType }),
		);
	}

	// Nothing named it and nothing can sniff it: the one format that matters
	// here is SVG, which is markup, so read it and look.
	if (metadata.type !== "image") return URL.createObjectURL(file);

	try {
		const text = await file.text();
		if (text.trim().startsWith("<svg")) {
			return URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
		}
	} catch {
		// Unreadable here means unreadable later too; let the consumer report it.
	}

	return URL.createObjectURL(file);
}

/**
 * Size and last-modified come from the `File` when there is one. An asset
 * loaded from the desktop media store has no `File`, so they come from the
 * metadata that was recorded when it was first imported.
 */
function buildMediaAssetData({
	mediaAsset,
	file,
}: {
	mediaAsset: MediaAsset;
	file?: File;
}): MediaAssetData {
	return {
		id: mediaAsset.id,
		name: mediaAsset.name,
		type: mediaAsset.type,
		size: file?.size ?? mediaAsset.size ?? 0,
		lastModified: file?.lastModified ?? mediaAsset.lastModified ?? 0,
		width: mediaAsset.width,
		height: mediaAsset.height,
		duration: mediaAsset.duration,
		thumbnailUrl: mediaAsset.thumbnailUrl,
		ephemeral: mediaAsset.ephemeral,
	};
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private config: StorageConfig;
	private cleanupPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});
	}

	private async ensureLegacyCleanup(): Promise<void> {
		if (this.cleanupPromise) {
			await this.cleanupPromise;
			return;
		}

		// Drops the global meta database Opencut used for cross-project
		// version tracking. One-shot per browser: nothing in Bluper reads it,
		// and it is not recreated.
		this.cleanupPromise = deleteDatabase({ dbName: "video-editor-meta" })
			.catch(() => {
				// The DB might not exist; nothing else depends on it.
			})
			.then(() => undefined);
		await this.cleanupPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter: MediaStore = tauriAvailable()
			? new TauriMediaStore({ projectId })
			: new OpfsMediaStore({ directoryName: `media-files-${projectId}` });

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
			timelineViewState: project.timelineViewState,
		};

		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializedProject,
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureLegacyCleanup();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({ scenes }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			},
			scenes,
			currentSceneId: serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureLegacyCleanup();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const file = mediaAsset.file;
		if (!file) {
			// An asset loaded from disk has no `File`: its bytes are already
			// stored and only its metadata can have changed. Unless they aren't —
			// undoing a deletion arrives here with nothing to write, and the
			// bytes were removed when the deletion ran. Saving the metadata alone
			// would leave a project referencing an asset that no longer exists,
			// so refuse instead and let the caller report it.
			const stored = await mediaAssetsAdapter.resolve({ key: mediaAsset.id });
			if (!stored) {
				throw new Error(
					`Cannot save media "${mediaAsset.name}": its file is no longer stored.`,
				);
			}

			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: buildMediaAssetData({ mediaAsset }),
			});
			return;
		}

		const metadata: MediaAssetData = buildMediaAssetData({ mediaAsset, file });

		try {
			await mediaAssetsAdapter.put({ key: mediaAsset.id, file });
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: metadata,
			});
		} catch (error) {
			try {
				await mediaAssetsAdapter.remove(mediaAsset.id);
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: file.size,
				});
			}

			throw error;
		}
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const [stored, metadata] = await Promise.all([
			mediaAssetsAdapter.resolve({ key: id }),
			mediaMetadataAdapter.get(id),
		]);

		if (!stored || !metadata) return null;

		const common = {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			size: metadata.size,
			lastModified: metadata.lastModified,
		};

		if (stored.kind === "path") {
			return {
				...common,
				size: stored.size,
				path: stored.path,
				url: await resolveDesktopMediaUrl({ stored, metadata }),
			};
		}

		const file = stored.file;
		const url = await resolveStoredMediaUrl({ file, metadata });

		return { ...common, file, url };
	}

	async loadAllMediaAssets({
		projectId,
	}: {
		projectId: string;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		return mediaItems;
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaAssetsAdapter.remove(id),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isMediaStorageAvailable: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isMediaStorageAvailable: this.isMediaStorageAvailable(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	/**
	 * Whether media can be stored at all. The desktop build writes to the
	 * filesystem and always can; the browser build needs OPFS.
	 */
	isMediaStorageAvailable(): boolean {
		if (tauriAvailable()) return true;
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isMediaStorageAvailable();
	}
}

export const storageService = new StorageService();
