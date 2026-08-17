import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { AddMediaAssetCommand } from "@/commands/media";
import { InsertElementCommand } from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds } from "@/wasm";
import { isTypableDOMElement } from "@/utils/browser";
import { getMediaTypeFromFile } from "@/media/file-types";

/**
 * A clipboard item's `type` is as unreliable as a file's — a copied MKV or
 * M2TS arrives typeless — so the item is only skipped up front when it clearly
 * isn't media at all. Anything that might be gets turned into a `File`, where
 * the extension can be consulted too.
 */
function extractMediaFilesFromClipboard({
	clipboardData,
}: {
	clipboardData: DataTransfer | null;
}): File[] {
	if (!clipboardData?.items) return [];

	const files: File[] = [];
	for (const item of clipboardData.items) {
		if (item.kind !== "file") continue;

		const file = item.getAsFile();
		if (!file) continue;
		if (!getMediaTypeFromFile({ file })) continue;

		files.push(file);
	}
	return files;
}

export function usePasteMedia() {
	const editor = useEditor();

	useEffect(() => {
		const handlePaste = async (event: ClipboardEvent) => {
			const activeElement = document.activeElement as HTMLElement;

			if (activeElement && isTypableDOMElement({ element: activeElement })) {
				return;
			}

			const files = extractMediaFilesFromClipboard({
				clipboardData: event.clipboardData,
			});
			if (files.length === 0) {
				event.preventDefault();
				editor.clipboard.paste();
				return;
			}

			event.preventDefault();

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			try {
				await showMediaUploadToast({
					filesCount: files.length,
					promise: async () => {
						const processedAssets = await processMediaAssets({ files });
						const startTime = editor.playback.getCurrentTime();

						for (const asset of processedAssets) {
							const addMediaCmd = new AddMediaAssetCommand({
								projectId: activeProject.metadata.id,
								asset,
							});
							const assetId = addMediaCmd.getAssetId();
							const duration =
								asset.duration != null
									? mediaTimeFromSeconds({ seconds: asset.duration })
									: DEFAULT_NEW_ELEMENT_DURATION;
							const trackType = asset.type === "audio" ? "audio" : "video";

							const element = buildElementFromMedia({
								mediaId: assetId,
								mediaType: asset.type,
								name: asset.name,
								duration,
								startTime,
								buffer:
									asset.type === "audio"
										? new AudioBuffer({ length: 1, sampleRate: 44100 })
										: undefined,
							});

							const insertCmd = new InsertElementCommand({
								element,
								placement: { mode: "auto", trackType },
							});
							const batchCmd = new BatchCommand([addMediaCmd, insertCmd]);
							editor.command.execute({ command: batchCmd });
						}

						return {
							uploadedCount: processedAssets.length,
							assetNames: processedAssets.map((asset) => asset.name),
						};
					},
				});
			} catch (error) {
				console.error("Failed to paste media:", error);
			}
		};

		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, [editor]);
}
