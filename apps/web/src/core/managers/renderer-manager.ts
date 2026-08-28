import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { releaseNodeFrames } from "@/services/renderer/resolve";
import { runAfterRenders } from "@/services/renderer/canvas-renderer";
import type { ExportOptions, ExportPhase, ExportResult } from "@/export";
import { isAudioOnlyExportFormat } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/media/audio";
import { formatTimecode } from "bluper-wasm";
import { resolveSourceEncoding } from "@/services/renderer/source-encoding";
import { downloadBlob } from "@/utils/browser";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		// Release the tree being replaced. Its nodes are about to become
		// unreachable while still holding decoded frames, and a `VideoFrame` left
		// to the garbage collector holds a decoder buffer until the collector gets
		// round to it — see `releaseNodeFrames`.
		//
		// Queued behind the render queue rather than done here: an edit swaps the
		// tree synchronously, but the preview renders the tree it captured and is
		// asynchronous between resolving its frames and drawing them. Freeing them
		// inline would free the frames the pass in flight is about to draw. A tree
		// that gets rendered again after its release simply re-resolves, because
		// releasing clears the resolved state too.
		const previous = this.renderTree;
		if (previous && previous !== renderTree) {
			runAfterRenders(() => releaseNodeFrames({ node: previous }));
		}
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		await downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * The frame currently on the playhead, as an image a colour can be sampled
	 * out of. Rendered on demand rather than read back off the live preview
	 * canvas, because the compositor's drawing buffer is not preserved between
	 * frames — the same reason `createSnapshot` renders its own copy.
	 *
	 * Returns `null` when there is nothing to render, which the callers treat as
	 * "no picture to pick from" and hide the eyedropper for.
	 */
	async captureFrameImageUrl(): Promise<string | null> {
		try {
			const rendered = await this.renderCurrentFrame();
			return rendered ? rendered.toDataURL("image/png") : null;
		} catch (error) {
			console.error("Frame capture failed:", error);
			return null;
		}
	}

	private async renderCurrentFrame(): Promise<HTMLCanvasElement | null> {
		const renderTree = this.getRenderTree();
		const activeProject = this.editor.project.getActive();

		if (!renderTree || !activeProject) {
			return null;
		}

		if (this.editor.timeline.getTotalDuration() === 0) {
			return null;
		}

		const { canvasSize, fps } = activeProject.settings;
		const renderTime = Math.min(
			this.editor.playback.getCurrentTime(),
			this.editor.timeline.getLastFrameTime(),
		);

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps,
		});

		const tempCanvas = document.createElement("canvas");
		tempCanvas.width = canvasSize.width;
		tempCanvas.height = canvasSize.height;

		await renderer.renderToCanvas({
			node: renderTree,
			time: renderTime,
			targetCanvas: tempCanvas,
		});

		return tempCanvas;
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const activeProject = this.editor.project.getActive();

			if (!this.getRenderTree() || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const tempCanvas = await this.renderCurrentFrame();
			if (!tempCanvas) {
				return { success: false, error: "No project or scene to capture" };
			}

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		onProgress,
		onPhase,
		onFrame,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onPhase?: ({ phase }: { phase: ExportPhase }) => void;
		/**
		 * Called with a frame the render just wrote. The canvas is reused by the
		 * next frame, so it has to be read before this returns.
		 */
		onFrame?: ({ source }: { source: HTMLCanvasElement }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, fps, videoCodec } = options;
		// An audio-only container has nowhere to put pictures, so the audio it
		// does hold is not optional — the checkbox doesn't apply to it.
		const audioOnly = isAudioOnlyExportFormat({ format });
		const includeAudio = audioOnly || options.includeAudio;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			// Match the source video's bitrate so the export lands at the same
			// size and quality as the input — no presets for the user to pick,
			// and no surprise ballooning when the source is already low-bitrate.
			// The codec follows the source too unless the user chose one, and
			// either way it has to be something this engine can encode.
			const sourceEncoding = await resolveSourceEncoding({
				mediaAssets,
				format,
				requestedCodec: videoCodec,
			});

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				// Decoding and mixing audio happens before the first frame is
				// rendered and exposes no measurable progress (fetch + decodeAudioData
				// report nothing), so this phase is reported as indeterminate rather
				// than as a percentage that cannot move.
				onPhase?.({ phase: "preparing" });
				onProgress?.({ progress: 0 });

				// Poll the cancel request so aborting during prep takes effect
				// immediately instead of waiting for decoding to finish.
				const prepAbortController = new AbortController();
				const prepCancelInterval = setInterval(() => {
					if (onCancel?.()) prepAbortController.abort();
				}, 100);

				try {
					audioBuffer = await createTimelineAudioBuffer({
						tracks,
						mediaAssets,
						duration,
						signal: prepAbortController.signal,
					});
				} catch (error) {
					if (prepAbortController.signal.aborted) {
						return { success: false, cancelled: true };
					}
					throw error;
				} finally {
					clearInterval(prepCancelInterval);
				}

				if (onCancel?.() || prepAbortController.signal.aborted) {
					return { success: false, cancelled: true };
				}
			}

			onPhase?.({ phase: "rendering" });

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
				fps: exportFps,
			});

			const exporterParams = {
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				videoBitrate: sourceEncoding.bitrate,
				videoCodec: sourceEncoding.codec,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
			} as const;

			const exporter = new SceneExporter(exporterParams);

			// Held on an object rather than in a `let`, so reading it after the
			// export still sees the type the listener assigns.
			const failure: { error: Error | null } = { error: null };
			exporter.on("error", (error) => {
				failure.error = error;
			});

			exporter.on("progress", (progress) => {
				onProgress?.({ progress });
			});

			exporter.on("frame", (source) => {
				onFrame?.({ source });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const artifact = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!artifact) {
					return {
						success: false,
						error: failure.error?.message ?? "Export failed to produce a file",
					};
				}

				return {
					success: true,
					artifact,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
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
