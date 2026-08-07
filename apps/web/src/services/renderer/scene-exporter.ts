import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	StreamTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { StreamTargetChunk } from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { ExportArtifact, ExportFormat, ExportQuality } from "@/export";
import { OPFSExportTarget } from "@/services/export/opfs-export-target";
import { registerExportServiceWorker } from "@/services/export/export-sw-bridge";
import type { RootNode } from "./nodes/root-node";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	/**
	 * A frame that was just written to the file, handed over as the canvas it was
	 * rendered into so it can be shown while the export runs.
	 *
	 * That canvas is the one every frame is rendered into, so a listener has to
	 * read it before returning: by the next frame it holds different pixels.
	 */
	frame: [source: HTMLCanvasElement];
	complete: [artifact: ExportArtifact];
	error: [error: Error];
	cancelled: [];
};

/**
 * How often a rendered frame is offered to watchers. Reading the compositor's
 * canvas costs a GPU readback, so it happens at a rate a person can see rather
 * than once per exported frame, which would slow the render down for pixels
 * nobody could follow.
 */
const PREVIEW_FRAME_INTERVAL_MS = 100;

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportArtifact | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const opfsHandle = await this.tryCreateOPFSTarget();
		const fallback = new CollectingWritableStream();
		const writable: WritableStream<StreamTargetChunk> = opfsHandle
			? opfsHandle.writableStream
			: fallback;
		const target = new StreamTarget(writable, { chunked: true });

		const output = new Output({
			format: outputFormat,
			target,
		});

		const outputCanvas = this.renderer.getOutputCanvas();
		const videoSource = new CanvasSource(outputCanvas, {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

		let lastPreviewAt = 0;

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				if (opfsHandle) await opfsHandle.dispose();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await this.renderer.render({ node: rootNode, time: timeTicks });

			// Offered before the frame is encoded rather than after: a canvas the
			// GPU has drawn to is only reliably readable until the browser next
			// composites it, and encoding can wait on the encoder long enough for
			// that to happen. The last frame always goes out, whatever the interval
			// says, because it is what stays on screen once the render is over.
			const now = performance.now();
			if (
				now - lastPreviewAt >= PREVIEW_FRAME_INTERVAL_MS ||
				i === frameCount - 1
			) {
				lastPreviewAt = now;
				this.emit("frame", outputCanvas);
			}

			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			if (opfsHandle) await opfsHandle.dispose();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const artifact: ExportArtifact | null = opfsHandle
			? { kind: "opfs", id: opfsHandle.id }
			: (() => {
					const blob = fallback.toBlob();
					return blob ? { kind: "blob", blob } : null;
				})();

		if (!artifact) {
			if (opfsHandle) await opfsHandle.dispose();
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", artifact);
		return artifact;
	}

	/**
	 * Probes OPFS + Service Worker support and, if both are available, opens a
	 * target file the encoders can stream into. The OPFS path is what removes
	 * the 4 GB ArrayBuffer ceiling: each chunk is written to disk as it's
	 * produced, and the Service Worker hands the file back to the user on
	 * download without materialising it in memory.
	 */
	private async tryCreateOPFSTarget() {
		if (!OPFSExportTarget.isSupported()) return null;
		const swStatus = await registerExportServiceWorker();
		if (swStatus !== "ready") return null;
		try {
			return await OPFSExportTarget.create();
		} catch (error) {
			console.warn("OPFS export target unavailable, using Blob fallback:", error);
			return null;
		}
	}
}

/**
 * WritableStream that accumulates chunks into a single Blob, used as the
 * fallback when OPFS isn't available. The total output is still bounded by
 * available memory but a single Blob is no longer backed by one big
 * ArrayBuffer allocation, so it sidesteps the 4 GB `BufferTarget` ceiling
 * that was the original error.
 */
class CollectingWritableStream extends WritableStream<StreamTargetChunk> {
	private readonly chunks: BlobPart[] = [];

	constructor() {
		super({
			write: (chunk) => {
				// Medibunny's `chunked: true` mode already gives us 16 MiB slices
				// at a time, so each write here is a bounded copy. We still copy
				// because the underlying buffer of a WritableStream's chunk can be
				// reused by the producer after `write` resolves.
				const slice = new Uint8Array(chunk.data.byteLength);
				slice.set(chunk.data);
				this.chunks.push(slice);
			},
		});
	}

	toBlob(): Blob | null {
		if (this.chunks.length === 0) return null;
		return new Blob(this.chunks, { type: "application/octet-stream" });
	}
}
