import EventEmitter from "eventemitter3";

import type { FrameRate } from "bluper-wasm";
import {
	cancelExport as rustCancelExport,
	encodeFrame as rustEncodeFrame,
	finalizeExport as rustFinalizeExport,
	startExport as rustStartExport,
} from "@/wasm/export";
import { NativeMediaSink } from "@/lib/tauri-runtime";

import type { ExportArtifact, ExportFormat, VideoCodecName } from "@/export";
import {
	getExportFormatSpec,
	isAudioOnlyExportFormat,
	resolveExportAudioEncoding,
} from "@/export";
import type { RootNode } from "./nodes/root-node";
import { CanvasRenderer } from "./canvas-renderer";

export type SceneExporterParams = {
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
	 * Codec to encode with, already resolved against the container and against
	 * what this build can encode. Null means no encoder was found, which is
	 * only survivable for an audio-only container.
	 */
	videoCodec: VideoCodecName | null;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

export type SceneExporterEvents = {
	progress: [progress: number];
	/**
	 * A frame that was just written to the file, handed over as the canvas it
	 * was rendered into so it can be shown while the export runs.
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
 * How often a rendered frame is offered to watchers. Reading the canvas costs
 * a copy, so it happens at a rate a person can see rather than once per
 * exported frame, which would slow the render down for pixels nobody could
 * follow.
 */
const PREVIEW_FRAME_INTERVAL_MS = 100;

/**
 * Seconds of audio handed to the encoder at a time, so a long timeline's sound
 * is written in interruptible slices rather than one opaque call.
 */
const AUDIO_CHUNK_SECONDS = 1;

/**
 * Renders a timeline into a file.
 *
 * The encoder is the desktop shell's ffmpeg, reached over binary IPC
 * (`NativeMediaSink`). It replaced `mediabunny`, which ran on WebCodecs and so
 * could only encode what the webview's own codecs offered — on WebKitGTK that
 * is frequently no H.264 at all. The shell links the system libavcodec
 * directly, so the container and codec the export panel offers are the ones
 * that will actually open.
 *
 * The session's *identity* lives in Rust too: `startExport` mints it,
 * `encodeFrame` enforces that frames arrive in order, `finalizeExport` closes
 * it. A frame index that skips is an error rather than a silently mistimed
 * file.
 *
 * What stays in the webview is the *rendering*. The compositor draws through
 * wgpu into a canvas, and the pixels are read from a 2D copy of it — never
 * from the compositor canvas directly, because wgpu's WebGL backend keeps its
 * rows bottom-up and flips them on present, which put every frame of every
 * desktop export on its head until it was found. There is a standing desktop
 * check for it: "The composited canvas encodes the way it reads".
 */
export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private fps: FrameRate;
	private format: ExportFormat;
	private videoBitrate: number;
	private videoCodec: VideoCodecName | null;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;
	private sessionId: number | null = null;
	private sink: NativeMediaSink | null = null;

	constructor(params: SceneExporterParams) {
		super();
		this.renderer = new CanvasRenderer({
			width: params.width,
			height: params.height,
			fps: params.fps,
		});
		this.fps = params.fps;
		this.format = params.format;
		this.videoBitrate = params.videoBitrate;
		this.videoCodec = params.videoCodec;
		this.shouldIncludeAudio = params.shouldIncludeAudio ?? false;
		this.audioBuffer = params.audioBuffer;
	}

	static isSupported(): boolean {
		return NativeMediaSink.isSupported();
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportArtifact | null> {
		if (!SceneExporter.isSupported()) {
			this.emit(
				"error",
				new Error(
					"Export needs the desktop shell's encoder, which is unavailable.",
				),
			);
			return null;
		}

		const audioOnly = isAudioOnlyExportFormat({ format: this.format });
		const unmet = this.findUnmetRequirement({ audioOnly });
		if (unmet) {
			this.emit("error", new Error(unmet));
			return null;
		}

		const audio = this.audioTrack();
		const session = rustStartExport({
			spec: {
				container: this.format,
				kind: audioOnly ? "audio" : audio ? "both" : "video",
				fpsNumerator: this.fps.numerator,
				fpsDenominator: this.fps.denominator,
				videoBitrate: this.videoBitrate,
				audioSampleRate: audio?.sampleRate ?? 0,
				audioChannels: audio ? Math.min(audio.numberOfChannels, 2) : 0,
			},
			durationTicks: rootNode.duration,
		});
		this.sessionId = session.sessionId;

		try {
			return await this.run({ rootNode, session, audio, audioOnly });
		} catch (error) {
			await this.abandon();
			this.emit(
				"error",
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Whatever stops this export before a file is opened, phrased for the
	 * user. Both cases are reachable from a perfectly ordinary project: a
	 * build with no encoder for a container can't write it, and an audio-only
	 * container has nothing to write when the timeline is silent.
	 */
	private findUnmetRequirement({
		audioOnly,
	}: {
		audioOnly: boolean;
	}): string | null {
		const { label } = getExportFormatSpec({ format: this.format });

		if (!audioOnly && !this.videoCodec) {
			return `This machine has no encoder for ${label} video. Try WebM or MKV instead.`;
		}
		if (audioOnly && !this.audioTrack()) {
			return `A ${label} export needs audio, and this timeline has none.`;
		}
		return null;
	}

	/**
	 * The audio the export will carry, or null for a silent one. Kept as one
	 * decision so the sink config, the Rust spec and the write loop cannot
	 * disagree about whether there is sound.
	 */
	private audioTrack(): AudioBuffer | null {
		if (!this.shouldIncludeAudio || !this.audioBuffer) return null;
		return this.audioBuffer;
	}

	private async run({
		rootNode,
		session,
		audio,
		audioOnly,
	}: {
		rootNode: RootNode;
		session: { sessionId: number; frameCount: number; ticksPerFrame: number };
		audio: AudioBuffer | null;
		audioOnly: boolean;
	}): Promise<ExportArtifact | null> {
		// The sink takes 0, 1 or 2 channels. A wider timeline mix keeps its
		// first two — which is stereo, and what every consumer of an exported
		// file expects to hear — rather than being refused at the encoder.
		const channels = audio ? Math.min(audio.numberOfChannels, 2) : 0;
		const encoding = audio
			? await resolveExportAudioEncoding({ format: this.format })
			: null;

		if (audio && !encoding) {
			// A video export is still worth producing without sound; an audio
			// export has nothing left to write.
			if (audioOnly) {
				const { label } = getExportFormatSpec({ format: this.format });
				throw new Error(
					`This machine can't encode audio into ${label} files. Try WAV instead.`,
				);
			}
			console.warn(
				"No encodable audio codec for this container; exporting silent video",
			);
		}
		const writesAudio = Boolean(audio && encoding);

		const sink = await NativeMediaSink.open({
			config: {
				container: this.format,
				videoCodec: audioOnly ? null : this.videoCodec,
				width: audioOnly ? 0 : this.renderer.width,
				height: audioOnly ? 0 : this.renderer.height,
				fpsNumerator: this.fps.numerator,
				fpsDenominator: this.fps.denominator,
				videoBitrate: this.videoBitrate,
				audioCodec: writesAudio ? (encoding?.codec ?? null) : null,
				audioSampleRate: writesAudio ? (audio?.sampleRate ?? 0) : 0,
				audioChannels: writesAudio ? channels : 0,
			},
		});
		this.sink = sink;

		if (await this.stopIfCancelled()) return null;

		// Audio first, as it always was: it happens before the first frame, so
		// the frame loop owns the progress bar uninterrupted. When audio is
		// the whole job, it owns the bar instead.
		if (writesAudio && audio) {
			await this.writeAudio({
				sink,
				buffer: audio,
				channels,
				reportProgress: audioOnly,
			});
			if (await this.stopIfCancelled()) return null;
		}

		if (!audioOnly) {
			await this.writeFrames({ sink, rootNode, session });
			if (await this.stopIfCancelled()) return null;
		}

		const path = await sink.finish();
		this.sink = null;
		rustFinalizeExport({ sessionId: session.sessionId });
		this.sessionId = null;
		this.emit("progress", 1);

		const artifact: ExportArtifact = { kind: "path", path };
		this.emit("complete", artifact);
		return artifact;
	}

	private async writeFrames({
		sink,
		rootNode,
		session,
	}: {
		sink: NativeMediaSink;
		rootNode: RootNode;
		session: { sessionId: number; frameCount: number; ticksPerFrame: number };
	}): Promise<void> {
		const canvas = document.createElement("canvas");
		canvas.width = this.renderer.width;
		canvas.height = this.renderer.height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) {
			throw new Error("Failed to open a 2D context for the export canvas");
		}

		let lastPreviewAt = 0;
		// The encode of the frame just handed over, still running in the shell
		// while this loop renders the next one. See `settle` for why exactly one
		// is ever outstanding.
		let inFlight: { index: number; encoded: Promise<void> } | null = null;

		/**
		 * Waits for the outstanding encode and books it. Called before handing
		 * over the next frame, so at most one frame is ever in flight: the sink
		 * takes frames in presentation order, and two overlapping IPC calls
		 * could arrive at it the other way round.
		 */
		const settle = async (): Promise<void> => {
			if (!inFlight) return;
			const { index, encoded } = inFlight;
			inFlight = null;
			await encoded;
			// Rust owns the count. A frame index out of order throws here
			// rather than producing a file whose timing is quietly wrong.
			rustEncodeFrame({ sessionId: session.sessionId, frameIndex: index });
			this.emit("progress", index / session.frameCount);
		};

		try {
			for (let index = 0; index < session.frameCount; index++) {
				if (this.isCancelled) return;

				// Rendering this frame overlaps the previous frame's encode: the
				// render waits on video decode in the webview while the encode
				// runs in the shell, and awaiting them in series left whichever
				// one was idle doing nothing.
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: index * session.ticksPerFrame,
					targetCanvas: canvas,
				});

				// The last frame always goes out, whatever the interval says,
				// because it is what stays on screen once the render is over.
				const now = performance.now();
				if (
					now - lastPreviewAt >= PREVIEW_FRAME_INTERVAL_MS ||
					index === session.frameCount - 1
				) {
					lastPreviewAt = now;
					this.emit("frame", canvas);
				}

				// A fresh buffer per frame, so handing the previous one to the
				// shell while this one is drawn cannot alias it.
				const pixels = context.getImageData(
					0,
					0,
					canvas.width,
					canvas.height,
				).data;

				await settle();
				inFlight = {
					index,
					encoded: sink.writeFrame({
						pixels: new Uint8Array(
							pixels.buffer,
							pixels.byteOffset,
							pixels.byteLength,
						),
						ptsIndex: index,
					}),
				};
			}

			await settle();
		} finally {
			// A render that throws, or a cancellation, leaves an encode
			// outstanding; without this its rejection surfaces as an unhandled
			// promise rather than as the export error.
			if (inFlight) {
				const { encoded } = inFlight;
				inFlight = null;
				await encoded.catch(() => {});
			}
		}
	}

	/**
	 * Feeds the mixed timeline to the encoder in slices, interleaving the
	 * channels on the way. The sink wants `s0_c0, s0_c1, s1_c0, …`; an
	 * `AudioBuffer` holds each channel end to end, so the interleave happens
	 * here — one pass over bytes that are already being copied for the wire.
	 *
	 * How many samples the codec actually wants per frame is the sink's
	 * business, not this loop's: AAC takes 1024 and Opus 960, and neither
	 * takes a second at a time. The sink buffers and re-chunks, which is what
	 * lets this slice by whatever makes the wait interruptible.
	 */
	private async writeAudio({
		sink,
		buffer,
		channels,
		reportProgress,
	}: {
		sink: NativeMediaSink;
		buffer: AudioBuffer;
		channels: number;
		reportProgress: boolean;
	}): Promise<void> {
		const planes = Array.from({ length: channels }, (_, channel) =>
			buffer.getChannelData(channel),
		);
		const chunkFrames = Math.max(
			1,
			Math.floor(buffer.sampleRate * AUDIO_CHUNK_SECONDS),
		);

		for (let offset = 0; offset < buffer.length; offset += chunkFrames) {
			if (this.isCancelled) return;

			const frames = Math.min(chunkFrames, buffer.length - offset);
			const interleaved = new Float32Array(frames * channels);
			for (let channel = 0; channel < channels; channel++) {
				const plane = planes[channel];
				for (let frame = 0; frame < frames; frame++) {
					interleaved[frame * channels + channel] = plane[offset + frame];
				}
			}

			await sink.writeAudio({
				samples: interleaved,
				frames,
				// The audio stream's time base is `1 / sampleRate`, so the
				// presentation index is the chunk's sample offset, not a
				// frame number.
				ptsIndex: offset,
			});

			if (reportProgress) {
				this.emit("progress", (offset + frames) / buffer.length);
			}
		}
	}

	/**
	 * Closes down a cancelled export and reports it. Returns whether the
	 * caller should stop, so the loop reads as `if (await …) return null`.
	 */
	private async stopIfCancelled(): Promise<boolean> {
		if (!this.isCancelled) return false;
		await this.abandon();
		this.emit("cancelled");
		return true;
	}

	/**
	 * Drops the encoder session and the control-plane session, in that order,
	 * swallowing whatever either says. Both are reached on the failure path,
	 * where the caller has already been told what went wrong and a second
	 * error from the teardown would only replace a useful message with a
	 * useless one.
	 */
	private async abandon(): Promise<void> {
		const sink = this.sink;
		this.sink = null;
		if (sink) {
			await sink.cancel().catch(() => {});
		}
		const sessionId = this.sessionId;
		this.sessionId = null;
		if (sessionId !== null) {
			try {
				rustCancelExport({ sessionId });
				rustFinalizeExport({ sessionId });
			} catch {
				// The session was already finalised, which is the ordinary
				// outcome of a cancel racing the end of the loop.
			}
		}
	}
}
