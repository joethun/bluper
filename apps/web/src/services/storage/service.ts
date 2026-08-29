import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter, deleteDatabase } from "./indexeddb-adapter";
import { TauriMediaStore } from "./tauri-media-store";
import {
	tauriAllowMediaFile,
	tauriConvertFileSrc,
	tauriStatFile,
} from "@/lib/tauri-runtime";
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
import type { Bookmark, TScene } from "@/timeline";
import {
	describeProjectValidation,
	roundMediaTime,
	validateProjectEnvelope,
} from "@/wasm";

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
	stored: StoredMedia;
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
		fps: mediaAsset.fps,
		hasAudio: mediaAsset.hasAudio,
		thumbnailUrl: mediaAsset.thumbnailUrl,
		ephemeral: mediaAsset.ephemeral,
		sourcePath: mediaAsset.sourcePath,
	};
}

/**
 * Resolves a referenced asset against the file it points at.
 *
 * The file is the user's, so it may have moved, been renamed, or be on a drive
 * that isn't mounted. That is reported as `missing` rather than as a failure:
 * everything the project knows about the media — duration, dimensions, its
 * thumbnail — was recorded at import and is still true, so the timeline lays
 * out exactly as before and only the pixels are absent. That is what makes a
 * relink a repair rather than a re-import.
 */
async function resolveReferencedMedia({
	sourcePath,
}: {
	sourcePath: string;
}): Promise<Pick<MediaAsset, "path" | "url" | "missing" | "size">> {
	const stat = await tauriStatFile({ path: sourcePath }).catch(() => null);
	if (!stat) return { missing: true };

	// The asset-protocol grant lasts only as long as the process, so every load
	// asks for it again.
	try {
		const allowedPath = await tauriAllowMediaFile({ path: sourcePath });
		return {
			path: allowedPath,
			url: tauriConvertFileSrc(allowedPath),
			size: stat.size,
		};
	} catch (error) {
		console.warn(
			`[storage] Could not grant access to ${sourcePath}:`,
			error,
		);
		return { missing: true };
	}
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

		const mediaAssetsAdapter: MediaStore = new TauriMediaStore({ projectId });

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

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			tracks: scene.tracks,
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

		// Check the envelope before building anything out of it. Everything below
		// reads `settings`, `version` and `currentSceneId` straight off the blob,
		// so an unchecked one surfaces as a renderer failure with no trail back
		// to the file that caused it.
		const validation = validateProjectEnvelope({ project: serializedProject });
		if (validation.status !== "ok") {
			console.warn(
				`[storage] Skipping unloadable project ${id}: ${describeProjectValidation(
					{ outcome: validation },
				)}`,
			);
			return null;
		}
		// Everything left is something the editor repairs on the way in —
		// `ScenesManager.initializeScenes` prepends a missing main scene and falls
		// back when `currentSceneId` names nothing. Worth a line so it is not
		// silent, not worth refusing the project over.
		if (validation.tolerated.length > 0) {
			console.warn(
				`[storage] Loading project ${id} with repairs: ${describeProjectValidation(
					{ outcome: validation },
				)}`,
			);
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

		// Referenced media has no bytes here to write: the file is the user's and
		// stays where it is. Only the metadata — which includes the path that
		// finds it again — is ours to keep.
		if (mediaAsset.sourcePath) {
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: buildMediaAssetData({ mediaAsset, file: mediaAsset.file }),
			});
			return;
		}

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
			// The probe already wrote these bytes out to scratch, so move that
			// file into place rather than streaming the same gigabytes again.
			if (mediaAsset.stagedPath) {
				await mediaAssetsAdapter.adopt({
					key: mediaAsset.id,
					from: mediaAsset.stagedPath,
				});
			} else {
				await mediaAssetsAdapter.put({ key: mediaAsset.id, file });
			}
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

		const metadata = await mediaMetadataAdapter.get(id);
		if (!metadata) return null;

		const common = {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			size: metadata.size,
			lastModified: metadata.lastModified,
		};

		if (metadata.sourcePath) {
			return {
				...common,
				sourcePath: metadata.sourcePath,
				...(await resolveReferencedMedia({
					sourcePath: metadata.sourcePath,
				})),
			};
		}

		const stored = await mediaAssetsAdapter.resolve({ key: id });
		if (!stored) return null;

		return {
			...common,
			size: stored.size,
			path: stored.path,
			url: await resolveDesktopMediaUrl({ stored, metadata }),
		};
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

		// In parallel for the same reason as `loadAllProjects`: every asset is an
		// independent pair of reads, and this runs while a project is opening —
		// serially it was one round trip per clip before the timeline could
		// appear. `Promise.all` keeps them in `mediaIds` order.
		const loaded = await Promise.all(
			mediaIds.map((id) =>
				this.loadMediaAsset({ projectId, id }).catch((error) => {
					console.warn(
						`[storage] Failed to load media ${id} in project ${projectId}:`,
						error,
					);
					return null;
				}),
			),
		);

		return loaded.filter((item): item is MediaAsset => item !== null);
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

		// Removing a referenced asset removes the project's record of it and
		// nothing else. The file belongs to the user, who did not ask for it to
		// be deleted by dragging a clip out of a timeline.
		const metadata = await mediaMetadataAdapter.get(id).catch(() => null);
		if (metadata?.sourcePath) {
			await mediaMetadataAdapter.remove(id);
			return;
		}

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
}

export const storageService = new StorageService();
