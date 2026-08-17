import EventEmitter from "eventemitter3";

import {
	Output,
	StreamTarget,
	CanvasSource,
	AudioSample,
	AudioSampleSource,
	Quality,
} from "mediabunny";
import type { StreamTargetChunk, VideoCodec } from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { ExportArtifact, ExportFormat } from "@/export";
import {
	createExportOutputFormat,
	getExportFormatSpec,
	isAudioOnlyExportFormat,
	resolveExportAudioEncoding,
} from "@/export";
import { OPFSExportTarget } from "@/services/export/opfs-export-target";
import { TauriExportTarget } from "@/services/export/tauri-export-target";
import { getExportServiceWorkerStatus } from "@/services/export/export-sw-bridge";
import type { RootNode } from "./nodes/root-node";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	/**
	 * Target bitrate in bits per second, taken from the source video so the
	 * export lands at the same size and quality as what the user imported.
	 */
	videoBitrate: number;
	/**
	 * Codec to encode with, already checked against the container and against
	 * what this engine can encode. Null means no encoder was found, which is
	 * only survivable for an audio-only container.
	 */
	videoCodec: VideoCodec | null;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

/**
 * Seconds of audio handed to the encoder at a time. Encoding a whole timeline
 * in one call is a single await that reports nothing and cannot be interrupted;
 * in slices, an audio-only export has a progress bar and a working Cancel.
 */
