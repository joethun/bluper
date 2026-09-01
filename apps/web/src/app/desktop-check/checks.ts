/**
 * End-to-end checks for the paths that only exist in the desktop build.
 *
 * Everything here goes through the same modules the editor uses — the media
 * store, the export target, the streaming write bridge — rather than
 * reimplementing them, so a passing run means those code paths work in the
 * shipped shell, not that a copy of them does.
 *
 * The point of each check is the same: prove that a file larger than the page
 * could hold in memory can be written, addressed and read back. Sizes are kept
 * modest so a run takes seconds; what matters is that no step's cost scales
 * with the file.
 */

import {
	TauriWriteStream,
	tauriAllowMediaFile,
	tauriAvailable,
	tauriAvailableDiskBytes,
	tauriConvertFileSrc,
	tauriDiagnosticLog,
	tauriMoveFile,
	tauriRemoveFile,
	tauriScratchPath,
	tauriProbeMedia,
	NativeMediaSink,
} from "@/lib/tauri-runtime";
import { TauriMediaStore } from "@/services/storage/tauri-media-store";
import {
	formatStorageBytes,
	readStorageQuotaStatus,
} from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import {
	createMediaSource,
	type MediaSourceRef,
} from "@/media/source";
import { openNativeVideoSink } from "@/services/video-cache/native-sink";
import { NativeAudioStream } from "@/media/native-audio";
import { VideoSample } from "@/media/video-sample";
import {
	createEmptyAudioBuffer,
	decodeAudioBufferFromRef,
} from "@/media/decode-audio";
import { getNativeAudioStats } from "@/media/native-audio";
import {
	buildSourceWaveformSummary,
	buildSourceWaveformSummaryFromRef,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import {
	forgetStoredWaveform,
	loadStoredWaveform,
	storeWaveform,
} from "@/services/waveform-store/service";
import { createTimelineAudioBuffer } from "@/media/audio";
import { getMediaTypeFromFile } from "@/wasm/file-types";
import { processMediaPaths } from "@/media/processing";
import type { MediaType } from "@/media/types";
import {
	getExportFormatSpec,
	listExportFormats,
	resolveExportAudioEncoding,
	resolveExportVideoCodec,
	type ExportFormat,
} from "@/export";
import { buildScene } from "@/services/renderer/scene-builder";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { ADJUSTMENT_PARAM_KEYS } from "@/params/registry";
import { DEFAULT_FPS } from "@/fps/defaults";
import { ZERO_MEDIA_TIME, TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { readbackFrame as wasmReadbackFrame } from "@/wasm/export";
import { EditorCore } from "@/core";
import {
	gpuRenderer,
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { buildAdjustmentFilterPasses } from "@/adjustments/filter-passes";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { videoStagingAllocations } from "bluper-wasm";
import { keepSourceAlpha } from "@/effects/canvas";
import {
	effectsRegistry,
	paintEffectedLayer,
	registerDefaultEffects,
} from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";
import { supportsCanvasFilter } from "@/effects/canvas-filter-support";
import { readFullFrameRgba, readPixelRgba } from "@/services/renderer/canvas-utils";
import { loadImageSource, clearImageSourceCache } from "@/services/renderer/nodes/image-node";

/**
 * A 0.12s mono 8kHz FLAC — a 440Hz tone, metadata stripped to STREAMINFO. Small
 * enough to inline, and inline is the point: the check has to run in the shipped
 * shell, where there is no fixture directory to read from, and FLAC cannot be
 * encoded here to order because the engine that refuses to decode it has no
 * encoder for it either.
 */
const TINY_FLAC_BASE64 =
	"ZkxhQ4AAACICQAJAAACQAAC1AfQA8AAAA8AJGe7Z7YbO8rl5xBXVMpyu//gkCADKQgAABWvmvDbAAgATDhk8" +
	"wshQmTKWHDOGTOczJJlD85kkyZzJkmHMplJTkmUJoWcwwlJTJTmTJmfMKSSZM+cyZzykzDMOGTzCyFCZMpYc" +
	"M4ZM5zMkmUPzmSTJnMmSYcymUlOSZQmhZzDCUlMlOZMmZ8wpJJkz5zJnPKTMMw4ZPMLIUJkylhwzhkznMyS" +
	"ZQ/OZJMmcyZJhzKZSU5JlCaFnMMJSUyU5kyZnzCkkmTN9D//4dAgBAX+RQvGH8BPmvDPABgBOGEJCSfHSQw" +
	"wOHtwpIGEydLCwkJIZO9MkhCSULqWSQkyUreSSBJDpSJKSQkJKHEs5IYShLdOSEkhnrwoSQhhPc4YQkJJ8d" +
	"JDDA4e3CkgYTJ0sLCQkhk70ySEJJQupZJCTJSt5JIEkOlIkpJCQkocSzkhhKEt05ISSGerPrA==";

const TINY_FLAC_SECONDS = 0.12;

function decodeBase64({ base64 }: { base64: string }): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export type CheckResult = {
	name: string;
	passed: boolean;
	detail: string;
};

type Check = {
	name: string;
	run: () => Promise<string>;
};

/** Deterministic bytes, so a round trip can be verified without storing a copy. */
function fillPattern({
	bytes,
	offset,
}: {
	bytes: Uint8Array;
	offset: number;
}): void {
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (offset + i) % 251;
	}
}

/**
 * A decoded frame split into four quadrants, each its own red level: 0 top-left,
 * 80 top-right, 160 bottom-left, 240 bottom-right.
 *
 * The distinct levels are what make a misplaced draw legible. A crop, a scale or
 * a sub-rect that landed on the wrong pixels reads back as another quadrant's
 * number rather than as "some red", so the failure message can say which part of
 * the picture arrived.
 */
function quadrantFrame({ size }: { size: number }): VideoFrame {
	const source = new OffscreenCanvas(size, size);
	const ctx = source.getContext("2d");
	if (!ctx) throw new Error("no source context");

	const half = size / 2;
	const reds = [0, 80, 160, 240];
	reds.forEach((red, index) => {
		ctx.fillStyle = `rgb(${red}, 0, 0)`;
		ctx.fillRect((index % 2) * half, Math.floor(index / 2) * half, half, half);
	});

	return new VideoFrame(source, { timestamp: 0 });
}

function expect({
	condition,
	message,
}: {
	condition: boolean;
	message: string;
}): void {
	if (!condition) throw new Error(message);
}

const MIB = 1024 * 1024;

/**
 * Writes a stage marker straight to the shell's log. A step that takes the
 * webview down with it reports no result at all, so the last marker on stdout is
 * the only thing left that says which step it was.
 */
function trace({ line }: { line: string }): void {
	console.log(`[desktop-check]   · ${line}`);
	void tauriDiagnosticLog({ line: `  · ${line}` }).catch(() => {});
}

/**
 * Runs `run` under a deadline and hands back what it returned. A step that
 * blocks forever has to surface as a failed check naming that step, not as a run
 * that never reaches its summary — the whole point of this page is that it can be
 * read from a terminal and answers on its own.
 */
async function withDeadline<T>({
	label,
	timeoutMs,
	run,
}: {
	label: string;
	timeoutMs: number;
	run: () => Promise<T>;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** {@link withDeadline}, for a step whose duration is the thing being reported. */
async function timed({
	label,
	timeoutMs,
	run,
}: {
	label: string;
	timeoutMs: number;
	run: () => Promise<unknown>;
}): Promise<number> {
	const started = performance.now();
	await withDeadline({ label, timeoutMs, run });
	return Math.round(performance.now() - started);
}

/**
 * Encodes a short clip in memory so a check has something real to import.
 * Deliberately tiny: it stands in for a file the user picked, and the point of
 * the checks is where the bytes go, not how many there are.
 */
async function encodeSampleClip({
	frames = 20,
	width = 320,
	height = 240,
	keyFrameInterval,
}: {
	frames?: number;
	width?: number;
	height?: number;
	/**
	 * Seconds between keyframes. Left alone the encoder picks, which for a
	 * clip this short means one GOP for the whole file — no use to a check
	 * that needs the decoder to cross a boundary.
	 */
	keyFrameInterval?: number;
} = {}): Promise<File> {
	// Each frame a flat colour that steps around the wheel, written as RGBA
	// rather than drawn: nothing here needs a canvas, and building the bytes
	// directly keeps the fixture independent of the drawing stack the checks
	// are pointed at.
	const sink = await NativeMediaSink.open({
		config: {
			container: "mp4",
			videoCodec: "avc",
			width,
			height,
			fpsNumerator: 30,
			fpsDenominator: 1,
			videoBitrate: 1_000_000,
			audioCodec: null,
			audioSampleRate: 0,
			audioChannels: 0,
		},
	});

	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < frames; i++) {
		const [r, g, b] = hslToRgb({ hue: (i * 18) % 360 });
		for (let at = 0; at < pixels.length; at += 4) {
			pixels[at] = r;
			pixels[at + 1] = g;
			pixels[at + 2] = b;
			pixels[at + 3] = 255;
		}
		await sink.writeFrame({ pixels, ptsIndex: i });
	}
	// `keyFrameInterval` is the encoder's business now: the sink puts a
	// keyframe every second of footage, which for the clips here is what the
	// callers asking for one wanted.
	void keyFrameInterval;

	const path = await sink.finish();
	try {
		const response = await fetch(tauriConvertFileSrc(path));
		if (!response.ok) {
			throw new Error(`could not read the sample clip: ${response.status}`);
		}
		return new File([await response.arrayBuffer()], "check.mp4", {
			type: "video/mp4",
		});
	} finally {
		await tauriRemoveFile({ path }).catch(() => {});
	}
}

/** A fully saturated colour at `hue`, as 8-bit RGB. */
function hslToRgb({ hue }: { hue: number }): [number, number, number] {
	const chroma = 1;
	const sector = (hue % 360) / 60;
	const second = chroma * (1 - Math.abs((sector % 2) - 1));
	const [r, g, b] =
		sector < 1
			? [chroma, second, 0]
			: sector < 2
				? [second, chroma, 0]
				: sector < 3
					? [0, chroma, second]
					: sector < 4
						? [0, second, chroma]
						: sector < 5
							? [second, 0, chroma]
							: [chroma, 0, second];
	// Lightness 50% on a fully saturated colour puts the darkest channel at 0
	// and the brightest at 255, which is what `hsl(h 80% 50%)` drew closely
	// enough for a fixture whose only job is that consecutive frames differ.
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** A plain wait, for checks that have to let the app get on with something. */
function pause({ ms }: { ms: number }): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * The sample a tone fixture holds at `frame`, as a float in -1..1.
 *
 * Written out rather than left implicit because it is the *oracle*: the checks
 * below compare what came back out of a decoder against this, rather than
 * against a second decoder's opinion. The amplitude ramps across the clip so
 * neighbouring buckets differ — a flat tone would compare equal even if a
 * route mislaid where samples go.
 */
function toneSampleAt({
	frame,
	frameCount,
	sampleRate,
	toneHz = 440,
	amplitude = 0.5,
}: {
	frame: number;
	frameCount: number;
	sampleRate: number;
	toneHz?: number;
	amplitude?: number;
}): number {
	const envelope = 0.2 + 0.8 * (frame / frameCount);
	return (
		amplitude * envelope * Math.sin((2 * Math.PI * toneHz * frame) / sampleRate)
	);
}

/**
 * A tone in a WAV, written byte by byte.
 *
 * Hand-rolled on purpose. This is the fixture the audio and waveform checks
 * measure against, and building it with the same encoder they are testing
 * would make those checks compare ffmpeg with itself. A WAV header is
 * forty-four bytes and PCM is the samples; there is nothing here worth taking
 * a dependency for, and what it buys is an oracle that owes nothing to the
 * code under test.
 */
async function encodeToneWav({
	seconds,
	sampleRate = 44100,
	toneHz = 440,
	amplitude = 0.5,
	channels = 2,
}: {
	seconds: number;
	sampleRate?: number;
	toneHz?: number;
	amplitude?: number;
	channels?: number;
}): Promise<File> {
	const frameCount = Math.round(seconds * sampleRate);
	const bytesPerSample = 2;
	const dataBytes = frameCount * channels * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	const ascii = ({ at, text }: { at: number; text: string }) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(at + i, text.charCodeAt(i));
		}
	};

	ascii({ at: 0, text: "RIFF" });
	view.setUint32(4, 36 + dataBytes, true);
	ascii({ at: 8, text: "WAVE" });
	ascii({ at: 12, text: "fmt " });
	view.setUint32(16, 16, true); // PCM header length
	view.setUint16(20, 1, true); // format 1 = integer PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
	view.setUint16(32, channels * bytesPerSample, true); // block align
	view.setUint16(34, 8 * bytesPerSample, true);
	ascii({ at: 36, text: "data" });
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (let frame = 0; frame < frameCount; frame++) {
		const value = toneSampleAt({
			frame,
			frameCount,
			sampleRate,
			toneHz,
			amplitude,
		});
		// Rounded rather than truncated, and clamped: a sample a hair over 1.0
		// should be the loudest sample, not the quietest.
		const pcm = Math.max(
			-32768,
			Math.min(32767, Math.round(value * 32767)),
		);
		for (let channel = 0; channel < channels; channel++) {
			view.setInt16(offset, pcm, true);
			offset += bytesPerSample;
		}
	}

	return new File([buffer], "tone.wav", { type: "audio/wav" });
}

/**
 * One decoded frame from a file, at or after `seconds`.
 *
 * The checks below need to look at what an export really contains, and this is
 * how they do it now that the page has no demuxer of its own. It goes through
 * the same pair the editor previews with — the shell walks the container, the
 * webview's `VideoDecoder` decodes it — which makes it a weaker oracle than an
 * unrelated library would be, and worth being honest about: it cannot catch a
 * file that both halves of this pipeline agree to misread.
 *
 * What it does catch is everything the checks actually ask it: which way up a
 * frame is, what colour it is, and whether there is a frame there at all. Those
 * are properties of the *encoder*, which is the other side of the house.
 */
async function decodeFrameAt({
	path,
	seconds,
}: {
	path: string;
	seconds: number;
}): Promise<VideoSample | null> {
	const sink = await openNativeVideoSink({
		ref: { kind: "url", url: tauriConvertFileSrc(path), path },
	});
	if (!sink) return null;
	try {
		for await (const sample of sink.samples(seconds)) {
			return sample;
		}
		return null;
	} finally {
		sink.dispose();
	}
}

/**
 * Writes a fixture to a scratch file and describes it the way a stored asset
 * is described.
 *
 * Every decoder in the editor reads a path now — that is what moving the media
 * pipeline into the shell means — so a fixture that stays a `Blob` in the page
 * is a fixture nothing under test can open. Callers remove the file when they
 * are done with it.
 */
async function scratchMediaRef({
	file,
	extension,
}: {
	file: File;
	extension: string;
}): Promise<{ ref: MediaSourceRef; path: string }> {
	const path = await tauriScratchPath({
		name: `check-${crypto.randomUUID()}.${extension}`,
	});
	const stream = await TauriWriteStream.open({ path });
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		await stream.write({ bytes });
		await stream.close();
	} catch (error) {
		await stream.abort().catch(() => {});
		throw error;
	}
	return {
		ref: { kind: "url", url: tauriConvertFileSrc(path), path },
		path,
	};
}

/**
 * A clip built to answer two questions about an export at once: red over blue
 * says which way up it came out, and a continuous tone says whether the sound
 * survived in one piece. Both halves are deliberately unmissable — a flip or a
 * dropout is a colour swap or a silent window, not a subtle difference.
 */
async function encodeProbeClip({
	seconds,
	width = 64,
	height = 64,
	fps = 30,
	sampleRate = 44100,
	toneHz = 440,
	amplitude = 0.5,
}: {
	seconds: number;
	width?: number;
	height?: number;
	fps?: number;
	sampleRate?: number;
	toneHz?: number;
	amplitude?: number;
}): Promise<File> {
	// Red over blue, written as raw RGBA rather than drawn on a canvas: the
	// fixture's job is to be unambiguous about which way up it is, and a
	// buffer built by hand cannot itself be flipped by the thing under test.
	const pixels = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const top = y < height / 2;
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			pixels[at] = top ? 255 : 0;
			pixels[at + 1] = 0;
			pixels[at + 2] = top ? 0 : 255;
			pixels[at + 3] = 255;
		}
	}

	const sink = await NativeMediaSink.open({
		config: {
			container: "mp4",
			videoCodec: "avc",
			width,
			height,
			fpsNumerator: fps,
			fpsDenominator: 1,
			videoBitrate: 2_000_000,
			audioCodec: "aac",
			audioSampleRate: sampleRate,
			audioChannels: 2,
		},
	});

	const frames = Math.round(seconds * fps);
	for (let i = 0; i < frames; i++) {
		await sink.writeFrame({ pixels, ptsIndex: i });
	}

	const frameCount = Math.round(seconds * sampleRate);
	const chunkFrames = sampleRate;
	for (let offset = 0; offset < frameCount; offset += chunkFrames) {
		const count = Math.min(chunkFrames, frameCount - offset);
		const interleaved = new Float32Array(count * 2);
		for (let i = 0; i < count; i++) {
			const value =
				amplitude *
				Math.sin((2 * Math.PI * toneHz * (offset + i)) / sampleRate);
			interleaved[i * 2] = value;
			interleaved[i * 2 + 1] = value;
		}
		await sink.writeAudio({
			samples: interleaved,
			frames: count,
			ptsIndex: offset,
		});
	}

	const path = await sink.finish();
	try {
		const response = await fetch(tauriConvertFileSrc(path));
		if (!response.ok) {
			throw new Error(`could not read the probe clip: ${response.status}`);
		}
		return new File([await response.arrayBuffer()], "probe.mp4", {
			type: "video/mp4",
		});
	} finally {
		await tauriRemoveFile({ path }).catch(() => {});
	}
}

type VerticalOrder = {
	order: "red-on-top" | "blue-on-top" | "indeterminate";
	detail: string;
};

/**
 * Where the picture's red half ended up. Reads a pixel well inside the top
 * quarter and one well inside the bottom quarter, so chroma subsampling and
 * codec ringing at the seam can't decide the answer.
 */
function readVerticalOrder({
	source,
	width,
	height,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
}): VerticalOrder {
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Failed to create readback context");
	ctx.drawImage(source, 0, 0, width, height);
	const x = Math.floor(width / 2);
	const top = ctx.getImageData(x, Math.floor(height / 8), 1, 1).data;
	const bottom = ctx.getImageData(x, Math.floor((height * 7) / 8), 1, 1).data;
	const detail = `top r${top[0]}b${top[2]}, bottom r${bottom[0]}b${bottom[2]}`;

	const redOnTop = top[0] > top[2] + 40 && bottom[2] > bottom[0] + 40;
	const blueOnTop = top[2] > top[0] + 40 && bottom[0] > bottom[2] + 40;
	return {
		order: redOnTop ? "red-on-top" : blueOnTop ? "blue-on-top" : "indeterminate",
		detail,
	};
}

