import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { clearImageSourceCache } from "@/services/renderer/nodes/image-node";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";
import { processMediaPaths } from "@/media/processing";
import { tauriOpenMediaFiles } from "@/lib/tauri-runtime";
import { MEDIA_FILE_EXTENSIONS } from "@/wasm/file-types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			const stored = await this.adoptStoredAsset({
				projectId,
				id: newAsset.id,
			});
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [newAsset],
			});
			return stored ?? newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough disk space", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	/**
	 * Points an offline asset at a file again.
	 *
	 * The new file is probed like any import, because it is not necessarily the
	 * old one: a relink is how a proxy is swapped for a master, or a re-render
	 * for the take it replaced, and the duration and dimensions that come back
	 * are the ones the timeline should lay out against. What does *not* change
	 * is the asset's id or its name — every clip on the timeline refers to the
	 * id, and the name is what the user has been calling this footage.
	 *
	 * Kind is the one thing that has to match. Clips built for a video asset
	 * read a frame at a time from it, and pointing them at an audio file would
	 * leave a timeline full of elements that can no longer draw.
	 */
	async relinkMediaAsset({
		projectId,
		id,
		path,
	}: {
		projectId: string;
		id: string;
		path: string;
	}): Promise<MediaAsset | null> {
		const existing = this.assets.find((asset) => asset.id === id);
		if (!existing) return null;

		// Reports its own reason if the file can't be read.
		const [processed] = await processMediaPaths({ paths: [path] });
		if (!processed) return null;

		if (processed.type !== existing.type) {
			toast.error(`Can't relink ${existing.name}`, {
				description: `The clips using it expect ${existing.type}, and that file holds ${processed.type}.`,
			});
			return null;
		}

		const relinked: MediaAsset = {
			...existing,
			...processed,
			id,
			name: existing.name,
			missing: false,
		};

		this.assets = this.assets.map((asset) =>
			asset.id === id ? relinked : asset,
		);
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: relinked });
		} catch (error) {
			console.error("Failed to save relinked media asset:", error);
			this.assets = this.assets.map((asset) =>
				asset.id === id ? existing : asset,
			);
			this.notify();
			toast.error(`Could not relink ${existing.name}`);
			return null;
		}

		// Anything already decoded came from the file that went missing.
		videoCache.clearVideo({ mediaId: id });
		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({ kind: "media", id }),
		});
		clearImageSourceCache();

		toast.success(`${existing.name} relinked`);
		return relinked;
	}

	/**
	 * Asks for a file and relinks to it. Separate from
	 * {@link relinkMediaAsset} so the dialog stays out of anything that already
	 * knows which path it wants.
	 */
	async promptRelinkMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const asset = this.assets.find((item) => item.id === id);
		if (!asset) return null;

		const [path] = await tauriOpenMediaFiles({
			title: `Relink ${asset.name}`,
			extensions: MEDIA_FILE_EXTENSIONS,
			multiple: false,
		});
		if (!path) return null;

		return await this.relinkMediaAsset({ projectId, id, path });
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveMediaAssetCommand({
								projectId,
								assetId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	/**
	 * Replaces a just-imported asset with what the store actually wrote.
	 *
	 * An import arrives as a `File` and goes into the list as one, and nothing
	 * used to revisit it: only reopening the project ever read the stored copy
	 * back. On desktop that is the difference between a clip that plays and one
	 * that does not — every decoder there opens a *path*, so a blob-only asset
	 * has no picture in the preview and no sound under the playhead until the
	 * project is reloaded. Reading it back here costs one lookup at import time
	 * and settles it for the session.
	 *
	 * Returns null where the store has no path to offer, which is the web build:
	 * the `File` already in hand is the only source there, and it works.
	 */
	private async adoptStoredAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const stored = await storageService
			.loadMediaAsset({ projectId, id })
			.catch(() => null);
		if (!stored?.path) return null;

		// The `File` is kept: `createMediaSource` prefers the path when there is
		// one, and dropping it would strand anything still holding the asset it
		// was imported as.
		let adopted: MediaAsset | null = null;
		this.assets = this.assets.map((asset) => {
			if (asset.id !== id) return asset;
			adopted = { ...stored, file: asset.file };
			return adopted;
		});
		this.notify();
		return adopted;
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();
		waveformCache.clearAll();
		clearImageSourceCache();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