const AUDIO_CHUNK_SECONDS = 1;

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
	private videoBitrate: number;
	private videoCodec: VideoCodec | null;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		videoBitrate,
		videoCodec,
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
		this.videoBitrate = videoBitrate;
		this.videoCodec = videoCodec;
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
		const audioOnly = isAudioOnlyExportFormat({ format: this.format });

		const unmet = this.findUnmetRequirement({ audioOnly });
		if (unmet) {
			this.emit("error", new Error(unmet));
			return null;
		}

		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = audioOnly
			? 0
			: Math.floor(rootNode.duration / ticksPerFrame);

		const streamed = await this.tryCreateStreamingTarget();
		const fallback = new CollectingWritableStream();
		const writable: WritableStream<StreamTargetChunk> = streamed
			? streamed.handle.writableStream
			: fallback;
		const target = new StreamTarget(writable, { chunked: true });

		const output = new Output({
			format: createExportOutputFormat({ format: this.format }),
			target,
		});

		// Frames are encoded from a plain 2D copy of the compositor's output
		// rather than from the compositor's own canvas. The compositor draws
		// through wgpu, whose WebGL backend keeps its rows bottom-up and flips
		// them on present, and WebKitGTK builds a `VideoFrame` from such a canvas
		// without honouring that — `drawImage` reads it the right way up and
		// `new VideoFrame(canvas)` reads it upside down, which put every frame of
		// every desktop export on its head. Drawing into a 2D canvas resolves the
		// row order before the encoder ever sees it, on every engine.
		let frames: { canvas: HTMLCanvasElement; source: CanvasSource } | null =
			null;
		if (!audioOnly && this.videoCodec) {
			const canvas = document.createElement("canvas");
			canvas.width = this.renderer.width;
			canvas.height = this.renderer.height;
			const source = new CanvasSource(canvas, {
				codec: this.videoCodec,
				quality: new Quality({ bitrate: this.videoBitrate }),
			});
			output.addVideoTrack(source, { frameRate: fpsFloat });
			frames = { canvas, source };
		}

		let audioSource: AudioSampleSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			const encoding = await resolveExportAudioEncoding({
				format: this.format,
				numberOfChannels: this.audioBuffer.numberOfChannels,
				sampleRate: this.audioBuffer.sampleRate,
			});

			if (!encoding) {
				// A video export is still worth producing without sound; an audio
				// export has nothing left to write.
				if (audioOnly) {
					await output.cancel();
					if (streamed) await streamed.handle.dispose();
					this.emit(
						"error",
						new Error(
							`This browser can't encode audio into ${
								getExportFormatSpec({ format: this.format }).label
							} files. Try WAV instead.`,
						),
					);
					return null;
				}
				console.warn(
					"No encodable audio codec for this container; exporting silent video",
				);
			} else {
				audioSource = new AudioSampleSource({
					codec: encoding.codec,
					// Lossless codecs take no quality, and passing one is rejected
					// rather than ignored.
					...(encoding.bitrate !== null && {
						quality: new Quality({ bitrate: encoding.bitrate }),
					}),
				});
				output.addAudioTrack(audioSource);
			}
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await this.writeAudio({
				source: audioSource,
				buffer: this.audioBuffer,
				// Audio is the whole job when there is no video, so it owns the
				// progress bar. Otherwise it happens before the first frame and the
				// frame loop reports instead.
				reportProgress: audioOnly,
			});

			if (this.isCancelled) {
				await output.cancel();
				if (streamed) await streamed.handle.dispose();
				this.emit("cancelled");
				return null;
			}

			audioSource.close();
		}

		let lastPreviewAt = 0;

		if (frames) {
			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					await output.cancel();
					if (streamed) await streamed.handle.dispose();
					this.emit("cancelled");
					return null;
				}

				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				// Renders and copies the result into the encoder's canvas in one
				// step — the same path the preview and snapshots take.
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: timeTicks,
					targetCanvas: frames.canvas,
				});

				// The last frame always goes out, whatever the interval says,
				// because it is what stays on screen once the render is over.
				const now = performance.now();
				if (
					now - lastPreviewAt >= PREVIEW_FRAME_INTERVAL_MS ||
					i === frameCount - 1
				) {
					lastPreviewAt = now;
					this.emit("frame", frames.canvas);
				}

				await frames.source.add(timeSeconds, 1 / fpsFloat);

				this.emit("progress", i / frameCount);
			}
		}

		if (this.isCancelled) {
			await output.cancel();
			if (streamed) await streamed.handle.dispose();
			this.emit("cancelled");
			return null;
		}

		frames?.source.close();
		await output.finalize();
		this.emit("progress", 1);

		const artifact: ExportArtifact | null = streamed
			? streamed.artifact()
			: (() => {
					const blob = fallback.toBlob({
						mimeType: getExportFormatSpec({ format: this.format }).mimeType,
					});
					return blob ? ({ kind: "blob", blob } as const) : null;
				})();

		if (!artifact) {
			if (streamed) await streamed.handle.dispose();
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", artifact);
		return artifact;
	}

	/**
	 * Whatever stops this export before a file is opened, phrased for the user.
	 * Both cases are reachable from a perfectly ordinary project: an engine with
	 * no H.264 encoder can't write MP4, and an audio-only container has nothing
	 * to write when the timeline is silent.
	 */
	private findUnmetRequirement({
		audioOnly,
	}: {
		audioOnly: boolean;
	}): string | null {
		const { label } = getExportFormatSpec({ format: this.format });

		if (!audioOnly && !this.videoCodec) {
			return `This browser can't encode video into ${label} files. Try WebM or MKV instead.`;
		}

		if (audioOnly && (!this.shouldIncludeAudio || !this.audioBuffer)) {
			return `A ${label} export needs audio, and this timeline has none.`;
		}

		return null;
	}

	/**
	 * Feeds the mixed timeline to the encoder in slices, so the wait is
	 * interruptible and — when audio is all there is — measurable.
	 *
	 * Each slice is built as an `AudioSample` straight from the mix's own
	 * `Float32Array`s. The obvious alternative, `AudioBufferSource`, takes an
	 * `AudioBuffer` and re-reads it with `copyFromChannel(dest, channel, offset)`
	 * — and every sample's timestamp is then implied by the durations of the
	 * buffers handed over before it, rather than stated. Both of those are things
	 * this engine has to get right for the sound to stay in one piece; neither is
	 * needed when the samples are already laid out in memory. Here the frames are
	 * copied with `subarray`/`set` and every slice carries the timestamp it
	 * belongs at, so a slice that arrived wrong cannot move the ones after it.
	 */
	private async writeAudio({
		source,
		buffer,
		reportProgress,
	}: {
		source: AudioSampleSource;
		buffer: AudioBuffer;
		reportProgress: boolean;
	}): Promise<void> {
		const channelCount = buffer.numberOfChannels;
		const channels = Array.from({ length: channelCount }, (_, channel) =>
			buffer.getChannelData(channel),
		);
		const chunkFrames = Math.max(
			1,
			Math.floor(buffer.sampleRate * AUDIO_CHUNK_SECONDS),
		);

		for (let offset = 0; offset < buffer.length; offset += chunkFrames) {
			if (this.isCancelled) return;

			const frameCount = Math.min(chunkFrames, buffer.length - offset);
			// `f32-planar` wants each channel's frames laid end to end in one
			// array, which is what the mix already holds — one copy, no conversion.
			const data = new Float32Array(frameCount * channelCount);
			for (let channel = 0; channel < channelCount; channel++) {
				data.set(
					channels[channel].subarray(offset, offset + frameCount),
					channel * frameCount,
				);
			}

			const sample = new AudioSample({
				format: "f32-planar",
				sampleRate: buffer.sampleRate,
				numberOfChannels: channelCount,
				numberOfFrames: frameCount,
				timestamp: offset / buffer.sampleRate,
				data,
			});
			try {
				await source.add(sample);
			} finally {
				sample.close();
			}

			if (reportProgress) {
				this.emit("progress", (offset + frameCount) / buffer.length);
			}
		}
	}

	/**
	 * Opens a target the encoders can stream into, so the export never has to
	 * exist in memory all at once. This is what removes the 4 GB ArrayBuffer
	 * ceiling — each chunk is written to disk as it's produced.
	 *
	 * The desktop shell writes to a real file and is preferred wherever it is
	 * available: it has no quota and hands back a path. Otherwise the browser
	 * streams into OPFS and the export Service Worker delivers the file as a
	 * download without materialising it.
	 *
	 * The OPFS check crucially does NOT await SW registration — the
	 * registration is kicked off on editor mount and may still be in flight
	 * when the user clicks Export. Awaiting it would block the export on the SW
	 * install (potentially seconds) and leave the progress bar pinned at 0%.
	 * Instead we read the cached status synchronously; if the SW isn't ready,
	 * this export uses the Blob path. The next export will get the OPFS path
	 * once the SW is in place.
	 */
	private async tryCreateStreamingTarget(): Promise<{
		handle: { writableStream: WritableStream<StreamTargetChunk>; dispose: () => Promise<void> };
		artifact: () => ExportArtifact;
	} | null> {
		if (TauriExportTarget.isSupported()) {
			try {
				const handle = await TauriExportTarget.create({
					extension: getExportFormatSpec({ format: this.format }).extension,
				});
				return { handle, artifact: () => ({ kind: "path", path: handle.path }) };
			} catch (error) {
				console.warn(
					"Desktop export target unavailable, using Blob fallback:",
					error,
				);
				return null;
			}
		}

		if (!OPFSExportTarget.isSupported()) return null;
		if (getExportServiceWorkerStatus() !== "ready") return null;
		try {
			const handle = await OPFSExportTarget.create();
			return { handle, artifact: () => ({ kind: "opfs", id: handle.id }) };
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
 *
 * Chunks carry the offset they belong at, and not all of them arrive in order:
 * finalising a file seeks back to fill in sizes it couldn't know in advance —
 * the mdat length in MP4 and MOV, the RIFF and data lengths in WAV. Appending
 * blindly puts those patches at the end of the file, where they are both
 * corruption and the loss of the value they were meant to overwrite, so a write
 * that lands inside data already held is applied where it belongs instead.
 */
class CollectingWritableStream extends WritableStream<StreamTargetChunk> {
	private readonly slices: { position: number; bytes: Uint8Array<ArrayBuffer> }[] =
		[];
	/** One past the highest offset written so far — where an append lands. */
	private writtenTo = 0;

	constructor() {
		super({
			write: (chunk) => {
				// Medibunny's `chunked: true` mode already gives us 16 MiB slices
				// at a time, so each write here is a bounded copy. We still copy
				// because the underlying buffer of a WritableStream's chunk can be
				// reused by the producer after `write` resolves.
				const bytes = new Uint8Array(chunk.data.byteLength);
				bytes.set(chunk.data);
				this.absorb({ position: chunk.position, bytes });
			},
		});
	}

	private absorb({
		position,
		bytes,
	}: {
		position: number;
		bytes: Uint8Array<ArrayBuffer>;
	}): void {
		const end = position + bytes.byteLength;

		if (position < this.writtenTo) {
			this.patch({
				position,
				bytes: bytes.subarray(0, Math.min(this.writtenTo, end) - position),
			});
		}

		if (end > this.writtenTo) {
			const appendFrom = Math.max(position, this.writtenTo);
			this.slices.push({
				position: appendFrom,
				bytes: bytes.subarray(appendFrom - position),
			});
			this.writtenTo = end;
		}
	}

	/** Overwrites bytes already held, wherever they were split across slices. */
	private patch({
		position,
		bytes,
	}: {
		position: number;
		bytes: Uint8Array<ArrayBuffer>;
	}): void {
		const end = position + bytes.byteLength;

		for (const slice of this.slices) {
			const sliceEnd = slice.position + slice.bytes.byteLength;
			const overlapStart = Math.max(position, slice.position);
			const overlapEnd = Math.min(end, sliceEnd);
			if (overlapEnd <= overlapStart) continue;

			slice.bytes.set(
				bytes.subarray(overlapStart - position, overlapEnd - position),
				overlapStart - slice.position,
			);
		}
	}

	toBlob({ mimeType }: { mimeType: string }): Blob | null {
		if (this.slices.length === 0) return null;

		const ordered = [...this.slices].sort((a, b) => a.position - b.position);
		return new Blob(
			ordered.map((slice) => slice.bytes),
			{ type: mimeType },
		);
	}
}