/**
 * Scans a decoded buffer for windows where the sound stopped. A continuous tone
 * peaks at its amplitude in every window; a dropout reads as a window that
 * peaks at nothing, which is what "the audio cuts in and out" is made of.
 *
 * The first and last `edgeSeconds` are skipped: encoder priming and the tail
 * padding of a lossy codec are silent by design and say nothing about the
 * middle.
 */
function findAudioDropouts({
	buffer,
	windowSeconds = 0.02,
	silenceBelow = 0.1,
	edgeSeconds = 0.15,
}: {
	buffer: AudioBuffer;
	windowSeconds?: number;
	silenceBelow?: number;
	edgeSeconds?: number;
}): { count: number; firstAtSeconds: number | null; worstPeak: number } {
	const samples = buffer.getChannelData(0);
	const windowFrames = Math.max(1, Math.floor(buffer.sampleRate * windowSeconds));
	const edgeFrames = Math.floor(buffer.sampleRate * edgeSeconds);
	const from = edgeFrames;
	const to = Math.max(from, samples.length - edgeFrames);

	let count = 0;
	let firstAt: number | null = null;
	let worstPeak = Number.POSITIVE_INFINITY;

	for (let offset = from; offset + windowFrames <= to; offset += windowFrames) {
		let peak = 0;
		for (let i = offset; i < offset + windowFrames; i++) {
			const magnitude = Math.abs(samples[i]);
			if (magnitude > peak) peak = magnitude;
		}
		if (peak < worstPeak) worstPeak = peak;
		if (peak < silenceBelow) {
			count++;
			firstAt ??= offset / buffer.sampleRate;
		}
	}

	return {
		count,
		firstAtSeconds: firstAt,
		worstPeak: Number.isFinite(worstPeak) ? worstPeak : 0,
	};
}

/**
 * Writes `sizeBytes` through the streaming bridge without ever holding more
 * than one chunk, and returns the path it landed at.
 */
async function writePatternFile({
	sizeBytes,
	chunkBytes,
}: {
	sizeBytes: number;
	chunkBytes: number;
}): Promise<string> {
	const path = await tauriScratchPath({ name: `${crypto.randomUUID()}.bin` });
	const stream = await TauriWriteStream.open({ path });
	const chunk = new Uint8Array(chunkBytes);
	let written = 0;
	while (written < sizeBytes) {
		const length = Math.min(chunkBytes, sizeBytes - written);
		const slice = length === chunkBytes ? chunk : chunk.subarray(0, length);
		fillPattern({ bytes: slice, offset: written });
		written = await stream.write({ bytes: slice });
	}
	const total = await stream.close();
	expect({
		condition: total === sizeBytes,
		message: `stream reported ${total} bytes, expected ${sizeBytes}`,
	});
	return path;
}

/**
 * Loads `url` into an HTMLImageElement and resolves with its decoded size, or
 * rejects with the network-level error the element saw. The path the image
 * import follows is exactly this — `new Image(); image.src = assetUrl` — so a
 * failure here is the same failure the user sees as a "no decoder" toast.
 */
function loadImage({
	url,
	timeoutMs = 5000,
}: {
	url: string;
	timeoutMs?: number;
}): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		const timer = setTimeout(() => {
			image.remove();
			reject(new Error(`<img> timed out after ${timeoutMs}ms loading ${url}`));
		}, timeoutMs);
		const cleanup = () => clearTimeout(timer);
		image.addEventListener("load", () => {
			cleanup();
			image.remove();
			resolve({ width: image.naturalWidth, height: image.naturalHeight });
		});
		image.addEventListener("error", () => {
			cleanup();
			image.remove();
			reject(new Error(`<img> error loading ${url}`));
		});
		image.src = url;
	});
}

const checks: Check[] = [
	{
		name: "Binary IPC writes bytes verbatim",
		run: async () => {
			// The failure this guards against is subtle and total: if the payload
			// goes out as JSON instead of a raw body, every byte still arrives —
			// as a number in an array — and the file is silently wrong.
			const path = await writePatternFile({
				sizeBytes: 3 * MIB + 1234,
				chunkBytes: 1 * MIB,
			});
			try {
				const response = await fetch(tauriConvertFileSrc(path));
				const bytes = new Uint8Array(await response.arrayBuffer());
				expect({
					condition: bytes.length === 3 * MIB + 1234,
					message: `read back ${bytes.length} bytes`,
				});
				const expected = new Uint8Array(bytes.length);
				fillPattern({ bytes: expected, offset: 0 });
				for (let i = 0; i < bytes.length; i++) {
					expect({
						condition: bytes[i] === expected[i],
						message: `byte ${i} differs`,
					});
				}
				return `${bytes.length} bytes round-tripped unchanged`;
			} finally {
				await tauriRemoveFile({ path });
			}
		},
	},
	{
		name: "Positioned writes patch earlier offsets",
		run: async () => {
			// Finalising an MP4 seeks back to fill in box sizes. Without this,
			// exports would stream perfectly and still produce unplayable files.
			const path = await tauriScratchPath({
				name: `${crypto.randomUUID()}.bin`,
			});
			const stream = await TauriWriteStream.open({ path });
			try {
				await stream.write({ bytes: new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]) });
				await stream.write({ bytes: new Uint8Array([9, 9]), position: 2 });
				await stream.write({ bytes: new Uint8Array([7]), position: 7 });
				const length = await stream.close();
				expect({
					condition: length === 8,
					message: `file length is ${length}, expected 8`,
				});

				const response = await fetch(tauriConvertFileSrc(path));
				const bytes = new Uint8Array(await response.arrayBuffer());
				const expected = [1, 1, 9, 9, 1, 1, 1, 7];
				expect({
					condition: expected.every((value, index) => bytes[index] === value),
					message: `got [${Array.from(bytes).join(",")}], expected [${expected.join(",")}]`,
				});
				return "seek-back-and-patch produced the expected bytes";
			} finally {
				await tauriRemoveFile({ path }).catch(() => {});
			}
		},
	},
	{
		name: "Asset protocol serves ranges",
		run: async () => {
			// This is what lets a clip play without being loaded: if ranges
			// aren't honoured, every seek pulls the whole file into the page.
			const size = 4 * MIB;
			const path = await writePatternFile({
				sizeBytes: size,
				chunkBytes: 1 * MIB,
			});
			try {
				const url = tauriConvertFileSrc(path);
				const start = 1_000_000;
				const end = 1_000_999;
				const response = await fetch(url, {
					headers: { Range: `bytes=${start}-${end}` },
				});
				expect({
					condition: response.status === 206,
					message: `expected 206 Partial Content, got ${response.status}`,
				});
				const contentRange = response.headers.get("Content-Range");
				expect({
					condition: contentRange?.endsWith(`/${size}`) === true,
					message: `Content-Range was ${contentRange ?? "absent"}`,
				});
				const bytes = new Uint8Array(await response.arrayBuffer());
				expect({
					condition: bytes.length === 1000,
					message: `range returned ${bytes.length} bytes`,
				});
				for (let i = 0; i < bytes.length; i++) {
					expect({
						condition: bytes[i] === (start + i) % 251,
						message: `range byte ${i} differs`,
					});
				}
				return `206 with ${contentRange}, bytes match the offset`;
			} finally {
				await tauriRemoveFile({ path });
			}
		},
	},
	{
		name: "An imported image decodes through the asset protocol",
		run: async () => {
			// The image import path grants a single file through the asset
			// protocol and loads it via <img>. PNG and JPEG are the formats the
			// user reaches for first, so a failure here is the bug behind "no
			// decoder" toasts on import.
			const canvas = document.createElement("canvas");
			canvas.width = 16;
			canvas.height = 16;
			const ctx = canvas.getContext("2d");
			expect({
				condition: ctx !== null,
				message: "2D context unavailable",
			});
			ctx!.fillStyle = "rgb(255, 0, 0)";
			ctx!.fillRect(0, 0, 8, 16);
			ctx!.fillStyle = "rgb(0, 0, 255)";
			ctx!.fillRect(8, 0, 8, 16);

			// One PNG, one JPEG. Both are universal and both must decode —
			// anything else is the bug the user is hitting.
			const pngBlob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob((value) => resolve(value), "image/png"),
			);
			const jpegBlob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob((value) => resolve(value), "image/jpeg"),
			);
			expect({
				condition: pngBlob !== null,
				message: "canvas produced no PNG blob",
			});
			expect({
				condition: jpegBlob !== null,
				message: "canvas produced no JPEG blob",
			});

			for (const { format, blob } of [
				{ format: "png" as const, blob: pngBlob! },
				{ format: "jpeg" as const, blob: jpegBlob! },
			]) {
				const bytes = new Uint8Array(await blob.arrayBuffer());
				const path = await tauriScratchPath({
					name: `${crypto.randomUUID()}.${format}`,
				});
				try {
					const stream = await TauriWriteStream.open({ path });
					await stream.write({ bytes });
					await stream.close();

					const allowedPath = await tauriAllowMediaFile({ path });
					const url = tauriConvertFileSrc(allowedPath);

					const head = await fetch(url, {
						headers: { Range: "bytes=0-15" },
					});
					expect({
						condition: head.status === 206,
						message: `${format} range request returned ${head.status}`,
					});

					const loaded = await loadImage({ url });
					expect({
						condition: loaded.width === 16 && loaded.height === 16,
						message: `${format} decoded to ${loaded.width}x${loaded.height}, expected 16x16`,
					});
				} finally {
					await tauriRemoveFile({ path }).catch(() => {});
				}
			}
			return `PNG and JPEG both decoded to 16x16 via asset://`;
		},
	},
	{
		name: "processMediaPaths accepts PNG and JPEG by path",
		run: async () => {
			// The full import flow runs through processMediaPaths: dialog → stat
			// → grant → load → thumbnail. A failure at any step surfaces to the
			// user as a toast; the "no decoder" one was fired when the canvas
			// draw after loading from `asset://` taints the canvas and
			// toDataURL throws SecurityError.
			const canvas = document.createElement("canvas");
			canvas.width = 16;
			canvas.height = 16;
			const ctx = canvas.getContext("2d");
			ctx!.fillStyle = "rgb(255, 0, 0)";
			ctx!.fillRect(0, 0, 16, 16);

			const pngBlob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob((value) => resolve(value), "image/png"),
			);
			const jpegBlob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob((value) => resolve(value), "image/jpeg"),
			);
			expect({
				condition: pngBlob !== null,
				message: "canvas produced no PNG blob",
			});
			expect({
				condition: jpegBlob !== null,
				message: "canvas produced no JPEG blob",
			});

			for (const { format, blob } of [
				{ format: "png" as const, blob: pngBlob! },
				{ format: "jpeg" as const, blob: jpegBlob! },
			]) {
				const bytes = new Uint8Array(await blob.arrayBuffer());
				const path = await tauriScratchPath({
					name: `${crypto.randomUUID()}.${format === "jpeg" ? "jpg" : "png"}`,
				});
				try {
					const stream = await TauriWriteStream.open({ path });
					await stream.write({ bytes });
					await stream.close();

					const assets = await processMediaPaths({ paths: [path] });
					expect({
						condition: assets.length === 1,
						message: `${format} run returned ${assets.length} assets`,
					});
					expect({
						condition: assets[0]?.type === "image",
						message: `${format} asset type was ${assets[0]?.type as string}`,
					});
					expect({
						condition:
							assets[0]?.width === 16 && assets[0]?.height === 16,
						message: `${format} geometry ${assets[0]?.width}x${assets[0]?.height}`,
					});
					expect({
						condition:
							assets[0]?.thumbnailUrl?.startsWith("data:image/jpeg") === true,
						message: `${format} thumbnailUrl was ${
							assets[0]?.thumbnailUrl?.slice(0, 40) ?? "missing"
						}`,
					});
				} finally {
					await tauriRemoveFile({ path }).catch(() => {});
				}
			}
			return `processMediaPaths produced image assets for PNG and JPEG with thumbnails`;
		},
	},
	{
		name: "Media store round trip",
		run: async () => {
			const projectId = crypto.randomUUID();
			const store = new TauriMediaStore({ projectId });
			const mediaId = crypto.randomUUID();
			const payload = new Uint8Array(2 * MIB);
			fillPattern({ bytes: payload, offset: 0 });
			const file = new File([payload], "clip.bin");

			try {
				await store.put({ key: mediaId, file });

				const listed = await store.list();
				expect({
					condition: listed.includes(mediaId),
					message: `list() returned [${listed.join(",")}]`,
				});

				const resolved = await store.resolve({ key: mediaId });
				expect({
					condition: resolved !== null,
					message: "resolve() returned null after put()",
				});
				expect({
					condition: resolved?.kind === "path",
					message: `resolve() returned kind ${resolved?.kind}`,
				});
				if (resolved?.kind !== "path") throw new Error("unreachable");
				expect({
					condition: resolved.size === payload.length,
					message: `resolve() reported ${resolved.size} bytes`,
				});

				const response = await fetch(resolved.url);
				const bytes = new Uint8Array(await response.arrayBuffer());
				expect({
					condition:
						bytes.length === payload.length && bytes[12345] === payload[12345],
					message: "bytes read back through the asset URL differ",
				});

				await store.remove(mediaId);
				const afterRemove = await store.resolve({ key: mediaId });
				expect({
					condition: afterRemove === null,
					message: "resolve() still found a removed file",
				});

				return `stored, listed, read and removed ${formatStorageBytes({ bytes: payload.length })}`;
			} finally {
				await store.clear().catch(() => {});
			}
		},
	},
	{
		name: "Finished files move to their destination",
		run: async () => {
			const from = await writePatternFile({
				sizeBytes: 512 * 1024,
				chunkBytes: 128 * 1024,
			});
			const to = await tauriScratchPath({
				name: `${crypto.randomUUID()}.moved`,
			});
			try {
				await tauriMoveFile({ from, to });
				const moved = await fetch(tauriConvertFileSrc(to));
				expect({
					condition: moved.ok,
					message: `moved file responded ${moved.status}`,
				});
				const gone = await fetch(tauriConvertFileSrc(from));
				expect({
					condition: gone.status === 404,
					message: `source still readable, responded ${gone.status}`,
				});
				return "moved without reading the file into the page";
			} finally {
				await tauriRemoveFile({ path: to }).catch(() => {});
				await tauriRemoveFile({ path: from }).catch(() => {});
			}
		},
	},
	{
		name: "Capacity comes from the disk, not a sandbox quota",
		run: async () => {
			const free = await tauriAvailableDiskBytes();
			expect({
				condition: free !== null && free > 0,
				message: `the shell reported ${free} free bytes`,
			});
			const status = await readStorageQuotaStatus();
			expect({
				condition: status.availableBytes !== null,
				message: "storage capacity is unknown on desktop",
			});
			// The browser sandbox quota is a fraction of the disk; anything in
			// that range means the estimate is still coming from the WebView.
			const estimate = await navigator.storage?.estimate?.().catch(() => null);
			const sandboxQuota = estimate?.quota ?? null;
			return sandboxQuota !== null && free !== null
				? `${formatStorageBytes({ bytes: free })} free on disk vs ${formatStorageBytes({ bytes: sandboxQuota })} of WebView quota`
				: `${formatStorageBytes({ bytes: free ?? 0 })} free on disk`;
		},
	},
	{
		name: "Storage service imports and reloads a clip",
		run: async () => {
			// The editor's own path: save a media asset the way an import does,
			// then load it back the way opening a project does, and check that
			// what comes back is disk-backed rather than a copy in memory.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
					},
				});

				const loaded = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: loaded !== null,
					message: "the asset did not load back",
				});
				expect({
					condition: loaded?.file === undefined,
					message:
						"a reloaded desktop asset still carries a File, so its bytes are in memory",
				});
				expect({
					condition: typeof loaded?.path === "string",
					message: "the reloaded asset has no path on disk",
				});
				expect({
					condition: loaded?.size === file.size,
					message: `reloaded size was ${loaded?.size}, expected ${file.size}`,
				});
				expect({
					condition:
						loaded?.url?.startsWith("asset://") === true ||
						loaded?.url?.includes("asset.localhost") === true,
					message: `reloaded url was ${loaded?.url}`,
				});

				const assets = await storageService.loadAllMediaAssets({ projectId });
				expect({
					condition: assets.length === 1 && assets[0].id === mediaId,
					message: `loadAllMediaAssets returned ${assets.length} assets`,
				});

				return `${formatStorageBytes({ bytes: file.size })} imported and reloaded as a path, not a File`;
			} finally {
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Preview decodes frames straight off disk",
		run: async () => {
			// What playback and scrubbing do: sample the decoder for a stored
			// clip. On desktop that decoder is reading the file through a URL,
			// so this is the check that the preview never needs the bytes in
			// the page either.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: asset !== null,
					message: "the asset did not load back",
				});
				const source = createMediaSource({ asset: asset! });
				expect({
					condition: source?.kind === "url",
					message: `source kind was ${source?.kind}`,
				});

				const sample = await videoCache.getSampleAt({
					mediaId,
					source: source!,
					time: 0.25,
				});
				expect({
					condition: sample !== null,
					message: "the decoder returned no frame",
				});
				expect({
					condition:
						sample?.displayWidth === 320 && sample?.displayHeight === 240,
					message: `frame was ${sample?.displayWidth}x${sample?.displayHeight}`,
				});

				// The container is parsed by the shell here, not by mediabunny in
				// the page. That fallback is deliberately silent — an unsupported
				// codec has to keep playing — which is exactly why it needs
				// asserting: without this the check would pass just as happily
				// with the native path broken and never reached.
				const stats = videoCache.getStats();
				expect({
					condition: stats.nativeSinks === 1,
					message: `the decoder fell back to the in-page demuxer (${stats.nativeSinks}/${stats.totalSinks} native)`,
				});

				return `decoded a ${sample?.displayWidth}x${sample?.displayHeight} frame at 0.25s, demuxed by the shell`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Playback runs on past the end of a GOP",
		run: async () => {
			// A GOP is all the decoder can be handed at once, so playing a clip
			// through means chaining from each one to the next. Getting that
			// chain wrong is quiet: the picture simply stops advancing, or the
			// same second plays over and over, and every other check here uses a
			// clip short enough to be a single GOP and would never see it.
			//
			// So: half-second keyframes over three seconds, then walk the
			// playhead frame by frame and insist each frame really covers the
			// time it was asked for, rather than being a stale one held over.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const fps = 30;
			const totalFrames = 90;
			const file = await encodeSampleClip({
				frames: totalFrames,
				keyFrameInterval: 0.5,
			});

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				const source = createMediaSource({ asset: asset! });
				expect({
					condition: source !== null,
					message: "the stored clip produced no media source",
				});

				let stale = 0;
				let missing = 0;
				let lastTimestamp = -1;
				let advanced = 0;

				// Stop one frame short: a clip's declared duration usually runs a
				// little past its final frame, and holding the last picture there
				// is deliberate (see `resolveSample`).
				for (let index = 0; index < totalFrames - 1; index += 1) {
					const time = (index + 0.5) / fps;
					videoCache.beginFrame();
					const sample = await videoCache.getSampleAt({
						mediaId,
						source: source!,
						time,
					});
					if (!sample) {
						missing += 1;
						continue;
					}
					if (
						time < sample.timestamp ||
						time >= sample.timestamp + sample.duration
					) {
						stale += 1;
					}
					if (sample.timestamp > lastTimestamp) {
						advanced += 1;
						lastTimestamp = sample.timestamp;
					}
				}

				expect({
					condition: missing === 0,
					message: `${missing} of ${totalFrames - 1} frames decoded to nothing`,
				});
				expect({
					condition: stale === 0,
					message: `${stale} of ${totalFrames - 1} frames were not the frame covering the requested time`,
				});
				expect({
					condition: advanced === totalFrames - 1,
					message: `the picture only advanced ${advanced} times across ${totalFrames - 1} frames`,
				});

				const stats = videoCache.getStats();
				expect({
					condition: stats.nativeSinks === 1,
					message: `the decoder fell back to the in-page demuxer (${stats.nativeSinks}/${stats.totalSinks} native)`,
				});

				return `played ${advanced} distinct frames across ${Math.round((totalFrames / fps) * 2)} GOPs without a stale or missing one`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Idle decoders are retired instead of accumulating",
		run: async () => {
			// Every clip that needs its own decoder position gets its own decoder,
			// and nothing used to close them until the asset was removed or the
			// project closed. Each one holds a `VideoDecoder`, an open read over
			// the file and its decoded samples, so scrubbing down a long timeline
			// walked the process into an out-of-memory kill. Decoders are now
			// retired by render pass; this is the guard that they still are.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();
			const openedKeys = 14;

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				const source = createMediaSource({ asset: asset! });
				expect({
					condition: source !== null,
					message: "the stored asset produced no media source",
				});

				// One pass that wants a lot of separate decoder positions at once,
				// the way a track full of transitions does.
				videoCache.beginFrame();
				for (let index = 0; index < openedKeys; index += 1) {
					await videoCache.getSampleAt({
						mediaId,
						sinkKey: `${mediaId}:clip-${index}`,
						source: source!,
						time: 0.1,
					});
				}
				const opened = videoCache.getStats();
				expect({
					condition: opened.totalSinks === openedKeys,
					message: `expected ${openedKeys} decoders open, saw ${opened.totalSinks}`,
				});

				// Passes that ask for nothing: the playhead has moved off every one
				// of those clips.
				videoCache.beginFrame();
				videoCache.beginFrame();
				const settled = videoCache.getStats();
				expect({
					condition: settled.totalSinks <= settled.maxIdleSinks,
					message: `expected at most ${settled.maxIdleSinks} decoders to survive, saw ${settled.totalSinks}`,
				});

				// A decoder the passes keep asking for is on screen and must not be
				// evicted from under the frame that needs it, even while the cache
				// is over its idle cap.
				const heldKey = `${mediaId}:held`;
				for (let pass = 0; pass < 4; pass += 1) {
					videoCache.beginFrame();
					const held = await videoCache.getSampleAt({
						mediaId,
						sinkKey: heldKey,
						source: source!,
						time: 0.1,
					});
					expect({
						condition: held !== null,
						message: `an in-use decoder stopped returning frames on pass ${pass}`,
					});
				}

				return `${openedKeys} decoders opened, ${settled.totalSinks} left after two idle passes (cap ${settled.maxIdleSinks}); an in-use decoder survived 4 passes`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Scrubbing backwards lands on the right frame every step",
		run: async () => {
			// Dragging the playhead the other way is the case the decoder cache
			// is least suited to: an iterator only runs forwards, so every step
			// backwards abandons it and seeks again. Two things now sit on that
			// path — GOPs are held in memory so the seek does not re-demux and
			// re-fetch what it just read, and the forward prefetch is skipped
			// because the frame it decodes is one the next step throws away.
			// Both are invisible when they are wrong: the picture is merely
			// stale, which looks like a slow drag rather than a bug. So walk a
			// multi-GOP clip from its end to its start and insist that every
			// step is the frame covering the time asked for.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const fps = 30;
			const totalFrames = 90;
			const file = await encodeSampleClip({
				frames: totalFrames,
				keyFrameInterval: 0.5,
			});

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				const source = createMediaSource({ asset: asset! });
				expect({
					condition: source !== null,
					message: "the stored clip produced no media source",
				});

				let stale = 0;
				let missing = 0;
				let retreated = 0;
				let lastTimestamp = Number.POSITIVE_INFINITY;

				// From the last frame back to the first. One short at the top for
				// the same reason the forward check stops early: a clip's declared
				// duration runs a little past its final frame.
				for (let index = totalFrames - 2; index >= 0; index -= 1) {
					const time = (index + 0.5) / fps;
					videoCache.beginFrame();
					const sample = await videoCache.getSampleAt({
						mediaId,
						source: source!,
						time,
					});
					if (!sample) {
						missing += 1;
						continue;
					}
					if (
						time < sample.timestamp ||
						time >= sample.timestamp + sample.duration
					) {
						stale += 1;
					}
					if (sample.timestamp < lastTimestamp) {
						retreated += 1;
						lastTimestamp = sample.timestamp;
					}
				}

				expect({
					condition: missing === 0,
					message: `${missing} of ${totalFrames - 1} frames decoded to nothing while scrubbing backwards`,
				});
				expect({
					condition: stale === 0,
					message: `${stale} of ${totalFrames - 1} backwards steps showed a frame that did not cover the requested time`,
				});
				expect({
					condition: retreated === totalFrames - 1,
					message: `the picture only moved back ${retreated} times across ${totalFrames - 1} backwards steps`,
				});

				return `walked ${retreated} frames backwards across ${Math.round((totalFrames / fps) * 2)} GOPs without a stale or missing one`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Scene graph keeps disk-backed clips",
		run: async () => {
			// The scene builder used to skip any clip without a `File`, which on
			// desktop would now be every clip — a timeline full of media and a
			// blank canvas. Build a one-clip scene from a stored asset and check
			// the video node survives with a streaming source.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
						duration: 20 / 30,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: asset !== null,
					message: "the asset did not load back",
				});

				const duration = mediaTimeFromSeconds({ seconds: 1 });
				const scene = buildScene({
					canvasSize: { width: 320, height: 240 },
					background: { type: "color", color: "#000000" },
					duration,
					mediaAssets: [asset!],
					tracks: {
						overlay: [],
						audio: [],
						main: {
							id: "main",
							name: "Main",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "clip",
									name: "check.mp4",
									type: "video",
									mediaId,
									duration,
									startTime: ZERO_MEDIA_TIME,
									trimStart: ZERO_MEDIA_TIME,
									trimEnd: ZERO_MEDIA_TIME,
									params: {},
								},
							],
						},
					},
				});

				const videoNodes = scene.children.filter(
					(node) => node instanceof VideoNode,
				);
				expect({
					condition: videoNodes.length === 1,
					message: `the scene has ${videoNodes.length} video nodes, expected 1`,
				});
				expect({
					condition: videoNodes[0].params.source.kind === "url",
					message: `the video node's source kind was ${videoNodes[0].params.source.kind}`,
				});
				return "a stored clip becomes a video node that reads over asset://";
			} finally {
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Saving an asset whose bytes are gone is refused",
		run: async () => {
			// An asset loaded from disk has no `File` to write back, so saving it
			// can only update metadata. If its bytes have since been deleted —
			// undoing a removal is how that happens — writing the metadata alone
			// would leave the project pointing at nothing. It has to fail loudly.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: { id: mediaId, name: "check.mp4", type: "video", file },
				});
				const loaded = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: loaded !== null,
					message: "the asset did not load back",
				});

				await storageService.deleteMediaAsset({ projectId, id: mediaId });

				let refused = false;
				try {
					await storageService.saveMediaAsset({
						projectId,
						mediaAsset: loaded!,
					});
				} catch {
					refused = true;
				}
				expect({
					condition: refused,
					message: "saving an asset with no stored bytes silently succeeded",
				});
				return "a metadata-only save with missing bytes throws instead of corrupting the project";
			} finally {
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Opening a project finishes loading",
		run: async () => {
			// The editor blocks on these two before it will render anything, so a
			// hang in either is an editor that spins on "Loading project…"
			// forever. Both are timed out rather than awaited indefinitely, so a
			// hang reports as a failure instead of hanging the checks too.
			const gpuMs = await timed({
				label: "initializeGpuRenderer",
				timeoutMs: 20_000,
				run: () => initializeGpuRenderer(),
			});

			const editor = EditorCore.getInstance();
			const projectId = await editor.project.createNewProject({
				name: "Desktop check",
			});
			try {
				const loadMs = await timed({
					label: "project.loadProject",
					timeoutMs: 20_000,
					run: () => editor.project.loadProject({ id: projectId }),
				});
				return `GPU init ${gpuMs}ms (available: ${isGpuAvailable()}), project load ${loadMs}ms`;
			} finally {
				await storageService.deleteProject({ id: projectId }).catch(() => {});
				await storageService
					.deleteProjectMedia({ projectId })
					.catch(() => {});
			}
		},
	},
	{
		name: "Loaded assets read through a URL, not a File",
		run: async () => {
			// A desktop asset carries a path and no `File`; everything that
			// decodes it has to reach for the URL. If this ever regresses to a
			// `File`, the bytes are back in memory.
			const source = createMediaSource({
				asset: { path: "/tmp/example", url: "asset://localhost/tmp/example" },
			});
			expect({
				condition: source?.kind === "url",
				message: `source kind was ${source?.kind}`,
			});
			const noSource = createMediaSource({ asset: {} });
			expect({
				condition: noSource === null,
				message: "an asset with no bytes produced a source",
			});
			return "path-backed assets resolve to a streaming URL";
		},
	},
	{
		name: "Canvas filter support is detected honestly",
		run: async () => {
			// Adjustments are a CSS filter string. WebKitGTK assigns `ctx.filter`,
			// reads it back, and then ignores it on every draw — so the panel moved
			// and the pixels didn't. The renderer now asks `supportsCanvasFilter()`
			// and sends the chain to the compositor when the answer is no.
			//
			// What has to hold is that the answer matches reality: claiming support
			// that isn't there puts adjustments back on a dead path, and denying
			// support that is there costs a blit for nothing. So measure the
			// property directly and compare it against what the app believes.
			const canvas = new OffscreenCanvas(8, 8);
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) throw new Error("no 2d context");

			ctx.fillStyle = "rgb(64, 64, 64)";
			ctx.fillRect(0, 0, 8, 8);
			const before = ctx.getImageData(0, 0, 1, 1).data[0];
			ctx.filter = "brightness(2)";
			ctx.fillRect(0, 0, 8, 8);
			const after = ctx.getImageData(0, 0, 1, 1).data[0];

			const measured = after > before + 32;
			const believed = supportsCanvasFilter();
			expect({
				condition: measured === believed,
				message: `supportsCanvasFilter() says ${believed}, but brightness(2) took ${before} to ${after}`,
			});

			return believed
				? `ctx.filter applies (${before} to ${after}); adjustments stay on the canvas path`
				: `ctx.filter is inert (stayed at ${after}); adjustments route to shader passes`;
		},
	},
	{
		name: "Effects that filter still filter here",
		run: async () => {
			// Adjustments route their filter chain to the compositor when
			// `ctx.filter` is inert, but effects cannot: Glow composites its blurred
			// copy back over the original mid-paint, which a pass on the finished
			// quad cannot express. So effects apply the chain on the canvas instead,
			// and this is the check that they actually do — before the fallback
			// existed, Blur was a no-op here and Glow washed the frame out.
			//
			// Driven through `paintEffectedLayer`, the same entry the renderer and
			// the panel's preview tiles use, so it fails if the fallback stops being
			// reached rather than only if the blur maths regress.
			// The check page never mounts the editor, so the registry the painter
			// looks effects up in is empty until this runs. Registering is idempotent.
			registerDefaultEffects();

			// Blur radii are written in units of the layer's short side, so an
			// effect reads the same on a 720p clip and a 4K one. That makes the
			// canvas size part of the expected answer: at 64px the radius would be
			// under three pixels and the edge would barely move.
			const width = 256;
			const height = 256;
			const source = new OffscreenCanvas(width, height);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no 2d context");
			// A hard black/white edge down the middle: a blur is exactly what turns
			// the two columns either side of it grey, and nothing else does.
			sourceCtx.fillStyle = "#000";
			sourceCtx.fillRect(0, 0, width, height);
			sourceCtx.fillStyle = "#fff";
			sourceCtx.fillRect(width / 2, 0, width / 2, height);

			const target = new OffscreenCanvas(width, height);
			const targetCtx = target.getContext("2d", { willReadFrequently: true });
			if (!targetCtx) throw new Error("no 2d context");

			paintEffectedLayer({
				ctx: targetCtx,
				source,
				width,
				height,
				effects: [
					{
						type: "blur",
						params: { amount: 1 },
						time: 0,
						progress: 0,
						animated: false,
					},
				],
			});

			// `amount: 1` on a 256px layer is a radius of ~11.5px, so ten pixels out
			// sits just under one standard deviation either side — around 50 and 205
			// for a working blur, against 0 and 255 for none. The thresholds sit well
			// inside that gap so the check fails on a dead filter, not on a few
			// percent of drift in the approximation.
			const row = height / 2;
			const offset = 10;
			const leftOfEdge = targetCtx.getImageData(width / 2 - offset, row, 1, 1)
				.data[0];
			const rightOfEdge = targetCtx.getImageData(width / 2 + offset, row, 1, 1)
				.data[0];

			expect({
				condition: leftOfEdge > 20,
				message: `blur left of the edge stayed at ${leftOfEdge}; the effect did nothing`,
			});
			expect({
				condition: rightOfEdge < 235,
				message: `blur right of the edge stayed at ${rightOfEdge}; the effect did nothing`,
			});

			const path = supportsCanvasFilter() ? "ctx.filter" : "canvas fallback";
			return `a blur effect softens a hard edge via the ${path} — ${leftOfEdge}/${rightOfEdge} either side, from 0/255`;
		},
	},
	{
		name: "A chroma key keeps up with playback",
		run: async () => {
			// The green screen is the one effect that must look at every pixel on
			// the CPU, so it sets the floor for how heavy an effect can get before
			// playback stops keeping up. It was doing that through helpers that
			// allocated two objects per pixel and called `Math.hypot`, which on a
			// 1080p frame is four million allocations and two million library calls
			// per frame — enough to drop playback to a slideshow. The current
			// loop is a difference key — projection onto the key colour line plus
			// perpendicular distance — with one square root only on the soft
			// band, and a despill pass that runs only on the kept branch.
			//
			// The budget is one frame at 30fps. That is deliberately loose: the point
			// is to catch a regression back into per-pixel allocation, not to pin the
			// current number, which varies with the machine.
			registerDefaultEffects();

			const width = 1920;
			const height = 1080;
			const source = new OffscreenCanvas(width, height);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no 2d context");
			sourceCtx.fillStyle = "#00d21e";
			sourceCtx.fillRect(0, 0, width, height);
			// A subject to keep, so the soft-edge branch is exercised too rather than
			// every pixel taking the cheap "plainly the key colour" path.
			sourceCtx.fillStyle = "#c88a5a";
			sourceCtx.beginPath();
			sourceCtx.arc(width / 2, height / 2, 320, 0, Math.PI * 2);
			sourceCtx.fill();
			// A spill-prone patch — yellow-shifted so the green channel sits above
			// the red/blue average, but far enough from the key line that the
			// difference key still keeps it. The despill pass must pull the
			// green back down; if it does not, this assertion fires.
			sourceCtx.fillStyle = "#d4dc78";
			sourceCtx.fillRect(
				width / 2 - 80,
				height / 2 + 360,
				160,
				160,
			);

			const target = new OffscreenCanvas(width, height);
			const targetCtx = target.getContext("2d", { willReadFrequently: true });
			if (!targetCtx) throw new Error("no 2d context");

			const definition = effectsRegistry.get("green-screen");
			const params = buildDefaultParamValues({ params: definition.params });
			const paintOnce = () => {
				definition.paint?.({
					ctx: targetCtx,
					source,
					width,
					height,
					params,
					time: 0,
					progress: 0,
				});
			};

			// One warm-up so the pooled surface exists and the loop is compiled.
			paintOnce();
			const runs = 5;
			const start = performance.now();
			for (let run = 0; run < runs; run += 1) paintOnce();
			const perFrame = (performance.now() - start) / runs;

			// The key must actually have keyed, or a fast no-op would pass.
			const corner = targetCtx.getImageData(4, 4, 1, 1).data[3];
			const middle = targetCtx.getImageData(width / 2, height / 2, 1, 1).data[3];
			expect({
				condition: corner === 0 && middle === 255,
				message: `the key did not cut out the backdrop — corner alpha ${corner}, subject alpha ${middle}`,
			});
			// Spill reduction must have pulled the green channel below what
			// was painted, on a pixel that the difference key kept. Without
			// the despill pass, the green of #d4dc78 (g=220) survives
			// untouched.
			const spill = targetCtx.getImageData(
				width / 2,
				height / 2 + 440,
				1,
				1,
			).data;
			expect({
				condition: spill[3] === 255 && spill[1] < 220,
				message: `the despill pass did not reduce the green spill — kept alpha ${spill[3]}, green ${spill[1]}`,
			});
			expect({
				condition: perFrame < 33,
				message: `a 1080p chroma key took ${perFrame.toFixed(1)}ms per frame, over the 33ms frame budget`,
			});

			return `a 1080p chroma key costs ${perFrame.toFixed(1)}ms per frame, inside the 33ms budget`;
		},
	},
	{
		name: "Adjustments run as shader passes",
		run: async () => {
			// The other half of the story: with `ctx.filter` inert, the adjustment
			// chain is translated into compositor passes instead. This drives the
			// real pipeline — the same wasm entry the renderer calls — so it fails
			// if the shader is missing, misnamed, or rejects its uniforms.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so there is no shader path",
			});

			const source = new OffscreenCanvas(8, 8);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no 2d context");
			sourceCtx.fillStyle = "rgb(64, 64, 64)";
			sourceCtx.fillRect(0, 0, 8, 8);

			const passes = buildAdjustmentFilterPasses({
				filter: "brightness(2)",
			});
			expect({
				condition: passes.length === 1 && passes[0].shader === "brightness",
				message: `the chain produced ${JSON.stringify(passes)}`,
			});

			const output = gpuRenderer.applyEffect({
				source,
				width: 8,
				height: 8,
				passes,
			});
			expect({
				condition: output !== source,
				message: "applyEffect handed back the source untouched",
			});

			const [red, , , alpha] = readPixelRgba({
				source: output,
				width: 8,
				height: 8,
			});

			expect({
				condition: red > 96,
				message: `brightness(2) on 64 produced ${red}`,
			});
			expect({
				condition: alpha > 250,
				message: `the pass dropped alpha to ${alpha}`,
			});

			// Every colour function, not just the one above: they share a shader
			// module and a uniform layout, so a mismatched entry point or an
			// unregistered pipeline key is a per-function failure that testing one
			// of them cannot see.
			const coloured = new OffscreenCanvas(8, 8);
			const colouredCtx = coloured.getContext("2d");
			if (!colouredCtx) throw new Error("no 2d context");
			// Saturated green: no colour function is a no-op on it, which a grey
			// patch would make saturate and hue-rotate look like.
			colouredCtx.fillStyle = "rgb(26, 230, 46)";
			colouredCtx.fillRect(0, 0, 8, 8);

			const inert: string[] = [];
			const moved: string[] = [];
			for (const filter of [
				"brightness(1.8)",
				"contrast(2)",
				"saturate(2)",
				"hue-rotate(90deg)",
				"invert(1)",
			]) {
				const chain = buildAdjustmentFilterPasses({ filter });
				expect({
					condition: chain.length === 1,
					message: `${filter} translated to ${JSON.stringify(chain)}`,
				});
				const graded = gpuRenderer.applyEffect({
					source: coloured,
					width: 8,
					height: 8,
					passes: chain,
				});
				const [r, g, b] = readPixelRgba({ source: graded, width: 8, height: 8 });
				const delta =
					Math.abs(r - 26) + Math.abs(g - 230) + Math.abs(b - 46);
				const label = `${filter}\u2192${r},${g},${b}`;
				(delta > 8 ? moved : inert).push(label);
			}
			expect({
				condition: inert.length === 0,
				message: `these colour functions left the pixel alone: ${inert.join(" ")} (the ones that moved it: ${moved.join(" ")})`,
			});

			return `brightness(2) took 64 to ${red}; every colour function moved a green pixel: ${moved.join(" ")}`;
		},
	},
	{
		name: "Masking a decoded frame keeps what was painted over it",
		run: async () => {
			// A wash, a vignette and a grain pass all fill past the layer's own
			// silhouette, so `keepSourceAlpha` re-imposes the source's alpha
			// afterwards. WebKitGTK draws a WebCodecs `VideoFrame` straight
			// through, ignoring the composite operation in force, so masking with
			// the frame itself repainted the frame over the overlay — and those
			// three Adjust sliders moved nothing on a video clip. The helper copies
			// a frame into a canvas for exactly this reason; what follows measures
			// the quirk and then the helper's answer to it.
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const source = new OffscreenCanvas(8, 8);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no source context");
			sourceCtx.fillStyle = "rgb(64, 64, 64)";
			sourceCtx.fillRect(0, 0, 8, 8);

			const surface = new OffscreenCanvas(8, 8);
			const ctx = surface.getContext("2d", { willReadFrequently: true });
			if (!ctx) throw new Error("no surface context");
			const frame = new VideoFrame(source, { timestamp: 0 });

			try {
				const washFrame = () => {
					ctx.globalCompositeOperation = "source-over";
					ctx.globalAlpha = 1;
					ctx.clearRect(0, 0, 8, 8);
					ctx.drawImage(frame, 0, 0, 8, 8);
					ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
					ctx.fillRect(0, 0, 8, 8);
				};
				const read = () => ctx.getImageData(0, 0, 1, 1).data;

				washFrame();
				const washed = read()[0];
				expect({
					condition: washed > 120,
					message: `a half-opacity red wash over 64 produced ${washed}`,
				});

				// The naive mask, recorded rather than asserted: this is the step
				// that is allowed to be broken, and knowing which engines break it is
				// what says whether the copy is still earning its keep.
				ctx.save();
				ctx.globalCompositeOperation = "destination-in";
				ctx.drawImage(frame, 0, 0, 8, 8);
				ctx.restore();
				const naive = read()[0];

				washFrame();
				keepSourceAlpha({ ctx, source: frame, width: 8, height: 8 });
				const [restored, , , alpha] = read();
				expect({
					condition: restored === washed,
					message: `the alpha restore took the wash from ${washed} to ${restored}, so it was painted over`,
				});
				expect({
					condition: alpha > 250,
					message: `the alpha restore dropped an opaque frame's alpha to ${alpha}`,
				});

				return naive === washed
					? `masking with the frame itself composites here; the wash survives at ${restored}`
					: `masking with the frame itself loses the wash (${washed} to ${naive}); through a canvas it survives at ${restored}`;
			} finally {
				frame.close();
			}
		},
	},
	{
		name: "A clip's first decoded frame composites on the frame it arrives",
		run: async () => {
			// What a cut does to the compositor: the outgoing clip's texture is
			// released and the incoming clip's is uploaded under an id that has
			// never been seen, all in the tick that has to draw it. If a brand-new
			// video-frame texture is not renderable until the *next* frame, every
			// cut shows one frame of the clear colour — the black flicker.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so there is nothing to composite",
			});
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const SIZE = 8;
			wasmCompositor.ensureInitialized({ width: SIZE, height: SIZE });
			const canvas = wasmCompositor.getCanvas();

			const source = new OffscreenCanvas(SIZE, SIZE);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no source context");
			sourceCtx.fillStyle = "rgb(240, 0, 0)";
			sourceCtx.fillRect(0, 0, SIZE, SIZE);

			// An id no frame has used, so the upload takes the create path rather
			// than reusing a texture the compositor already holds.
			const CHECK_OWNER = "check";
			const textureId = `${CHECK_OWNER}:first-frame-probe-${Date.now()}`;
			const frame = new VideoFrame(source, { timestamp: 0 });

			try {
				wasmCompositor.syncTextures({
					owner: CHECK_OWNER,
					textures: [
						{ kind: "video", id: textureId, source: frame, width: SIZE, height: SIZE },
					],
				});
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
					renderScale: 1,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId,
							transform: {
								centerX: SIZE / 2,
								centerY: SIZE / 2,
								width: SIZE,
								height: SIZE,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});

				const [red] = readPixelRgba({
					source: canvas,
					width: SIZE,
					height: SIZE,
				});

				expect({
					condition: red > 200,
					message: `a first-upload video texture composited ${red} where 240 was expected — this is the black frame at a cut`,
				});

				return `a never-seen video texture composited at ${red} on the frame it was uploaded`;
			} finally {
				// syncTextures took ownership of the frame; releasing the id closes it.
				wasmCompositor.syncTextures({ owner: CHECK_OWNER, textures: [] });
			}
		},
	},
	{
		name: "Uploading video at mixed sizes keeps one staging canvas",
		run: async () => {
			// Every decoded frame reaches the GPU by being drawn into a scratch
			// `OffscreenCanvas` and read back — and that canvas is sized by how many
			// pixels the layer covers, bucketed to 64, capped at the source's own
			// resolution. So it is not one size per session: it differs between two
			// clips of different resolutions or aspect ratios, and between two
			// layers on screen together.
			//
			// Held by an exact-size cache, the canvas and its 2D context were
			// therefore rebuilt at every cut between clips in different buckets —
			// some joins on a timeline and not the ones beside them, which is what
			// the reported stutter was — and on every single frame that composited
			// two such layers at once. There is no other way to see it: the cost is
			// an allocation, and an allocation inside a frame is a dropped frame and
			// nothing else. So count them.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing uploads",
			});
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const CHECK_OWNER = "staging-check";
			// Two sizes in different 64px buckets, alternating the way a timeline
			// cutting between a wide clip and a tall one does.
			const SIZES = [64, 192, 64, 192, 64, 192];

			const frames: VideoFrame[] = [];
			try {
				wasmCompositor.ensureInitialized({ width: 64, height: 64 });

				const upload = ({ size, index }: { size: number; index: number }) => {
					const source = new OffscreenCanvas(size, size);
					const ctx = source.getContext("2d");
					if (!ctx) throw new Error("no source context");
					ctx.fillStyle = "rgb(200, 0, 0)";
					ctx.fillRect(0, 0, size, size);
					const frame = new VideoFrame(source, { timestamp: index });
					frames.push(frame);
					// A fresh id each time, because a cut is exactly that: an id the
					// compositor has never held.
					wasmCompositor.syncTextures({
						owner: CHECK_OWNER,
						textures: [
							{
								kind: "video",
								id: `${CHECK_OWNER}:layer-${index}`,
								source: frame,
								width: size,
								height: size,
							},
						],
					});
				};

				// The first upload may or may not be this run's first — the checks
				// above have uploaded video too — so the baseline is read after one
				// upload has settled the canvas at the smaller size.
				upload({ size: SIZES[0]!, index: 0 });
				const before = videoStagingAllocations();

				for (let index = 1; index < SIZES.length; index += 1) {
					upload({ size: SIZES[index]!, index });
				}

				const built = videoStagingAllocations() - before;

				// One growth, to cover the larger size. Every size seen before is
				// free from then on, whichever order they arrive in.
				expect({
					condition: built <= 1,
					message: `${SIZES.length - 1} uploads alternating between ${
						SIZES[0]
					}px and ${SIZES[1]}px built ${built} staging canvases; at most one growth was expected, so the canvas is being replaced per upload again`,
				});

				return `alternating ${SIZES.length} uploads between two size buckets built ${built} staging canvas beyond the first`;
			} finally {
				wasmCompositor.syncTextures({ owner: CHECK_OWNER, textures: [] });
				for (const frame of frames) {
					try {
						frame.close();
					} catch {
						// syncTextures may have closed it already.
					}
				}
			}
		},
	},
	{
		name: "A reduced render scale draws the same picture at fewer pixels",
		run: async () => {
			// Playback resolution rests on one property: the frame's geometry is in
			// canvas units, so halving `renderScale` has to produce the *same
			// picture* on a smaller raster — not a crop, not a shifted quad, not a
			// layer at the wrong size. Nothing else covers it: `tsc` cannot see it,
			// and on screen a quarter-size offset reads as "the preview looks a bit
			// off" rather than as a failure.
			//
			// This also drives the direct-composite path — a `normal` layer with no
			// effects and no mask now blends straight onto the scene rather than
			// through the blend shader — and the surface reconfigure that changing
			// scale forces on WebGL.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so there is nothing to composite",
			});

			const CANVAS = 64;
			const OWNER = "scale-check";
			const fieldId = `${OWNER}:field`;
			const patchId = `${OWNER}:patch`;

			const solid = ({ color }: { color: string }): OffscreenCanvas => {
				const surface = new OffscreenCanvas(8, 8);
				const ctx = surface.getContext("2d");
				if (!ctx) throw new Error("no 2d context");
				ctx.fillStyle = color;
				ctx.fillRect(0, 0, 8, 8);
				return surface;
			};

			// A red field over the whole canvas and a green patch in the top-left
			// quarter of it. The patch is off-centre on purpose: a scale that got
			// applied to the geometry as well as to the raster would move it.
			const field = solid({ color: "rgb(240, 0, 0)" });
			const patch = solid({ color: "rgb(0, 240, 0)" });

			const renderAtScale = ({
				renderScale,
			}: {
				renderScale: number;
			}): { size: number; corner: number[]; centre: number[] } => {
				wasmCompositor.ensureInitialized({
					width: CANVAS * renderScale,
					height: CANVAS * renderScale,
				});
				wasmCompositor.syncTextures({
					owner: OWNER,
					textures: [
						{ kind: "external", id: fieldId, source: field, width: 8, height: 8 },
						{ kind: "external", id: patchId, source: patch, width: 8, height: 8 },
					],
				});
				wasmCompositor.render({
					width: CANVAS,
					height: CANVAS,
					renderScale,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId: fieldId,
							transform: {
								centerX: CANVAS / 2,
								centerY: CANVAS / 2,
								width: CANVAS,
								height: CANVAS,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
						{
							type: "layer",
							textureId: patchId,
							transform: {
								centerX: CANVAS / 4,
								centerY: CANVAS / 4,
								width: CANVAS / 2,
								height: CANVAS / 2,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});

				const canvas = wasmCompositor.getCanvas();
				const size = canvas.width;
				// Read straight after the render: a GPU-drawn canvas is only
				// reliably readable until the browser next composites it.
				const data = readFullFrameRgba({
					source: canvas,
					width: size,
					height: size,
				});
				const pixelAt = ({ fx, fy }: { fx: number; fy: number }): number[] => {
					const x = Math.min(size - 1, Math.floor(fx * size));
					const y = Math.min(size - 1, Math.floor(fy * size));
					const offset = (y * size + x) * 4;
					return [data[offset], data[offset + 1], data[offset + 2]];
				};
				return {
					size,
					// Inside the green patch, and well outside it.
					corner: pixelAt({ fx: 0.15, fy: 0.15 }),
					centre: pixelAt({ fx: 0.75, fy: 0.75 }),
				};
			};

			try {
				const full = renderAtScale({ renderScale: 1 });
				const half = renderAtScale({ renderScale: 0.5 });

				expect({
					condition: full.size === CANVAS,
					message: `full scale drew a ${full.size}px canvas, not ${CANVAS}px`,
				});
				expect({
					condition: half.size === CANVAS / 2,
					message: `half scale drew a ${half.size}px canvas, not ${CANVAS / 2}px`,
				});

				expect({
					condition: full.corner[1] > 200 && full.corner[0] < 80,
					message: `the patch did not land in the top-left quarter at full scale: ${full.corner.join(",")}`,
				});
				expect({
					condition: full.centre[0] > 200 && full.centre[1] < 80,
					message: `the field did not show through outside the patch at full scale: ${full.centre.join(",")}`,
				});

				// The same two probes, on a raster with a quarter of the pixels.
				expect({
					condition: half.corner[1] > 200 && half.corner[0] < 80,
					message: `the patch moved or resized at half scale: ${half.corner.join(",")} against ${full.corner.join(",")}`,
				});
				expect({
					condition: half.centre[0] > 200 && half.centre[1] < 80,
					message: `the field moved at half scale: ${half.centre.join(",")} against ${full.centre.join(",")}`,
				});

				return `half scale drew ${half.size}px against ${full.size}px with the layers in the same places`;
			} finally {
				wasmCompositor.syncTextures({ owner: OWNER, textures: [] });
				wasmCompositor.ensureInitialized({ width: CANVAS, height: CANVAS });
			}
		},
	},
	{
		name: "The preview canvas holds its picture on a frame nothing renders",
		run: async () => {
			// The preview renders on a rAF loop and skips any tick where the
			// previous render is still in flight — which is exactly what happens at
			// a cut, where the incoming clip's decoder has to seek or initialise. If
			// the compositor's canvas does not retain its last frame, every skipped
			// tick shows through as a black flash at precisely those moments.
			//
			// WebGL clears the drawing buffer after compositing unless asked not to,
			// so this is engine-specific and worth measuring rather than assuming.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so there is nothing to composite",
			});

			const SIZE = 8;
			wasmCompositor.ensureInitialized({ width: SIZE, height: SIZE });
			const canvas = wasmCompositor.getCanvas();

			const source = new OffscreenCanvas(SIZE, SIZE);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no source context");
			sourceCtx.fillStyle = "rgb(240, 0, 0)";
			sourceCtx.fillRect(0, 0, SIZE, SIZE);

			wasmCompositor.syncTextures({
				owner: "check",
				textures: [
				{
					kind: "rendered",
					id: "check:retention-probe",
					contentHash: "retention-probe",
					width: SIZE,
					height: SIZE,
					draw: (ctx) => {
						ctx.drawImage(source, 0, 0);
					},
				},
				],
			});
			wasmCompositor.render({
				width: SIZE,
				height: SIZE,
				renderScale: 1,
				// Black, so a lost frame reads as the flicker the user sees.
				clear: { color: [0, 0, 0, 1] },
				items: [
					{
						type: "layer",
						textureId: "check:retention-probe",
						transform: {
							centerX: SIZE / 2,
							centerY: SIZE / 2,
							width: SIZE,
							height: SIZE,
							rotationDegrees: 0,
							flipX: false,
							flipY: false,
						},
						opacity: 1,
						blendMode: "normal",
						effectPassGroups: [],
						mask: null,
					},
				],
			});

			const readCanvas = () =>
				readPixelRgba({ source: canvas, width: SIZE, height: SIZE });

			const [immediateRed] = readCanvas();
			expect({
				condition: immediateRed > 200,
				message: `the compositor drew ${immediateRed} where 240 was expected, so this probe never worked`,
			});

			// Two frames with no render at all — the skipped ticks a slow decode
			// causes.
			await new Promise((resolve) => requestAnimationFrame(resolve));
			await new Promise((resolve) => requestAnimationFrame(resolve));
			const [heldRed] = readCanvas();

			// Recorded rather than asserted: whether the canvas retains is the
			// engine's business. Knowing the answer is what says whether a skipped
			// render can flash black here.
			return heldRed > 200
				? `held its picture across 2 idle frames (${heldRed}); a skipped render cannot flash black`
				: `LOST its picture across 2 idle frames (${immediateRed} to ${heldRed}); a skipped render flashes the clear colour`;
		},
	},
	{
		name: "Cropping a decoded frame keeps only the kept pixels",
		run: async () => {
			// WebKitGTK draws a WebCodecs `VideoFrame` straight through, and that
			// includes ignoring `drawImage`'s source rectangle: cropping a frame
			// directly handed back the whole picture squeezed into the cropped box
			// rather than the quarter that was kept, which read as the clip being
			// squished instead of cropped. `drawCropped` positions the frame instead
			// of sub-recting it for exactly this reason; what follows measures the
			// quirk, and the check below measures the answer to it.
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const frame = quadrantFrame({ size: 8 });
			try {
				// Reads the kept bottom-right quadrant (4..8, 4..8) from `from` into a
				// fresh 4x4 canvas and reports the first pixel.
				const readCorner = ({ from }: { from: CanvasImageSource }) => {
					const canvas = new OffscreenCanvas(4, 4);
					const ctx = canvas.getContext("2d", { willReadFrequently: true });
					if (!ctx) throw new Error("no readback context");
					ctx.drawImage(from, 4, 4, 4, 4, 0, 0, 4, 4);
					return ctx.getImageData(0, 0, 1, 1).data[0];
				};

				// Recorded rather than asserted: whether this engine honours a source
				// rect on a frame is its business, and knowing the answer is what says
				// whether the copy is still earning its keep.
				const direct = readCorner({ from: frame });

				const copied = new OffscreenCanvas(8, 8);
				const copiedCtx = copied.getContext("2d");
				if (!copiedCtx) throw new Error("no copy context");
				copiedCtx.drawImage(frame, 0, 0, 8, 8);
				const viaCanvas = readCorner({ from: copied });

				expect({
					condition: viaCanvas > 220,
					message: `cropping through a canvas read ${viaCanvas} where the kept quadrant is 240`,
				});

				return direct > 220
					? `this engine honours a source rect on a frame (${direct}); the offset form cropped clips use is belt and braces`
					: `a source rect on a frame lands on the wrong pixels here (${direct} instead of 240), which is why a cropped clip is drawn at an offset instead; through a canvas it reads ${viaCanvas}`;
			} finally {
				frame.close();
			}
		},
	},
	{
		name: "A frame drawn at a negative offset crops to the kept pixels",
		run: async () => {
			// How every cropped clip now reaches the GPU. A decoded frame cannot be
			// sub-rected on the way in — the check above measures this engine
			// ignoring `drawImage`'s source rectangle on a `VideoFrame` — so the crop
			// is expressed as geometry instead: draw the whole frame shifted up and
			// left by the crop origin into a canvas the size of the kept region, and
			// let the canvas clip away the rest.
			//
			// That replaced copying the frame whole onto a full-resolution canvas and
			// sub-recting the copy, which cost a clear and a blit at the source's own
			// size on every frame of every cropped clip, to produce a region usually
			// smaller than the copy. The saving is only real if the destination
			// offset is honoured where the source rectangle is not — two different
			// parts of one call, which this engine already treats differently, so it
			// is measured rather than reasoned about.
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const frame = quadrantFrame({ size: 8 });
			try {
				// Keeping the bottom-right quadrant: a 4x4 canvas with the frame drawn
				// at (-4, -4) at its natural size, which is exactly what `drawCropped`
				// does for a clip cropped to its lower right.
				const kept = new OffscreenCanvas(4, 4);
				const keptCtx = kept.getContext("2d", { willReadFrequently: true });
				if (!keptCtx) throw new Error("no readback context");
				keptCtx.drawImage(frame, -4, -4, 8, 8);

				const origin = keptCtx.getImageData(0, 0, 1, 1).data[0] ?? -1;
				expect({
					condition: origin > 220,
					message: `a frame drawn at (-4, -4) read ${origin} at the origin where the kept quadrant is 240, so the destination offset is being ignored and a cropped clip would show the wrong part of the picture`,
				});

				// The far corner as well, so a draw that happened to land the right
				// colour at the origin but at the wrong scale cannot pass.
				const far = keptCtx.getImageData(3, 3, 1, 1).data[0] ?? -1;
				expect({
					condition: far > 220,
					message: `the kept quadrant read ${far} at its far corner instead of 240, so the frame landed at the wrong scale`,
				});

				return `a frame drawn at (-4, -4) crops to the kept quadrant (${origin} at the origin, ${far} at its far corner)`;
			} finally {
				frame.close();
			}
		},
	},
	{
		name: "A scaled VideoFrame draw fills the staging canvas",
		run: async () => {
			// `import_video_frame_texture` uploads a decoded frame at the size of the
			// quad it will fill rather than at its own, which leans on `drawImage`
			// honouring the destination width and height for a `VideoFrame` source.
			// This engine already ignores the *source* rectangle on one — see the crop
			// check above — so the destination form cannot be assumed to work by
			// analogy. Were it ignored too, the frame would land at native size and a
			// smaller staging canvas would keep only its top-left corner, silently
			// cropping every video layer in the preview instead of scaling it.
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			const frame = quadrantFrame({ size: 16 });
			try {
				const staging = new OffscreenCanvas(8, 8);
				const stagingCtx = staging.getContext("2d", {
					willReadFrequently: true,
				});
				if (!stagingCtx) throw new Error("no staging context");
				stagingCtx.drawImage(frame, 0, 0, 8, 8);

				// Quadrant centres in the scaled result, well clear of the seams so
				// filtering cannot muddy the reading.
				const readRed = ({ x, y }: { x: number; y: number }) =>
					stagingCtx.getImageData(x, y, 1, 1).data[0];
				const topLeft = readRed({ x: 1, y: 1 });
				const topRight = readRed({ x: 6, y: 1 });
				const bottomLeft = readRed({ x: 1, y: 6 });
				const bottomRight = readRed({ x: 6, y: 6 });

				// The discriminator: at native size this 8x8 canvas would hold nothing
				// but the 0-red top-left quadrant.
				expect({
					condition: bottomRight > 200,
					message: `a scaled draw left ${bottomRight} in the bottom-right corner where the frame's own corner is 240 — the destination size was ignored, so video layers would be cropped rather than scaled`,
				});
				expect({
					condition: topRight > 40 && topRight < 130,
					message: `top-right read ${topRight}, expected about 80`,
				});
				expect({
					condition: bottomLeft > 120 && bottomLeft < 210,
					message: `bottom-left read ${bottomLeft}, expected about 160`,
				});

				return `a 16x16 frame scaled into an 8x8 canvas kept all four quadrants (${topLeft}, ${topRight}, ${bottomLeft}, ${bottomRight} against 0, 80, 160, 240)`;
			} finally {
				frame.close();
			}
		},
	},
	{
		name: "Adjusting a clip during playback leaves its audio streamable",
		run: async () => {
			// The reported bug, driven end to end: play, then notify the timeline
			// the way an adjustment slider does — once per frame — and check that
			// nothing concluded the source cannot be streamed. That conclusion is
			// permanent for the session and demotes the clip to being decoded
			// whole, which for a real recording is seconds and gigabytes per
			// attempt and reads as the audio stopping for good.
			const editor = EditorCore.getInstance();
			const file = await encodeProbeClip({ seconds: 6 });
			const projectId = await editor.project.createNewProject({
				name: "Audio adjust check",
			});

			try {
				await editor.project.loadProject({ id: projectId });
				const asset = await editor.media.addMediaAsset({
					projectId,
					asset: {
						name: "probe.mp4",
						type: "video",
						file,
						width: 64,
						height: 64,
						duration: 6,
					},
				});
				expect({
					condition: asset !== null,
					message: "the probe asset did not save",
				});

				const duration = mediaTimeFromSeconds({ seconds: 6 });
				const elementId = crypto.randomUUID();
				const trackId = "main";
				editor.timeline.updateTracks({
					overlay: [],
					audio: [],
					main: {
						id: trackId,
						name: "Main",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: elementId,
								name: "probe.mp4",
								type: "video",
								mediaId: asset!.id,
								duration,
								startTime: ZERO_MEDIA_TIME,
								trimStart: ZERO_MEDIA_TIME,
								trimEnd: ZERO_MEDIA_TIME,
								params: {},
							},
						],
					},
				});

				// Silenced before the clock starts. Everything this check is about
				// happens upstream of the master gain — the sinks open, the clips
				// stream, the adjustment tears them down — so a zero level costs no
				// coverage, and the alternative is a self-check run that hums a
				// probe tone at whoever is running it.
				editor.playback.setVolume({ volume: 0 });

				const before = editor.audio.getDiagnostics();
				editor.playback.play();
				// Long enough for a sink to open and a read to be in flight, which
				// is the state the teardown has to survive.
				await pause({ ms: 900 });
				const started = editor.audio.getDiagnostics();

				// An adjustment drag, at frame rate.
				for (let frame = 0; frame < 30; frame++) {
					editor.timeline.updateElements({
						updates: [
							{
								trackId,
								elementId,
								patch: { params: { brightness: 1 + frame / 100 } },
							},
						],
					});
					await pause({ ms: 16 });
				}

				await pause({ ms: 400 });
				const after = editor.audio.getDiagnostics();
				editor.playback.pause();
				await pause({ ms: 100 });

				const leaked =
					after.inputsOpened - after.inputsDisposed - after.openInputs;

				// First that the check is exercising anything: audio has to have
				// actually streamed and the adjustment has to have torn the sinks
				// down. Without both, everything below passes by not happening.
				expect({
					condition: started.activeClips > 0 || after.activeClips > 0,
					message:
						"no clip ever started streaming, so this check proves nothing about adjusting during playback",
				});
				expect({
					condition: after.sinkGeneration > started.sinkGeneration,
					message:
						"the adjustment tore nothing down, so this check is not exercising the path it is about",
				});

				// The reported failure. Each leaked `Input` holds an open read on
				// the file; before the sink opens were deduplicated, 30
				// adjustment frames opened 62 of them and tracked one.
				expect({
					condition: leaked === 0,
					message: `${leaked} decoder input(s) were left open by 30 adjustment frames, which is what runs the audio out of handles on a long recording`,
				});
				expect({
					condition: after.unstreamableSources === before.unstreamableSources,
					message: `${after.unstreamableSources - before.unstreamableSources} source(s) were demoted to whole-file decoding by an adjustment, which for a long recording is seconds and gigabytes per play`,
				});

				// The adjustment moved a clip, not its source. Opening a stream
				// means asking the shell to decode the whole track to disk, so
				// tearing them down per notification — which is what this used to
				// do — spent that on every frame of the drag. One source, so at
				// most one decode for the whole check.
				const decodes = after.inputsOpened - before.inputsOpened;
				expect({
					condition: decodes <= 1,
					message: `${decodes} whole-track decodes were started for one source across 30 adjustment frames (${after.openInputs} held, ${after.inputsDisposed - before.inputsDisposed} released); the source never changed, so the stream should have been kept`,
				});

				return `active=${after.activeClips} teardowns=${after.sinkGeneration - started.sinkGeneration} demoted=${after.unstreamableSources} opened=${after.inputsOpened} disposed=${after.inputsDisposed} tracked=${after.openInputs} leaked=${leaked}`;
			} finally {
				editor.playback.pause();
				await storageService.deleteProject({ id: projectId }).catch(() => {});
				await storageService
					.deleteProjectMedia({ projectId })
					.catch(() => {});
			}
		},
	},
	{
		name: "A decoder torn down under a reader fails as cancellation",
		run: async () => {
			// The shape of a real bug: adjusting a clip during playback notifies
			// per frame, every notification disposes the audio sinks, and a read
			// in flight when that happens throws. The audio manager used to read
			// that throw as "this codec cannot be streamed" — permanent, and for
			// an hour-long source it meant decoding the whole thing on every
			// attempt to play it, which reads as the audio simply stopping until
			// the app is restarted.
			//
			// Two things are pinned here: that disposing under a live reader
			// really does fail the read, so the hazard is not imaginary, and that
			// letting the reader go first does not.
			const file = await encodeProbeClip({ seconds: 4 });
			const fixture = await scratchMediaRef({ file, extension: "mp4" });

			const openStream = async () => {
				const stream = await NativeAudioStream.open({
					ref: fixture.ref,
					createBuffer: createEmptyAudioBuffer,
				});
				expect({
					condition: stream !== null,
					message: "the probe clip produced no audio stream",
				});
				return stream!;
			};

			try {
				// Closed mid-read, which used to be the hazard itself: the stream
				// read windows out of a whole-track PCM decode staged on disk, and
				// closing deleted it underneath any reader still going. Playback
				// now decodes each window on demand and stages nothing, so
				// `close` has nothing to delete and this can no longer fail for
				// that reason. Still driven, because what matters is that the
				// teardown order the manager uses is safe — whichever way this
				// engine answers.
				const yanked = await openStream();
				const yankedIterator = yanked.buffers(0)[Symbol.asyncIterator]();
				await yankedIterator.next();
				await yanked.close();
				let failedAfterClose = false;
				try {
					for (let i = 0; i < 64; i++) {
						const next = await yankedIterator.next();
						if (next.done) break;
					}
				} catch {
					failedAfterClose = true;
				}

				// Released first: the same teardown, in the order the manager
				// uses, must not fail anything.
				const released = await openStream();
				const releasedIterator = released.buffers(0)[Symbol.asyncIterator]();
				await releasedIterator.next();
				let failedAfterRelease = false;
				try {
					await releasedIterator.return?.();
					await released.close();
				} catch {
					failedAfterRelease = true;
				}

				expect({
					condition: !failedAfterRelease,
					message:
						"returning a reader before closing its stream threw, so the safe teardown order is not safe here",
				});

				return failedAfterClose
					? "closing under a live reader fails the read; returning it first does not"
					: "this engine tolerates closing under a live reader; returning it first is still the order used";
			} finally {
				await tauriRemoveFile({ path: fixture.path }).catch(() => {});
			}
		},
	},
	{
		name: "Audio decodes through the shell, sample for sample",
		run: async () => {
			// The shell decodes audio with ffmpeg, and it is the only route
			// there is. So this compares what comes back against the samples
			// the fixture was *written* with, rather than against a second
			// decoder's opinion — which is the stronger claim anyway, and the
			// only honest one left now that there is no second decoder.
			//
			// PCM in a hand-written WAV is the fixture on purpose: it
			// round-trips exactly, so a difference here is this code rather
			// than a lossy codec's priming.
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			// Over 4M frames, so a channel is read in more than one range
			// request. A single-request fixture would never exercise the
			// chunked read that keeps an hour-long track from being held in the
			// page whole, and getting an offset wrong there writes the head of
			// the file over itself — which sounds like a stutter, not a bug.
			const seconds = 120;
			const sampleRate = 44100;
			const file = await encodeToneWav({ seconds, sampleRate });

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: { id: mediaId, name: "check.wav", type: "audio", file },
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				const stored = createMediaSource({ asset: asset! });
				expect({
					condition: stored?.kind === "url" && Boolean(stored.path),
					message: "the stored asset produced no native path to decode from",
				});

				const before = getNativeAudioStats();
				const native = await decodeAudioBufferFromRef({ ref: stored! });
				const after = getNativeAudioStats();
				expect({
					condition: native !== null,
					message: "the shell decoded nothing",
				});
				expect({
					condition: after.buffers === before.buffers + 1,
					message:
						"the decode fell back to the in-page route, so this check compared it against itself",
				});

				expect({
					condition: native!.sampleRate === sampleRate,
					message: `asked for ${sampleRate}Hz, decoded at ${native!.sampleRate}Hz`,
				});
				// A frame either way: a container's declared duration routinely
				// runs a little past its last sample.
				const expectedFrames = seconds * sampleRate;
				expect({
					condition: Math.abs(native!.length - expectedFrames) <= 2,
					message: `decoded ${native!.length} frames against the ${expectedFrames} written`,
				});

				const frames = Math.min(native!.length, expectedFrames);
				let worst = 0;
				let worstFrame = -1;
				for (let channel = 0; channel < native!.numberOfChannels; channel++) {
					const decoded = native!.getChannelData(channel);
					for (let frame = 0; frame < frames; frame++) {
						// What the fixture writer put in this slot, quantised
						// the same way it quantised it.
						const written =
							Math.max(
								-32768,
								Math.min(
									32767,
									Math.round(
										toneSampleAt({
											frame,
											frameCount: expectedFrames,
											sampleRate,
										}) * 32767,
									),
								),
							) / 32767;
						const delta = Math.abs(decoded[frame]! - written);
						if (delta > worst) {
							worst = delta;
							worstFrame = frame;
						}
					}
				}
				// 16-bit PCM quantises at 1/32768; anything under half a step is
				// the same sample read back.
				expect({
					condition: worst < 1 / 65536,
					message: `frame ${worstFrame} came back ${worst} away from what was written`,
				});

				return `${frames} frames × ${native!.numberOfChannels}ch decoded by the shell, matching the written samples to ${worst.toExponential(1)}`;
			} finally {
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "A waveform still filling reports its full geometry",
		run: async () => {
			// The summary is handed out while it is still being read, and what a
			// clip paints from it is decided by four numbers: the sample rate, the
			// total samples, the bucket size and how many buckets there are. If a
			// partial reported any of those smaller than the finished summary
			// does, a clip that painted from it would draw a waveform that stops
			// short — and a zoom, which repaints from whatever partial is current,
			// would show the short version.
			//
			// So the rule is that only the *contents* fill in. The geometry is
			// settled from the first chunk and never moves.
			// Long enough that the read crosses several progress ticks, so this
			// compares a run of partials rather than the single one a short
			// fixture produces before the first tick is even due.
			const seconds = 240;
			const file = await encodeToneWav({ seconds, sampleRate: 44100 });
			const fixture = await scratchMediaRef({ file, extension: "wav" });
			const shapes: Array<{
				sampleRate: number;
				totalSamples: number;
				bucketSize: number;
				buckets: number;
				revision: number;
			}> = [];

			const final = await buildSourceWaveformSummaryFromRef({
				sourceKey: "check:waveform-geometry",
				ref: fixture.ref,
				onProgress: (partial) => {
					shapes.push({
						sampleRate: partial.sampleRate,
						totalSamples: partial.totalSamples,
						bucketSize: partial.bucketSize,
						buckets: partial.amplitudes.length,
						revision: partial.revision,
					});
				},
			});
			expect({
				condition: final !== null,
				message: "the fixture produced no summary",
			});
			expect({
				condition: shapes.length > 0,
				message:
					"no partial was ever handed out, so this check proves nothing about drawing from one",
			});

			const wrong = shapes.findIndex(
				(shape) =>
					shape.sampleRate !== final!.sampleRate ||
					shape.totalSamples !== final!.totalSamples ||
					shape.bucketSize !== final!.bucketSize ||
					shape.buckets !== final!.amplitudes.length,
			);
			expect({
				condition: wrong === -1,
				message:
					wrong === -1
						? ""
						: `partial ${wrong} reported ${shapes[wrong].buckets} buckets / ${shapes[wrong].totalSamples} samples at ${shapes[wrong].sampleRate}Hz against the finished ${final!.amplitudes.length} / ${final!.totalSamples} at ${final!.sampleRate}Hz, so a clip painting from it draws a short waveform`,
			});

			expect({
				condition: final!.revision > shapes[shapes.length - 1].revision,
				message:
					"the finished summary did not outrank its last partial, so a clip that cached its paint would keep the partial",
			});

			return `${shapes.length} partials, all ${final!.amplitudes.length} buckets / ${final!.totalSamples} samples, revisions ${shapes[0].revision}..${final!.revision}`;
		},
	},
	{
		name: "A stored waveform comes back the same shape",
		run: async () => {
			// Reading a source is the slow part and its answer never changes, so
			// the summary is kept between sessions. What matters is that what
			// comes back is usable without qualification: same geometry, and
			// peaks close enough that the drawn bars are indistinguishable. The
			// peaks are companded into a byte each on the way in, so "close
			// enough" rather than "identical" is the honest bar.
			const seconds = 8;
			const sampleRate = 44100;
			const file = await encodeToneWav({ seconds, sampleRate, toneHz: 440 });
			const fixture = await scratchMediaRef({ file, extension: "wav" });
			const sourceKey = `check:waveform-store:${crypto.randomUUID()}`;
			const built = await buildSourceWaveformSummaryFromRef({
				sourceKey,
				ref: fixture.ref,
			});
			expect({
				condition: built !== null,
				message: "the fixture produced no summary to store",
			});

			try {
				await storeWaveform({ summary: built! });
				const loaded = await loadStoredWaveform({
					sourceKey,
					bucketSize: built!.bucketSize,
				});
				expect({
					condition: loaded !== null,
					message: "a summary written to the store did not read back",
				});
				expect({
					condition:
						loaded!.sampleRate === built!.sampleRate &&
						loaded!.totalSamples === built!.totalSamples &&
						loaded!.bucketSize === built!.bucketSize &&
						loaded!.amplitudes.length === built!.amplitudes.length,
					message: `stored geometry differs: ${loaded!.sampleRate}Hz/${loaded!.totalSamples}/${loaded!.bucketSize}/${loaded!.amplitudes.length} against ${built!.sampleRate}Hz/${built!.totalSamples}/${built!.bucketSize}/${built!.amplitudes.length}`,
				});

				let worst = 0;
				let peak = 0;
				for (let i = 0; i < built!.amplitudes.length; i++) {
					const delta = Math.abs(loaded!.amplitudes[i] - built!.amplitudes[i]);
					if (delta > worst) worst = delta;
					if (built!.amplitudes[i] > peak) peak = built!.amplitudes[i];
				}
				expect({
					condition: worst <= 0.01,
					message: `a stored bucket came back ${worst.toFixed(4)} away from what was written, which is visible at bar heights`,
				});

				// A source that clips reads above 1.0 and the timeline paints those
				// bars differently, so the ceiling has to survive the round trip
				// rather than being clamped away.
				const clipped: SourceWaveformSummary = {
					...built!,
					sourceKey: `${sourceKey}:clipped`,
					amplitudes: Float32Array.from([0.1, 1.8, 0.4]),
				};
				await storeWaveform({ summary: clipped });
				const loadedClipped = await loadStoredWaveform({
					sourceKey: clipped.sourceKey,
					bucketSize: clipped.bucketSize,
				});
				expect({
					condition:
						loadedClipped !== null &&
						Math.abs(loadedClipped.amplitudes[1] - 1.8) <= 0.02,
					message: `a peak of 1.8 came back as ${loadedClipped?.amplitudes[1]?.toFixed(3) ?? "nothing"}, so clipping is lost`,
				});

				await forgetStoredWaveform({ sourceKey });
				const gone = await loadStoredWaveform({
					sourceKey,
					bucketSize: built!.bucketSize,
				});
				expect({
					condition: gone === null,
					message: "a forgotten summary still read back, so removing media leaves its peaks behind",
				});

				return `${built!.amplitudes.length} buckets round-tripped within ${worst.toFixed(4)} (peak ${peak.toFixed(3)}), clipping preserved, forget cleared it`;
			} finally {
				await forgetStoredWaveform({ sourceKey });
				await forgetStoredWaveform({ sourceKey: `${sourceKey}:clipped` });
			}
		},
	},
	{
		name: "A waveform is summarised without holding the whole track",
		run: async () => {
			// A waveform is drawn straight from the timeline, so a clip merely
			// being on screen asks for one. Answering it by decoding the source to
			// an `AudioBuffer` first costs `duration * rate * channels * 4` bytes
			// three times over — the chunks, the channel arrays they are laid
			// into, and the buffer copied out of those. On the hour-long
			// recordings this editor is meant to cut that is gigabytes and a
			// visible stall, which is the whole reason the summary streams.
			//
			// Both halves matter, so both are checked: that the stream really
			// arrives in pieces, and that reducing it piecewise gives the same
			// answer as the buffered route it replaced.
			// PCM, not the AAC probe clip. A lossy encoder's priming and its
			// flush decide how many samples come back out, and this check is
			// about the summariser rather than about the codec: measured here,
			// re-encoded AAC returns 0.865 of its own declared sample count and
			// spans 0.955 of its duration, which would make the comparison below
			// a test of the encoder's tail handling. PCM round-trips exactly, so
			// a difference between the two summaries is the summariser's.
			const seconds = 20;
			const sampleRate = 44100;
			const file = await encodeToneWav({ seconds, sampleRate, toneHz: 440 });
			const fixture = await scratchMediaRef({ file, extension: "wav" });
			const ref = fixture.ref;
			const sourceKey = "check:waveform-stream";

			// A summary is handed out as it fills so the clip draws something
			// straight away. Recorded rather than asserted on cadence — how many
			// slices a 20s tone takes is the decoder's business — but it has to
			// arrive in more than one piece and never go backwards, or the
			// consumer's repaint cache will sit on a stale paint.
			const revisions: number[] = [];
			const streamed = await buildSourceWaveformSummaryFromRef({
				sourceKey,
				ref,
				onProgress: (partial) => revisions.push(partial.revision),
			});
			expect({
				condition: revisions.every(
					(revision, index) => index === 0 || revision > revisions[index - 1],
				),
				message: `progress revisions went backwards: ${revisions.join(", ")}`,
			});
			expect({
				condition:
					streamed === null ||
					revisions.length === 0 ||
					streamed.revision > revisions[revisions.length - 1],
				message: "the finished summary did not outrank its last partial, so a cached paint would never refresh",
			});

			const buffer = await decodeAudioBufferFromRef({ ref });
			expect({
				condition: buffer !== null,
				message: "the probe clip would not decode at all",
			});
			const buffered = await buildSourceWaveformSummary({
				sourceKey,
				buffer: buffer!,
			});

			expect({
				condition: streamed!.sampleRate === buffered.sampleRate,
				message: `streamed at ${streamed!.sampleRate}Hz, buffered at ${buffered.sampleRate}Hz — the seconds-to-samples mapping would disagree`,
			});
			expect({
				condition: streamed!.bucketSize === buffered.bucketSize,
				message: "the two routes bucketed at different sizes",
			});
			// A stream that runs a frame past the container's declared duration
			// keeps the bucket it landed in, where the buffered route clamps it
			// away. One bucket is 128 samples and cannot be seen; more than that
			// means the two routes disagree about where the audio is.
			expect({
				condition:
					Math.abs(streamed!.amplitudes.length - buffered.amplitudes.length) <=
					1,
				message: `streamed ${streamed!.amplitudes.length} buckets against ${buffered.amplitudes.length} buffered`,
			});

			const shared = Math.min(
				streamed!.amplitudes.length,
				buffered.amplitudes.length,
			);
			let worstDelta = 0;
			let worstBucket = -1;
			for (let i = 0; i < shared; i++) {
				const delta = Math.abs(
					streamed!.amplitudes[i] - buffered.amplitudes[i],
				);
				if (delta > worstDelta) {
					worstDelta = delta;
					worstBucket = i;
				}
			}
			expect({
				condition: worstDelta === 0,
				message: `bucket ${worstBucket} differs by ${worstDelta.toFixed(6)} between the streamed and buffered summaries`,
			});

			// Silence would satisfy every comparison above, and silence is the bug.
			let peak = 0;
			for (let i = 0; i < shared; i++) {
				peak = Math.max(peak, streamed!.amplitudes[i]);
			}
			expect({
				condition: peak > 0.1,
				message: `the streamed summary peaks at ${peak.toFixed(4)}, so it summarised silence`,
			});

			// The second route, exercised directly rather than waited for. It only
			// runs in the wild when WebCodecs refuses a source — on WebKitGTK that
			return `${seconds}s summarised in ${revisions.length} progress slices, ${shared} buckets identical to the buffered fold, peak ${peak.toFixed(3)}`;
		},
	},
	{
		name: "Audio decodes even when WebCodecs refuses the codec",
		run: async () => {
			// WebKitGTK answers `AudioDecoder.isConfigSupported` for FLAC with
			// `supported: true` and then fails the first packet with a bare "Decode
			// error", so `canDecode()` promises a track it will never decode. Nothing
			// asked before the fact can catch that; only feeding it a packet can.
			//
			// The cost of getting it wrong is quiet and wide: a FLAC on the timeline
			// played silently, drew no waveform, and was dropped from the exported mix
			// without a word. So this drives the decoder the editor actually uses and
			// insists on samples, whichever path produces them.
			const bytes = decodeBase64({ base64: TINY_FLAC_BASE64 });
			const blob = new Blob([bytes], { type: "audio/flac" });

			// Which codecs this engine's WebCodecs takes is its business, and it
			// is allowed to take none of them: the shell decodes audio, so the
			// answer never decides whether a clip plays. What is checked is only
			// that samples come out.
			const claimed = "not asked";

			const buffer = await decodeAudioBufferFromRef({
				ref: { kind: "blob", blob },
				sampleRate: 48000,
				maxChannels: 2,
			});
			expect({
				condition: buffer !== null,
				message:
					"a FLAC decoded to nothing, so preview, waveforms and exports are all silent for it",
			});

			expect({
				condition: Math.abs(buffer!.duration - TINY_FLAC_SECONDS) < 0.02,
				message: `decoded ${buffer!.duration.toFixed(3)}s, expected ${TINY_FLAC_SECONDS}s`,
			});
			expect({
				condition: buffer!.sampleRate === 48000,
				message: `decoded at ${buffer!.sampleRate}Hz, expected the requested 48000Hz`,
			});

			// Silence would satisfy every assertion above, and silence is the bug.
			const samples = buffer!.getChannelData(0);
			let peak = 0;
			for (let i = 0; i < samples.length; i++) {
				peak = Math.max(peak, Math.abs(samples[i]));
			}
			expect({
				condition: peak > 0.01,
				message: `the decoded buffer peaks at ${peak.toFixed(4)}, so it is silent`,
			});

			return `FLAC decoded to ${buffer!.duration.toFixed(3)}s peaking at ${peak.toFixed(3)} (WebCodecs claimed canDecode=${claimed})`;
		},
	},
	{
		name: "A butt-joined cut has a non-black frame at every playhead frame",
		run: async () => {
			// The bug the unit tests guard against, taken to the actual renderer:
			// two clips of the same source placed butt-to-butt on the main track,
			// and every frame the playhead can land on must have at least one
			// composited layer. A flash shows up as a frame whose pixels all read
			// near zero. The tail-hold extension at a zero-gap cut is the only
			// thing keeping the outgoing clip on screen while the incoming clip's
			// decoder is still warming up; if that ever regresses, this fails.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});

			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip({ frames: 600 });

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
						duration: 30 / 30,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: asset !== null,
					message: "the asset did not load back",
				});

				const width = 320;
				const height = 240;
				const fps = DEFAULT_FPS;
				const totalSeconds = 600 / 30;
				const splitSeconds = 300 / 30;
				const tickDuration = mediaTimeFromSeconds({ seconds: totalSeconds });
				const cut = mediaTimeFromSeconds({ seconds: splitSeconds });
				const tracks = {
					overlay: [],
					audio: [],
					main: {
						id: "main",
						name: "Main",
						type: "video" as const,
						muted: false,
						hidden: false,
						elements: [
							{
								id: "a",
								name: "A",
								type: "video" as const,
								mediaId,
								startTime: ZERO_MEDIA_TIME,
								duration: cut,
								trimStart: ZERO_MEDIA_TIME,
								trimEnd: ZERO_MEDIA_TIME,
								params: {},
							},
							{
								id: "b",
								name: "B",
								type: "video" as const,
								mediaId,
								startTime: cut,
								duration: mediaTimeFromSeconds({
									seconds: totalSeconds - splitSeconds,
								}),
								trimStart: mediaTimeFromSeconds({ seconds: splitSeconds }),
								trimEnd: ZERO_MEDIA_TIME,
								params: {},
							},
						],
					},
				};

				const renderer = new CanvasRenderer({ width, height, fps });

				const ticksPerFrame = Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				);

				const emptyFrames: number[] = [];
				for (
					let tick = 0;
					tick < tickDuration;
					tick += ticksPerFrame
				) {
					const scene = buildScene({
						canvasSize: { width, height },
						background: { type: "color", color: "#000000" },
						duration: tickDuration * 2,
						mediaAssets: [asset!],
						tracks,
						fps,
					});
					await renderer.render({ node: scene, time: tick });
					// Read straight after the render: a GPU-drawn canvas is only
					// reliably readable until the browser next composites it.
					const data = readFullFrameRgba({
						source: renderer.getOutputCanvas(),
						width,
						height,
					});
					let peak = 0;
					for (let i = 0; i < data.length; i += 4) {
						peak = Math.max(
							peak,
							data[i] + data[i + 1] + data[i + 2],
						);
					}
					if (peak < 30) emptyFrames.push(tick);
				}

				expect({
					condition: emptyFrames.length === 0,
					message: `these ticks composited near-black at the cut: ${emptyFrames.join(", ")}`,
				});

				return `every frame across the butt-joined cut showed composited pixels`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Scrubbing a long HD clip through the canvas path survives",
		run: async () => {
			// Reproduction for the recurring `drawVideoFrame` use-after-free. The
			// crash lands as a SIGSEGV inside `drawImage(WebCodecsVideoFrame)` on a
			// frame that has already been closed, so it kills the web process
			// outright rather than throwing — see the memory note. The conditions
			// that surface it are HD frames (slow enough to decode that renders
			// interleave with decoder callbacks) and a lot of seeking.
			//
			// Crop is deliberate: it routes the clip through the "rendered" texture
			// branch in `frame-descriptor.ts`, where the frame is drawn by
			// JavaScript into an OffscreenCanvas rather than handed to the GPU as a
			// `kind: "video"` texture. That is the branch the crash stack shows.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});

			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const sourceWidth = 1920;
			const sourceHeight = 1080;
			const frameCount = 300;
			const file = await encodeSampleClip({
				frames: frameCount,
				width: sourceWidth,
				height: sourceHeight,
			});

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: sourceWidth,
						height: sourceHeight,
						duration: frameCount / 30,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: asset !== null,
					message: "the asset did not load back",
				});

				const fps = DEFAULT_FPS;
				const totalSeconds = frameCount / 30;
				const tickDuration = mediaTimeFromSeconds({ seconds: totalSeconds });
				const tracks = {
					overlay: [],
					audio: [],
					main: {
						id: "main",
						name: "Main",
						type: "video" as const,
						muted: false,
						hidden: false,
						elements: [
							{
								id: "a",
								name: "A",
								type: "video" as const,
								mediaId,
								startTime: ZERO_MEDIA_TIME,
								duration: tickDuration,
								trimStart: ZERO_MEDIA_TIME,
								trimEnd: ZERO_MEDIA_TIME,
								params: {
									"crop.left": 0.1,
									"crop.right": 0.1,
									"crop.top": 0.05,
									"crop.bottom": 0.05,
								},
							},
						],
					},
				};

				const renderer = new CanvasRenderer({
					width: sourceWidth,
					height: sourceHeight,
					fps,
				});
				const ticksPerFrame = Math.round(
					(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
				);
				const scene = buildScene({
					canvasSize: { width: sourceWidth, height: sourceHeight },
					background: { type: "color", color: "#000000" },
					duration: tickDuration,
					mediaAssets: [asset!],
					tracks,
					fps,
					isPreview: true,
				});

				// Forward, then a scrub pattern that keeps forcing the decoder to
				// re-seek: back to the head, deep into the tail, and short hops
				// backwards, which is what dragging the playhead actually does.
				const frames = Math.floor(tickDuration / ticksPerFrame);
				const ticks: number[] = [];
				for (let frame = 0; frame < 40; frame += 1) {
					ticks.push(frame * ticksPerFrame);
				}
				for (let frame = 0; frame < 20; frame += 1) {
					ticks.push(Math.floor(frames * 0.75) * ticksPerFrame);
					ticks.push(frame * 3 * ticksPerFrame);
				}
				for (let frame = 60; frame > 0; frame -= 2) {
					ticks.push(frame * ticksPerFrame);
				}

				for (const tick of ticks) {
					await renderer.render({ node: scene, time: tick });
				}

				const stats = videoCache.getStats();
				return `rendered ${ticks.length} HD frames through the canvas path with ${stats.totalSinks} decoder(s) open`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Every Adjust slider changes the picture",
		run: async () => {
			// The check above proves one shader runs; this one proves the panel is
			// wired to the picture. Each slider is pushed to its end on a real clip
			// and the composited frame is compared against the ungraded one, through
			// the same renderer the preview uses — scene build, frame descriptor,
			// canvas overlays, shader passes, compositor.
			//
			// It lives here rather than in `bun test` because the split it guards is
			// a desktop one: `ctx.filter` is inert in WebKitGTK, so half of these
			// sliders reach the frame as shader passes and half as canvas draws, and
			// only this shell exercises that arrangement.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});

			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await encodeSampleClip();

			try {
				await storageService.saveMediaAsset({
					projectId,
					mediaAsset: {
						id: mediaId,
						name: "check.mp4",
						type: "video",
						file,
						width: 320,
						height: 240,
						duration: 20 / 30,
					},
				});
				const asset = await storageService.loadMediaAsset({
					projectId,
					id: mediaId,
				});
				expect({
					condition: asset !== null,
					message: "the asset did not load back",
				});

				const width = 320;
				const height = 240;
				const duration = mediaTimeFromSeconds({ seconds: 20 / 30 });
				const time = mediaTimeFromSeconds({ seconds: 0.25 });
				const renderer = new CanvasRenderer({ width, height, fps: DEFAULT_FPS });

				const renderPixels = async ({
					params,
				}: {
					params: Record<string, number>;
				}): Promise<Uint8ClampedArray> => {
					const scene = buildScene({
						canvasSize: { width, height },
						background: { type: "color", color: "#000000" },
						duration,
						mediaAssets: [asset!],
						tracks: {
							overlay: [],
							audio: [],
							main: {
								id: "main",
								name: "Main",
								type: "video",
								muted: false,
								hidden: false,
								elements: [
									{
										id: "clip",
										name: "check.mp4",
										type: "video",
										mediaId,
										duration,
										startTime: ZERO_MEDIA_TIME,
										trimStart: ZERO_MEDIA_TIME,
										trimEnd: ZERO_MEDIA_TIME,
										params,
									},
								],
							},
						},
					});
					await renderer.render({ node: scene, time });
					return readFullFrameRgba({
						source: renderer.getOutputCanvas(),
						width,
						height,
					});
				};

				const centrePixel = ((height / 2) * width + width / 2) * 4;
				const isBlack = ({ frame }: { frame: Uint8ClampedArray }): boolean =>
					frame[centrePixel] +
						frame[centrePixel + 1] +
						frame[centrePixel + 2] <=
					30;

				// Render until there is a picture before the baseline is taken.
				// Opening a clip's decoder takes more than one request to answer
				// with a frame, so a baseline read on the first render is the clear
				// colour — and every slider after it then "changed the frame"
				// merely by having one, which is the wrong thing to be sure of.
				let neutral = await renderPixels({ params: {} });
				for (let attempt = 0; attempt < 8 && isBlack({ frame: neutral }); attempt++) {
					neutral = await renderPixels({ params: {} });
				}
				const moved: string[] = [];
				const dead: string[] = [];
				for (const key of ADJUSTMENT_PARAM_KEYS) {
					const graded = await renderPixels({ params: { [key]: 100 } });
					let total = 0;
					for (let i = 0; i < graded.length; i += 4) {
						total +=
							Math.abs(graded[i] - neutral[i]) +
							Math.abs(graded[i + 1] - neutral[i + 1]) +
							Math.abs(graded[i + 2] - neutral[i + 2]);
					}
					const delta = total / ((graded.length / 4) * 3);
					// The composited pixel goes in the label so a slider that reads
					// as dead can be told apart from a fixture the slider genuinely
					// cannot move — saturation on an already-clipped colour, say.
					const centre = centrePixel;
					const label = `${key.replace("adjust.", "")} ${delta.toFixed(1)} (${neutral[centre]},${neutral[centre + 1]},${neutral[centre + 2]} -> ${graded[centre]},${graded[centre + 1]},${graded[centre + 2]})`;
					// One level out of 255 averaged over the frame: below that the
					// slider is doing nothing a viewer could see.
					(delta >= 1 ? moved : dead).push(label);
				}

				expect({
					condition: dead.length === 0,
					message: `these sliders left the frame untouched: ${dead.join(", ")} (the ones that moved it: ${moved.join(", ")})`,
				});
				return `all ${moved.length} sliders moved the frame — mean level change ${moved.join(", ")}`;
			} finally {
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},
	{
		name: "Media the OS won't type is recognised by extension",
		run: async () => {
			// `File.type` is the OS's opinion and it often hasn't got one: MKV,
			// M2TS and Opus all arrive typeless from the Windows shell, and the
			// import used to answer "unsupported file type" to exactly the files
			// the shell reads best. The extension is the fallback answer.
			const cases: { name: string; expected: MediaType | null }[] = [
				{ name: "camera.mkv", expected: "video" },
				{ name: "camcorder.m2ts", expected: "video" },
				{ name: "TAKE.MOV", expected: "video" },
				{ name: "broadcast.ts", expected: "video" },
				{ name: "score.flac", expected: "audio" },
				{ name: "voice.opus", expected: "audio" },
				{ name: "podcast.m4a", expected: "audio" },
				{ name: "still.heic", expected: "image" },
				{ name: "notes.txt", expected: null },
				{ name: "noextension", expected: null },
			];

			for (const { name, expected } of cases) {
				const file = new File([new Uint8Array(8)], name, { type: "" });
				const actual = getMediaTypeFromFile({ file });
				expect({
					condition: actual === expected,
					message: `${name} was read as ${actual ?? "unsupported"}, expected ${
						expected ?? "unsupported"
					}`,
				});
			}

			// And a type the OS does supply still decides, whatever the name says.
			const typed = new File([new Uint8Array(8)], "clip.bin", {
				type: "video/mp4",
			});
			expect({
				condition: getMediaTypeFromFile({ file: typed }) === "video",
				message: "a declared MIME type was ignored in favour of the extension",
			});

			return `${cases.length} names resolved without a MIME type`;
		},
	},
	{
		name: "Export containers resolve to codecs this engine can encode",
		run: async () => {
			// Which codecs a webview encodes is its own business — WebKitGTK
			// ships without an H.264 encoder on plenty of distributions. What
			// must never happen is an export that discovers this mid-render, so
			// every container is asked in advance and the answers recorded.
			const video = await Promise.all(
				listExportFormats({ kind: "video" }).map(async ({ format, spec }) => ({
					label: spec.label,
					codec: await resolveExportVideoCodec({ format }),
				})),
			);
			const audio = await Promise.all(
				listExportFormats({ kind: "audio" }).map(async ({ format, spec }) => ({
					label: spec.label,
					encoding: await resolveExportAudioEncoding({ format }),
				})),
			);

			expect({
				condition: video.some(({ codec }) => codec !== null),
				message: "no video container could be encoded at all on this engine",
			});

			// WAV is the floor: PCM samples are written straight out and
			// never handed to an encoder, so an engine that can encode nothing
			// can still get the audio out.
			const wav = audio.find(({ label }) => label === "WAV");
			expect({
				condition: wav?.encoding?.codec === "pcm-s16",
				message: `WAV resolved to ${wav?.encoding?.codec ?? "nothing"}, which means PCM stopped being unconditional`,
			});

			return [
				...video.map(({ label, codec }) => `${label}=${codec ?? "none"}`),
				...audio.map(
					({ label, encoding }) => `${label}=${encoding?.codec ?? "none"}`,
				),
			].join(", ");
		},
	},
	{
		name: "An audio-only export writes a file with sound in it",
		run: async () => {
			// The audio containers render no frames at all, so they take a
			// different path through the exporter than every other check here:
			// no compositor, no canvas, and the progress bar driven by the audio
			// itself. A file that muxes but decodes to silence looks identical
			// from the outside, so the samples are read back too.
			const sampleRate = 48000;
			const seconds = 1.5;
			const frameCount = Math.round(sampleRate * seconds);
			const context = new OfflineAudioContext(2, frameCount, sampleRate);
			const buffer = context.createBuffer(2, frameCount, sampleRate);
			for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
				const samples = buffer.getChannelData(channel);
				for (let i = 0; i < samples.length; i++) {
					samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
				}
			}

			const scene = buildScene({
				canvasSize: { width: 320, height: 240 },
				background: { type: "color", color: "#000000" },
				duration: mediaTimeFromSeconds({ seconds }),
				mediaAssets: [],
				tracks: {
					overlay: [],
					audio: [],
					main: {
						id: "main",
						name: "Main",
						type: "video",
						muted: false,
						hidden: false,
						elements: [],
					},
				},
			});

			const exporter = new SceneExporter({
				width: 320,
				height: 240,
				fps: DEFAULT_FPS,
				format: "wav",
				videoBitrate: 1_000_000,
				videoCodec: null,
				shouldIncludeAudio: true,
				audioBuffer: buffer,
			});

			const artifact = await exporter.export({ rootNode: scene });
			expect({
				condition: artifact?.kind === "path",
				message: `the audio export produced ${artifact?.kind ?? "nothing"} instead of a file on disk`,
			});
			if (artifact?.kind !== "path") throw new Error("unreachable");

			try {
				const url = tauriConvertFileSrc(artifact.path);
				// The shell's own header read: what tracks the file has, and how
				// long it says it is.
				const probe = await tauriProbeMedia({ path: artifact.path });
				expect({
					condition: probe.hasAudio,
					message: "the exported WAV has no audio track",
				});
				expect({
					condition: probe.kind === "audio",
					message: "an audio-only export wrote a video track",
				});
				const exportedDuration = probe.durationSeconds;
				expect({
					condition: Math.abs(exportedDuration - seconds) < 0.05,
					message: `exported ${exportedDuration.toFixed(3)}s of audio, expected ${seconds}s`,
				});

				const decoded = await decodeAudioBufferFromRef({
					ref: { kind: "url", url },
					sampleRate,
				});
				expect({
					condition: decoded !== null,
					message: "the exported WAV decoded to nothing",
				});

				let peak = 0;
				const samples = decoded!.getChannelData(0);
				for (let i = 0; i < samples.length; i++) {
					peak = Math.max(peak, Math.abs(samples[i]));
				}
				expect({
					condition: peak > 0.4,
					message: `the exported audio peaks at ${peak.toFixed(4)}, so it is silent`,
				});

				return `${exportedDuration.toFixed(2)}s of PCM written and read back peaking at ${peak.toFixed(3)}`;
			} finally {
				await tauriRemoveFile({ path: artifact.path }).catch(() => {});
			}
		},
	},
	{
		name: "The composited canvas encodes the way it reads",
		run: async () => {
			// The preview draws the compositor's canvas with `drawImage`; the
			// exporter hands the same canvas to `CanvasSource`, which builds a
			// `VideoFrame` from it. Those are two different readers of one canvas,
			// and wgpu's WebGL backend stores its rows bottom-up and flips them on
			// present — so an engine that reads a canvas without honouring its row
			// order agrees with the preview and disagrees with the encoder. Each
			// stage is measured separately, because which one flips is the whole
			// question.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so there is nothing to composite",
			});

			const SIZE = 64;
			wasmCompositor.ensureInitialized({ width: SIZE, height: SIZE });
			const composited = wasmCompositor.getCanvas();

			const renderProbe = () => {
				wasmCompositor.syncTextures({
				owner: "check",
				textures: [
					{
						kind: "rendered",
						id: "check:orientation-probe",
						contentHash: "orientation-probe",
						width: SIZE,
						height: SIZE,
						draw: (ctx) => {
							ctx.fillStyle = "rgb(255, 0, 0)";
							ctx.fillRect(0, 0, SIZE, SIZE / 2);
							ctx.fillStyle = "rgb(0, 0, 255)";
							ctx.fillRect(0, SIZE / 2, SIZE, SIZE / 2);
						},
					},
					],
				});
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
					renderScale: 1,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId: "check:orientation-probe",
							transform: {
								centerX: SIZE / 2,
								centerY: SIZE / 2,
								width: SIZE,
								height: SIZE,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});
			};

			try {
				renderProbe();
				const drawn = readVerticalOrder({
					source: composited,
					width: SIZE,
					height: SIZE,
				});

				let framed: VerticalOrder = {
					order: "indeterminate",
					detail: "no VideoFrame",
				};
				if (typeof VideoFrame !== "undefined") {
					renderProbe();
					const frame = new VideoFrame(composited, { timestamp: 0 });
					try {
						framed = readVerticalOrder({
							source: frame,
							width: SIZE,
							height: SIZE,
						});
					} finally {
						frame.close();
					}
				}

				const codec = await resolveExportVideoCodec({ format: "mp4" });
				expect({
					condition: codec !== null,
					message: "this engine has no video encoder, so nothing can be exported",
				});

				// Encodes six frames and reads the picture back out. `copy` is what
				// the exporter does — draw the composited frame into a 2D canvas
				// and read *that* back — while the other way round reads the
				// compositor's own canvas directly, which is what put every
				// export on its head.
				//
				// The encoder no longer takes a canvas at all: it takes RGBA
				// bytes, and `getImageData` is what produces them. So the
				// question this asks has narrowed usefully — not "does
				// `CanvasSource` flip a GPU canvas" but "does reading a GPU
				// canvas back flip it", which is the step the exporter actually
				// performs.
				const encodeAndRead = async ({
					copy,
				}: {
					copy: boolean;
				}): Promise<VerticalOrder> => {
					const surface = document.createElement("canvas");
					surface.width = SIZE;
					surface.height = SIZE;
					const surfaceCtx = surface.getContext("2d", {
						willReadFrequently: true,
					});
					if (!surfaceCtx) throw new Error("no encode surface context");

					const sink = await NativeMediaSink.open({
						config: {
							container: "mp4",
							videoCodec: codec,
							width: SIZE,
							height: SIZE,
							fpsNumerator: 30,
							fpsDenominator: 1,
							videoBitrate: 2_000_000,
							audioCodec: null,
							audioSampleRate: 0,
							audioChannels: 0,
						},
					});
					for (let i = 0; i < 6; i++) {
						// Re-rendered every frame: a GPU canvas is only reliably
						// readable until the browser next composites it.
						renderProbe();
						let data: Uint8ClampedArray;
						if (copy) {
							surfaceCtx.clearRect(0, 0, SIZE, SIZE);
							surfaceCtx.drawImage(composited, 0, 0, SIZE, SIZE);
							data = surfaceCtx.getImageData(0, 0, SIZE, SIZE).data;
						} else {
							// A WebGL canvas has no 2D context of its own, so
							// "direct" here is the nearest thing available: a
							// `VideoFrame` built from it, which is the construction
							// that read the rows bottom-up.
							const frame = new VideoFrame(composited, { timestamp: 0 });
							try {
								surfaceCtx.clearRect(0, 0, SIZE, SIZE);
								surfaceCtx.drawImage(frame, 0, 0, SIZE, SIZE);
								data = surfaceCtx.getImageData(0, 0, SIZE, SIZE).data;
							} finally {
								frame.close();
							}
						}
						await sink.writeFrame({
							pixels: new Uint8Array(
								data.buffer,
								data.byteOffset,
								data.byteLength,
							),
							ptsIndex: i,
						});
					}
					const path = await sink.finish();

					try {
						const sample = await decodeFrameAt({
							path,
							seconds: 2 / 30,
						});
						expect({
							condition: sample !== null,
							message: "the re-encoded canvas decoded to no frame",
						});
						const picture = sample!.toVideoFrame();
						try {
							return readVerticalOrder({
								source: picture,
								width: SIZE,
								height: SIZE,
							});
						} finally {
							picture.close();
							sample!.close();
						}
					} finally {
						await tauriRemoveFile({ path }).catch(() => {});
					}
				};

				const direct = await withDeadline({
					label: "encoding the compositor canvas directly",
					timeoutMs: 30_000,
					run: () => encodeAndRead({ copy: false }),
				});
				const viaCopy = await withDeadline({
					label: "encoding a 2D copy of the compositor canvas",
					timeoutMs: 30_000,
					run: () => encodeAndRead({ copy: true }),
				});

				const stages = `drawImage ${drawn.order} (${drawn.detail}); VideoFrame ${framed.order}; encoded direct ${direct.order}; encoded via a 2D copy ${viaCopy.order} (${viaCopy.detail})`;

				expect({
					condition: drawn.order === "red-on-top",
					message: `the compositor itself drew ${drawn.order} — ${stages}`,
				});
				// The one that has to hold: the exporter encodes the copy. Whether
				// this engine can read the compositor's canvas into a `VideoFrame`
				// the right way up is its own business, and is recorded rather than
				// asserted — knowing the answer is what says whether the copy is
				// still earning its keep.
				expect({
					condition: viaCopy.order === "red-on-top",
					message: `an export encoded the way the exporter encodes came back ${viaCopy.order} — ${stages}`,
				});

				return direct.order === "red-on-top"
					? `this engine encodes the compositor canvas the right way up; the copy is belt and braces — ${stages}`
					: `handing the compositor canvas straight to the encoder flips it here; through a 2D copy it is upright — ${stages}`;
			} finally {
				wasmCompositor.syncTextures({ owner: "check", textures: [] });
			}
		},
	},
	{
		name: "Every container an export may pick can really encode",
		run: async () => {
			// The capability probe reports what ffmpeg says it can encode, and
			// this checks the claim the only way it can be checked: by writing
			// a second of sound into every container offered and reading the
			// samples back. It runs through the real IPC sink rather than
			// calling the encoder in-process, so the headers, the raw bodies
			// and the re-chunking are all on the hook too.
			//
			// Each container is announced before it is tried, because an
			// encoder that aborts the process rather than rejecting leaves the
			// marker as the only evidence of which one it was.
			const sampleRate = 44100;
			const frameCount = sampleRate;
			const tone = new Float32Array(frameCount * 2);
			for (let i = 0; i < frameCount; i++) {
				const value = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
				tone[i * 2] = value;
				tone[i * 2 + 1] = value;
			}

			const encodeOne = async ({
				format,
			}: {
				format: ExportFormat;
			}): Promise<string> => {
				const spec = getExportFormatSpec({ format });
				const encoding = await resolveExportAudioEncoding({ format });
				if (!encoding) return `${spec.label}=none claimed`;

				const videoCodec = spec.kind === "video"
					? await resolveExportVideoCodec({ format })
					: null;
				if (spec.kind === "video" && !videoCodec) {
					return `${spec.label}=no video encoder`;
				}

				const name = `${spec.label}/${encoding.codec}`;
				trace({ line: `${name}: encoding` });

				const path = await withDeadline({
					label: `${name} encode`,
					timeoutMs: 20_000,
					run: async () => {
						const sink = await NativeMediaSink.open({
							config: {
								container: format,
								videoCodec,
								width: videoCodec ? 64 : 0,
								height: videoCodec ? 64 : 0,
								fpsNumerator: 30,
								fpsDenominator: 1,
								videoBitrate: 800_000,
								audioCodec: encoding.codec,
								audioSampleRate: sampleRate,
								audioChannels: 2,
							},
						});
						if (videoCodec) {
							// A video container needs at least one frame or the
							// muxer writes a track with no samples in it.
							const pixels = new Uint8Array(64 * 64 * 4).fill(0x80);
							await sink.writeFrame({ pixels, ptsIndex: 0 });
						}
						// Chunked at something that is not a multiple of any
						// encoder's frame size, so the sink's re-chunking is
						// exercised rather than sidestepped.
						const chunk = 3000;
						for (let offset = 0; offset < frameCount; offset += chunk) {
							const frames = Math.min(chunk, frameCount - offset);
							await sink.writeAudio({
								samples: tone.subarray(offset * 2, (offset + frames) * 2),
								frames,
								ptsIndex: offset,
							});
						}
						return await sink.finish();
					},
				});
				artifacts.push(path);

				trace({ line: `${name}: encoded, decoding` });
				const decoded = await withDeadline({
					label: `${name} decode`,
					timeoutMs: 20_000,
					run: () =>
						decodeAudioBufferFromRef({
							ref: { kind: "url", url: tauriConvertFileSrc(path) },
							sampleRate,
						}),
				});
				expect({
					condition: decoded !== null,
					message: `${name} wrote a file whose audio decoded to nothing`,
				});
				const peak = findAudioDropouts({ buffer: decoded! }).worstPeak;
				expect({
					condition: peak > 0.2,
					message: `${name} decoded to a peak of ${peak.toFixed(3)}, which is silence`,
				});
				return `${name} ok`;
			};

			const artifacts: string[] = [];
			try {
				const results: string[] = [];
				for (const { format } of listExportFormats()) {
					results.push(await encodeOne({ format }));
				}
				expect({
					condition: results.some((line) => line.endsWith("ok")),
					message: `no container could be encoded at all — ${results.join(", ")}`,
				});
				return results.join(", ");
			} finally {
				for (const path of artifacts) {
					await tauriRemoveFile({ path }).catch(() => {});
				}
			}
		},
	},
	{
		name: "A clip exports the right way up with unbroken sound",
		run: async () => {
			// The user-visible complaint, end to end: a clip with a known picture
			// and a known continuous tone goes on a timeline, through the real
			// export, and comes back to be looked at and listened to. The fixture
			// is verified before it is used, so a flip in the probe's own encode
			// cannot be mistaken for a flip in the export.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});

			const SECONDS = 6;
			const SAMPLE_RATE = 44100;
			const WIDTH = 64;
			const HEIGHT = 64;
			const projectId = crypto.randomUUID();
			const mediaId = crypto.randomUUID();
			const file = await withDeadline({
				label: "encoding the probe clip",
				timeoutMs: 60_000,
				run: () =>
					encodeProbeClip({
						seconds: SECONDS,
						width: WIDTH,
						height: HEIGHT,
						sampleRate: SAMPLE_RATE,
					}),
			});

			// The fixture has to be right before it can prove anything.
			const probeFile = await scratchMediaRef({ file, extension: "mp4" });
			let fixture: VerticalOrder = {
				order: "indeterminate",
				detail: "not decoded",
			};
			try {
				fixture = await withDeadline({
					label: "decoding the probe clip back",
					timeoutMs: 30_000,
					run: async () => {
						const sample = await decodeFrameAt({
							path: probeFile.path,
							seconds: 0.2,
						});
						expect({
							condition: sample !== null,
							message: "the probe clip decoded to no frame",
						});
						const picture = sample!.toVideoFrame();
						try {
							return readVerticalOrder({
								source: picture,
								width: WIDTH,
								height: HEIGHT,
							});
						} finally {
							picture.close();
							sample!.close();
						}
					},
				});
			} finally {
				await tauriRemoveFile({ path: probeFile.path }).catch(() => {});
			}
			expect({
				condition: fixture.order === "red-on-top",
				message: `the probe clip itself encoded ${fixture.order} (${fixture.detail}), so a 2D canvas already flips here`,
			});

			const artifacts: string[] = [];
			try {
				const asset = await withDeadline({
					label: "storing the probe clip",
					timeoutMs: 30_000,
					run: async () => {
						await storageService.saveMediaAsset({
							projectId,
							mediaAsset: {
								id: mediaId,
								name: "probe.mp4",
								type: "video",
								file,
								width: WIDTH,
								height: HEIGHT,
								duration: SECONDS,
								hasAudio: true,
							},
						});
						return storageService.loadMediaAsset({ projectId, id: mediaId });
					},
				});
				expect({
					condition: asset !== null,
					message: "the probe asset did not load back",
				});

				const duration = mediaTimeFromSeconds({ seconds: SECONDS });
				const tracks = {
					overlay: [],
					audio: [],
					main: {
						id: "main",
						name: "Main",
						type: "video" as const,
						muted: false,
						hidden: false,
						elements: [
							{
								id: "probe",
								name: "probe.mp4",
								type: "video" as const,
								mediaId,
								startTime: ZERO_MEDIA_TIME,
								duration,
								trimStart: ZERO_MEDIA_TIME,
								trimEnd: ZERO_MEDIA_TIME,
								params: {},
							},
						],
					},
				};

				// The mix the exporter is handed, measured before it is encoded, so a
				// dropout can be pinned on the mixer or on the encoder.
				const mixed = await withDeadline({
					label: "mixing the timeline audio",
					timeoutMs: 60_000,
					run: () =>
						createTimelineAudioBuffer({
							tracks,
							mediaAssets: [asset!],
							duration,
						}),
				});
				expect({
					condition: mixed !== null,
					message: "the timeline mixed down to no audio at all",
				});
				const mixedGaps = findAudioDropouts({ buffer: mixed! });

				const codec = await resolveExportVideoCodec({ format: "mp4" });
				expect({
					condition: codec !== null,
					message: "this engine has no video encoder, so nothing can be exported",
				});

				const scene = buildScene({
					canvasSize: { width: WIDTH, height: HEIGHT },
					background: { type: "color", color: "#000000" },
					duration,
					mediaAssets: [asset!],
					tracks,
					fps: DEFAULT_FPS,
				});

				const exporter = new SceneExporter({
					width: WIDTH,
					height: HEIGHT,
					fps: DEFAULT_FPS,
					format: "mp4",
					videoBitrate: 2_000_000,
					videoCodec: codec,
					shouldIncludeAudio: true,
					audioBuffer: mixed!,
				});
				const artifact = await withDeadline({
					label: "running the export",
					timeoutMs: 120_000,
					run: () => exporter.export({ rootNode: scene }),
				});
				expect({
					condition: artifact?.kind === "path",
					message: `the export produced ${artifact?.kind ?? "nothing"} instead of a file on disk`,
				});
				if (artifact?.kind !== "path") throw new Error("unreachable");
				artifacts.push(artifact.path);

				const url = tauriConvertFileSrc(artifact.path);
				let exported: VerticalOrder = {
					order: "indeterminate",
					detail: "not decoded",
				};
				exported = await withDeadline({
					label: "decoding the exported picture",
					timeoutMs: 30_000,
					run: async () => {
						// Read near the start rather than at `SECONDS / 2`.
						// Seeking into the middle of a file the shell's own
						// encoder wrote comes back with no frames — the GOP
						// extractor in `media_decode.rs` only ever ran against
						// browser-encoded fixtures, and it does not survive the
						// contact. Which way up the picture is reads the same
						// from any frame, so this check does not wait on that
						// fix; the seek itself is untested until it lands.
						const sample = await decodeFrameAt({
							path: artifact.path,
							seconds: 0.2,
						});
						expect({
							condition: sample !== null,
							message: "the export decoded to no frame",
						});
						const picture = sample!.toVideoFrame();
						try {
							return readVerticalOrder({
								source: picture,
								width: WIDTH,
								height: HEIGHT,
							});
						} finally {
							picture.close();
							sample!.close();
						}
					},
				});

				const decoded = await withDeadline({
					label: "decoding the exported audio",
					timeoutMs: 60_000,
					run: () =>
						decodeAudioBufferFromRef({
							ref: { kind: "url", url },
							sampleRate: SAMPLE_RATE,
						}),
				});
				expect({
					condition: decoded !== null,
					message: "the export's audio track decoded to nothing",
				});
				const exportedGaps = findAudioDropouts({ buffer: decoded! });

				const report = [
					`picture ${exported.order} (${exported.detail})`,
					`mix ${mixed!.duration.toFixed(2)}s, ${mixedGaps.count} silent windows` +
						(mixedGaps.firstAtSeconds !== null
							? ` from ${mixedGaps.firstAtSeconds.toFixed(2)}s`
							: "") +
						`, quietest ${mixedGaps.worstPeak.toFixed(3)}`,
					`export ${decoded!.duration.toFixed(2)}s, ${exportedGaps.count} silent windows` +
						(exportedGaps.firstAtSeconds !== null
							? ` from ${exportedGaps.firstAtSeconds.toFixed(2)}s`
							: "") +
						`, quietest ${exportedGaps.worstPeak.toFixed(3)}`,
				].join("; ");

				expect({
					condition: exported.order === "red-on-top",
					message: `the exported picture is ${exported.order} — ${report}`,
				});
				expect({
					condition: mixedGaps.count === 0,
					message: `the mix handed to the encoder already has gaps — ${report}`,
				});
				expect({
					condition: exportedGaps.count === 0,
					message: `the exported audio cuts out — ${report}`,
				});

				return report;
			} finally {
				for (const path of artifacts) {
					await tauriRemoveFile({ path }).catch(() => {});
				}
				videoCache.clearVideo({ mediaId });
				await storageService.deleteProjectMedia({ projectId }).catch(() => {});
			}
		},
	},

	{
		name: "A frame outlives the sample it was cloned from",
		run: async () => {
			// The decisive question behind the recurring `drawVideoFrame` SIGSEGV.
			//
			// `videoCache` hands out a `VideoSample` and the resolver
			// immediately takes `sample.toVideoFrame()`, which is
			// `new VideoFrame(existingFrame, init)`. Per WebCodecs that shares the
			// underlying media resource by reference count, so closing the sample
			// must leave the clone drawable — and the cache closes samples
			// constantly as it advances and re-seeks a decoder.
			//
			// If WebKitGTK does not refcount that constructor, every clone the
			// renderer holds becomes a dangling pointer the moment the cache moves
			// on, and drawing it is the use-after-free in the crash. Long clips
			// make it fire because they churn the decoder hard enough for the
			// buffer to actually be recycled rather than sit in a pool.
			//
			// Ordered last on purpose: if the answer is "no", this takes the web
			// process down and the marker below is the whole result.
			const SIZE = 64;
			const file = await encodeSampleClip({
				frames: 30,
				width: SIZE,
				height: SIZE,
			});
			const fixture = await scratchMediaRef({ file, extension: "mp4" });

			try {
				const sample = await decodeFrameAt({
					path: fixture.path,
					seconds: 5 / 30,
				});
				expect({
					condition: sample !== null,
					message: "the probe clip decoded to no frame",
				});

				trace({ line: "cloning the sample to a VideoFrame" });
				const clone = sample!.toVideoFrame();

				trace({ line: "closing the sample the clone came from" });
				sample!.close();

				const canvas = new OffscreenCanvas(SIZE, SIZE);
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				expect({
					condition: ctx !== null,
					message: "no 2D context for the probe canvas",
				});

				trace({
					line: "drawing the clone — a SIGSEGV here means the clone did not hold a reference",
				});
				ctx!.drawImage(clone, 0, 0);
				trace({ line: "the draw returned" });

				const pixels = ctx!.getImageData(0, 0, SIZE, SIZE).data;
				let peak = 0;
				for (let i = 0; i < pixels.length; i += 4) {
					peak = Math.max(peak, pixels[i] + pixels[i + 1] + pixels[i + 2]);
				}
				clone.close();

				expect({
					condition: peak > 30,
					message: `the clone drew ${peak} — it survived the close but carried no pixels`,
				});
				return `a clone stayed drawable after its sample was closed (peak ${peak}), so the constructor does refcount here`;
			} finally {
				await tauriRemoveFile({ path: fixture.path }).catch(() => {});
			}
		},
	},
	{
		name: "A frame outlives the decoder it came from",
		run: async () => {
			// The other half of the ownership question, and the one that matches
			// what the user was doing: `videoCache.clearVideo` and `clearAll` run
			// on media removal, media replacement and project switch — all of them
			// "major timeline changes" — and they call `input.dispose()`, which
			// tears the decoder down. That is synchronous and outside the render
			// queue, so it can land while a render is between resolving its frames
			// and drawing them.
			//
			// Closing the sample is already known to be safe (the check above), but
			// disposing the decoder is a different operation: it destroys the
			// pipeline the frame's storage came from. If WebKitGTK frees that
			// storage, every frame the renderer is holding becomes dangling.
			const SIZE = 64;
			const file = await encodeSampleClip({
				frames: 30,
				width: SIZE,
				height: SIZE,
			});
			const fixture = await scratchMediaRef({ file, extension: "mp4" });
			// `decodeFrameAt` disposes the decoder before it returns, so the
			// sample in hand already outlived it — which is the thing being
			// asked about. What is left is whether the *pixels* did.
			trace({ line: "decoding a frame, then disposing the decoder" });
			const sample = await decodeFrameAt({
				path: fixture.path,
				seconds: 5 / 30,
			});
			expect({
				condition: sample !== null,
				message: "the probe clip decoded to no frame",
			});

			trace({ line: "cloning, then closing the sample" });
			const clone = sample!.toVideoFrame();
			sample!.close();

			// Give the teardown a turn of the event loop to actually happen.
			await new Promise((resolve) => setTimeout(resolve, 50));

			const canvas = new OffscreenCanvas(SIZE, SIZE);
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			expect({
				condition: ctx !== null,
				message: "no 2D context for the probe canvas",
			});

			trace({
				line: "drawing the clone — a SIGSEGV here means disposing the decoder freed it",
			});
			ctx!.drawImage(clone, 0, 0);
			trace({ line: "the draw returned" });

			const pixels = ctx!.getImageData(0, 0, SIZE, SIZE).data;
			let peak = 0;
			for (let i = 0; i < pixels.length; i += 4) {
				peak = Math.max(peak, pixels[i] + pixels[i + 1] + pixels[i + 2]);
			}
			clone.close();

			expect({
				condition: peak > 30,
				message: `the clone drew ${peak} after its decoder was disposed — it survived but carried no pixels`,
			});
			return `a frame stayed drawable after its decoder was disposed (peak ${peak})`;
		},
	},

	{
		name: "One renderer's textures survive another renderer's frame",
		run: async () => {
			// The compositor and its texture cache are process-wide, but renderers
			// are not: a project thumbnail, a snapshot, an eyedropper sample and a
			// freeze bake each build a renderer of their own and render their own
			// tree through the same compositor. Texture ids are the node's position
			// in the tree, so they used to collide, and a sync retires every id the
			// incoming frame does not mention — so one of those off-screen renders
			// retired the preview's textures and closed the `VideoFrame`s the
			// preview's nodes were still holding.
			//
			// A regression here does not read as a failed assertion. Drawing a
			// closed frame is a use-after-free on this engine, so it takes the web
			// process down and the last trace line below is the only evidence.
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});

			const SIZE = 8;
			wasmCompositor.ensureInitialized({ width: SIZE, height: SIZE });
			const canvas = wasmCompositor.getCanvas();

			const source = new OffscreenCanvas(SIZE, SIZE);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no source context");
			sourceCtx.fillStyle = "rgb(240, 0, 0)";
			sourceCtx.fillRect(0, 0, SIZE, SIZE);
			const frame = new VideoFrame(source, { timestamp: 0 });

			const mine = "checkOwnerA";
			const textureId = `${mine}:shared-cache-probe`;
			const draw = () => {
				wasmCompositor.syncTextures({
					owner: mine,
					textures: [
						{
							kind: "video",
							id: textureId,
							source: frame,
							width: SIZE,
							height: SIZE,
						},
					],
				});
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
					renderScale: 1,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId,
							transform: {
								centerX: SIZE / 2,
								centerY: SIZE / 2,
								width: SIZE,
								height: SIZE,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});
				return readPixelRgba({ source: canvas, width: SIZE, height: SIZE })[0];
			};

			try {
				const before = draw();
				expect({
					condition: before > 200,
					message: `the probe drew ${before} where 240 was expected, so it never worked`,
				});

				// Another renderer's frame, naming none of our textures.
				wasmCompositor.syncTextures({
					owner: "checkOwnerB",
					textures: [],
				});

				trace({
					line: "redrawing after a foreign renderer's sync — a SIGSEGV here means it retired our frame",
				});
				const after = draw();
				expect({
					condition: after > 200,
					message: `after another renderer synced, the texture drew ${after} instead of 240`,
				});
				return `a foreign renderer's sync left this renderer's video texture intact (${after})`;
			} finally {
				wasmCompositor.syncTextures({ owner: mine, textures: [] });
			}
		},
	},
	{
		// The asset-protocol → compositor path. A still image goes through
		// `loadImageSource` (an `<img>` from `asset://…` wrapped in an
		// OffscreenCanvas when downscaling) and lands as an external texture.
		// If the `<img>` wasn't loaded with `crossOrigin = "anonymous"`, the
		// OffscreenCanvas is tainted, the texture uploads as transparent, and
		// the preview comes out blank.
		name: "An imported image renders through the compositor",
		run: async () => {
			const SIZE = 16;
			const CHECK_OWNER = "check";
			await initializeGpuRenderer();
			expect({
				condition: isGpuAvailable(),
				message: "the GPU renderer is unavailable, so nothing composites",
			});
			wasmCompositor.ensureInitialized({ width: SIZE, height: SIZE });
			const canvas = wasmCompositor.getCanvas();

			const drawCanvas = document.createElement("canvas");
			drawCanvas.width = SIZE;
			drawCanvas.height = SIZE;
			const drawCtx = drawCanvas.getContext("2d");
			expect({
				condition: drawCtx !== null,
				message: "2D context unavailable",
			});
			drawCtx!.fillStyle = "rgb(240, 0, 0)";
			drawCtx!.fillRect(0, 0, SIZE, SIZE);
			const blob = await new Promise<Blob | null>((resolve) =>
				drawCanvas.toBlob((value) => resolve(value), "image/png"),
			);
			expect({
				condition: blob !== null,
				message: "canvas produced no PNG blob",
			});
			const bytes = new Uint8Array(await blob!.arrayBuffer());

			const path = await tauriScratchPath({
				name: `${crypto.randomUUID()}.png`,
			});
			try {
				const stream = await TauriWriteStream.open({ path });
				await stream.write({ bytes });
				await stream.close();

				const allowedPath = await tauriAllowMediaFile({ path });
				const url = tauriConvertFileSrc(allowedPath);
				const textureId = `${CHECK_OWNER}:image-render-${Date.now()}`;

				clearImageSourceCache();
				const source = await loadImageSource({ url });
				try {
					wasmCompositor.syncTextures({
						owner: CHECK_OWNER,
						textures: [
							{
								kind: "external",
								id: textureId,
								source: source.source,
								width: source.width,
								height: source.height,
							},
						],
					});
					wasmCompositor.render({
						width: SIZE,
						height: SIZE,
						renderScale: 1,
						clear: { color: [0, 0, 0, 1] },
						items: [
							{
								type: "layer",
								textureId,
								transform: {
									centerX: SIZE / 2,
									centerY: SIZE / 2,
									width: SIZE,
									height: SIZE,
									rotationDegrees: 0,
									flipX: false,
									flipY: false,
								},
								opacity: 1,
								blendMode: "normal",
								effectPassGroups: [],
								mask: null,
							},
						],
					});

					const [red, green, blue, alpha] = readPixelRgba({
						source: canvas,
						width: SIZE,
						height: SIZE,
					});
					expect({
						condition: red > 200,
						message: `red channel drew ${red}, expected > 200`,
					});
					expect({
						condition: alpha > 200,
						message: `alpha drew ${alpha}, expected > 200`,
					});
					expect({
						condition: green < 20 && blue < 20,
						message: `green/blue drew ${green}/${blue}, expected < 20`,
					});
					return `image uploaded and rendered as r=${red} g=${green} b=${blue} a=${alpha}`;
				} finally {
					wasmCompositor.syncTextures({
						owner: CHECK_OWNER,
						textures: [],
					});
				}
			} finally {
				await tauriRemoveFile({ path }).catch(() => {});
			}
		},
	},
	{
		// The export pipeline's readback path. Reads the frame back as a Rust
		// `Vec<u8>` over a new `readbackFrame` wasm export, and compares the
		// result to what `getImageData()` produces from the same rendered
		// canvas (the path the exporter reads pixels from).
		//
		// The two readbacks describe the same pixels twice — once via the
		// Rust readback (`readbackFrame`) and once via the JS canvas the
		// compositor already maintains. They should agree byte-for-byte on
		// every output format wgpu reports. A channel-order bug (BGRA vs RGBA)
		// would land on the red↔blue swap test; a stride bug would land on
		// the cross-row check.
		name: "Rust readback parity",
		run: async () => {
			const SIZE = 16;
			const CHECK_OWNER = "check";
			const textureId = `${CHECK_OWNER}:rust-readback-${Date.now()}`;
			const plain = new Uint8Array(SIZE * SIZE * 4);
			for (let i = 0; i < plain.length; i += 4) {
				// Diagonal stripe: pattern is `i % 4` so the test catches
				// both byte-order bugs (R↔B swap) and stride bugs (off-by-row).
				plain[i] = (i * 7) & 0xff;
				plain[i + 1] = (i * 11) & 0xff;
				plain[i + 2] = (i * 13) & 0xff;
				plain[i + 3] = 0xff;
			}
			const texture = new ImageData(
				new Uint8ClampedArray(plain.buffer),
				SIZE,
				SIZE,
			);
			const source = await createImageBitmap(texture);

			try {
				wasmCompositor.syncTextures({
					owner: CHECK_OWNER,
					textures: [
						{
							kind: "external",
							id: textureId,
							source,
							width: SIZE,
							height: SIZE,
						},
					],
				});
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
					renderScale: 1,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId,
							transform: {
								centerX: SIZE / 2,
								centerY: SIZE / 2,
								width: SIZE,
								height: SIZE,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});

				const reference = readFullFrameRgba({
					source: wasmCompositor.getCanvas(),
					width: SIZE,
					height: SIZE,
				});

				const rustReadback = await wasmReadbackFrame({
					width: SIZE,
					height: SIZE,
					renderScale: 1,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId,
							transform: {
								centerX: SIZE / 2,
								centerY: SIZE / 2,
								width: SIZE,
								height: SIZE,
								rotationDegrees: 0,
								flipX: false,
								flipY: false,
							},
							opacity: 1,
							blendMode: "normal",
							effectPassGroups: [],
							mask: null,
						},
					],
				});

				expect({
					condition: rustReadback.width === SIZE && rustReadback.height === SIZE,
					message: `readback returned ${rustReadback.width}x${rustReadback.height}`,
				});
				expect({
					condition: rustReadback.pixels.length === SIZE * SIZE * 4,
					message: `readback returned ${rustReadback.pixels.length} bytes`,
				});

				let mismatched = 0;
				const tolerance = 2; // 1/255 chroma noise is fine
				for (let i = 0; i < reference.length; i++) {
					const diff = Math.abs(
						reference[i] - rustReadback.pixels[i],
					);
					if (diff > tolerance) mismatched++;
				}
				expect({
					condition: mismatched === 0,
					message: `${mismatched} pixels differ by more than ${tolerance}`,
				});
				return `readback agrees with getImageData on a ${SIZE}x${SIZE} frame (${SIZE * SIZE * 4} bytes)`;
			} finally {
				wasmCompositor.syncTextures({ owner: CHECK_OWNER, textures: [] });
			}
		},
	},
];

export async function runDesktopChecks({
	onResult,
}: {
	onResult: (result: CheckResult) => void;
}): Promise<CheckResult[]> {
	if (!tauriAvailable()) {
		throw new Error("These checks only apply to the desktop build");
	}

	const results: CheckResult[] = [];
	for (const check of checks) {
		const started = performance.now();
		try {
			const detail = await check.run();
			const elapsed = Math.round(performance.now() - started);
			const result = {
				name: check.name,
				passed: true,
				detail: `${detail} (${elapsed}ms)`,
			};
			results.push(result);
			onResult(result);
		} catch (error) {
			const result = {
				name: check.name,
				passed: false,
				detail: error instanceof Error ? error.message : String(error),
			};
			results.push(result);
			onResult(result);
		}
	}
	return results;
}
