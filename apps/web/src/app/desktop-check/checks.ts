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
	Input,
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	AudioBufferSource,
	BufferTarget,
	CanvasSource,
	Mp4OutputFormat,
	Output,
	Quality,
	StreamTarget,
	VideoSampleSink,
} from "mediabunny";
import {
	TauriWriteStream,
	tauriAvailable,
	tauriAvailableDiskBytes,
	tauriConvertFileSrc,
	tauriDiagnosticLog,
	tauriMoveFile,
	tauriRemoveFile,
	tauriScratchPath,
} from "@/lib/tauri-runtime";
import { TauriExportTarget } from "@/services/export/tauri-export-target";
import { TauriMediaStore } from "@/services/storage/tauri-media-store";
import {
	formatStorageBytes,
	readStorageQuotaStatus,
} from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { createMediaSource, toInputSource } from "@/media/source";
import {
	createAudioBuffer,
	decodeAudioBufferFromRef,
} from "@/media/decode-audio";
import { createTimelineAudioBuffer } from "@/media/audio";
import { getMediaTypeFromFile } from "@/media/file-types";
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
import { EditorCore } from "@/core";
import {
	gpuRenderer,
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { buildAdjustmentFilterPasses } from "@/adjustments/filter-passes";
import { wasmCompositor } from "@/services/renderer/compositor/wasm-compositor";
import { keepSourceAlpha } from "@/effects/canvas";
import {
	effectsRegistry,
	paintEffectedLayer,
	registerDefaultEffects,
} from "@/effects";
import { buildDefaultParamValues } from "@/params/registry";
import { supportsCanvasFilter } from "@/effects/canvas-filter-support";
import { readFullFrameRgba, readPixelRgba } from "@/services/renderer/canvas-utils";

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
}: {
	frames?: number;
	width?: number;
	height?: number;
} = {}): Promise<File> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	expect({
		condition: context !== null,
		message: "could not get a 2D canvas context",
	});

	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const videoSource = new CanvasSource(canvas, {
		codec: "avc",
		bitrate: new Quality({ bitrate: 1_000_000 }),
	});
	output.addVideoTrack(videoSource, { frameRate: 30 });
	await output.start();

	for (let i = 0; i < frames; i++) {
		if (!context) break;
		context.fillStyle = `hsl(${(i * 18) % 360} 80% 50%)`;
		context.fillRect(0, 0, width, height);
		await videoSource.add(i / 30, 1 / 30);
	}
	videoSource.close();
	await output.finalize();

	const encoded = target.buffer;
	if (!encoded) throw new Error("encoding produced no bytes");
	return new File([encoded], "check.mp4", { type: "video/mp4" });
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
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("could not get a 2D canvas context");
	context.fillStyle = "rgb(255, 0, 0)";
	context.fillRect(0, 0, width, height / 2);
	context.fillStyle = "rgb(0, 0, 255)";
	context.fillRect(0, height / 2, width, height / 2);

	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const videoSource = new CanvasSource(canvas, {
		codec: "avc",
		quality: new Quality({ bitrate: 2_000_000 }),
	});
	output.addVideoTrack(videoSource, { frameRate: fps });
	const audioSource = new AudioBufferSource({
		codec: "aac",
		quality: new Quality({ bitrate: 128_000 }),
	});
	output.addAudioTrack(audioSource);
	await output.start();

	const frames = Math.round(seconds * fps);
	for (let i = 0; i < frames; i++) {
		await videoSource.add(i / fps, 1 / fps);
	}
	videoSource.close();

	const frameCount = Math.round(seconds * sampleRate);
	const tone = new Float32Array(new ArrayBuffer(frameCount * 4));
	for (let i = 0; i < frameCount; i++) {
		tone[i] = amplitude * Math.sin((2 * Math.PI * toneHz * i) / sampleRate);
	}
	await audioSource.add(
		createAudioBuffer({
			channels: [tone, tone.slice()],
			frameCount,
			sampleRate,
		}),
	);
	audioSource.close();

	await output.finalize();
	const encoded = target.buffer;
	if (!encoded) throw new Error("encoding the probe clip produced no bytes");
	return new File([encoded], "probe.mp4", { type: "video/mp4" });
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
		name: "Export streams to a file and decodes",
		run: async () => {
			// The whole export path, end to end: encode into the streaming
			// target, then reopen the finished file through the same source
			// abstraction the editor decodes clips with.
			const handle = await TauriExportTarget.create({ extension: "mp4" });
			let finished = false;
			try {
				const canvas = document.createElement("canvas");
				canvas.width = 320;
				canvas.height = 240;
				const context = canvas.getContext("2d");
				expect({
					condition: context !== null,
					message: "could not get a 2D canvas context",
				});

				const output = new Output({
					format: new Mp4OutputFormat(),
					target: new StreamTarget(handle.writableStream, { chunked: true }),
				});
				const videoSource = new CanvasSource(canvas, {
					codec: "avc",
					bitrate: new Quality({ bitrate: 1_000_000 }),
				});
				output.addVideoTrack(videoSource, { frameRate: 30 });
				await output.start();

				const frames = 30;
				for (let i = 0; i < frames; i++) {
					if (!context) break;
					context.fillStyle = `hsl(${(i * 12) % 360} 80% 50%)`;
					context.fillRect(0, 0, canvas.width, canvas.height);
					await videoSource.add(i / 30, 1 / 30);
				}
				videoSource.close();
				await output.finalize();
				finished = true;

				const url = tauriConvertFileSrc(handle.path);
				const input = new Input({
					source: toInputSource({ ref: { kind: "url", url } }),
					formats: ALL_FORMATS,
				});
				try {
					const track = await input.getPrimaryVideoTrack();
					expect({
						condition: track !== null,
						message: "the exported file has no video track",
					});
					expect({
						condition:
							track?.displayWidth === 320 && track?.displayHeight === 240,
						message: `exported track is ${track?.displayWidth}x${track?.displayHeight}`,
					});
					const duration = await input.computeDuration();
					expect({
						condition: Math.abs(duration - frames / 30) < 0.2,
						message: `exported duration was ${duration.toFixed(3)}s`,
					});
					return `${frames} frames muxed to disk and read back over asset:// (${duration.toFixed(2)}s, ${track?.displayWidth}x${track?.displayHeight})`;
				} finally {
					input.dispose();
				}
			} finally {
				if (finished) {
					await tauriRemoveFile({ path: handle.path }).catch(() => {});
				} else {
					await handle.dispose();
				}
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
				return `decoded a ${sample?.displayWidth}x${sample?.displayHeight} frame at 0.25s over asset://`;
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
			// per frame — enough to drop playback to a slideshow.
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

			const target = new OffscreenCanvas(width, height);
			const targetCtx = target.getContext("2d", { willReadFrequently: true });
			if (!targetCtx) throw new Error("no 2d context");

			const definition = effectsRegistry.get("green-screen");
			const params = buildDefaultParamValues(definition.params);
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
			return `brightness(2) took 64 to ${red} through the compositor`;
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
			const textureId = `first-frame-probe-${Date.now()}`;
			const frame = new VideoFrame(source, { timestamp: 0 });

			try {
				wasmCompositor.syncTextures([
					{ kind: "video", id: textureId, source: frame, width: SIZE, height: SIZE },
				]);
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
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
				wasmCompositor.syncTextures([]);
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

			wasmCompositor.syncTextures([
				{
					kind: "rendered",
					id: "retention-probe",
					contentHash: "retention-probe",
					width: SIZE,
					height: SIZE,
					draw: (ctx) => {
						ctx.drawImage(source, 0, 0);
					},
				},
			]);
			wasmCompositor.render({
				width: SIZE,
				height: SIZE,
				// Black, so a lost frame reads as the flicker the user sees.
				clear: { color: [0, 0, 0, 1] },
				items: [
					{
						type: "layer",
						textureId: "retention-probe",
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
			// squished instead of cropped. `cropToSurface` copies a frame into a
			// canvas first for exactly this reason; what follows measures the quirk
			// and then the helper's answer to it.
			expect({
				condition: typeof VideoFrame !== "undefined",
				message: "this engine has no VideoFrame, so the preview cannot decode",
			});

			// Four quadrants, each its own red level, so a sub-rect draw that landed
			// on the wrong pixels is unmistakable in the readback.
			const source = new OffscreenCanvas(8, 8);
			const sourceCtx = source.getContext("2d");
			if (!sourceCtx) throw new Error("no source context");
			const QUADRANTS = [
				{ x: 0, y: 0, red: 0 },
				{ x: 4, y: 0, red: 80 },
				{ x: 0, y: 4, red: 160 },
				{ x: 4, y: 4, red: 240 },
			];
			for (const quadrant of QUADRANTS) {
				sourceCtx.fillStyle = `rgb(${quadrant.red}, 0, 0)`;
				sourceCtx.fillRect(quadrant.x, quadrant.y, 4, 4);
			}

			const frame = new VideoFrame(source, { timestamp: 0 });
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
					? `this engine honours a source rect on a frame (${direct}); the copy is belt and braces`
					: `a source rect on a frame lands on the wrong pixels here (${direct} instead of 240); through a canvas it reads ${viaCanvas}`;
			} finally {
				frame.close();
			}
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

			// Recorded rather than asserted: which codecs this engine's WebCodecs
			// takes is its business, and it is allowed to take none of them. What
			// the check is for is that the answer never decides whether audio plays.
			const input = new Input({
				source: toInputSource({ ref: { kind: "blob", blob } }),
				formats: ALL_FORMATS,
			});
			let claimed = "unknown";
			try {
				const track = await input.getPrimaryAudioTrack();
				expect({
					condition: track !== null,
					message: "the FLAC fixture has no audio track, so it failed to parse",
				});
				claimed = String(await track!.canDecode());
			} finally {
				input.dispose();
			}

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

				const neutral = await renderPixels({ params: {} });
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
					const label = `${key.replace("adjust.", "")} ${delta.toFixed(1)}`;
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
			// mediabunny reads best. The extension is the fallback answer.
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
					codec: await resolveExportVideoCodec({
						format,
						width: 640,
						height: 360,
					}),
				})),
			);
			const audio = await Promise.all(
				listExportFormats({ kind: "audio" }).map(async ({ format, spec }) => ({
					label: spec.label,
					encoding: await resolveExportAudioEncoding({
						format,
						numberOfChannels: 2,
						sampleRate: 48000,
					}),
				})),
			);

			expect({
				condition: video.some(({ codec }) => codec !== null),
				message: "no video container could be encoded at all on this engine",
			});

			// WAV is the floor: PCM samples are written by mediabunny itself and
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
				const input = new Input({
					source: toInputSource({ ref: { kind: "url", url } }),
					formats: ALL_FORMATS,
				});
				let exportedDuration = 0;
				try {
					const audioTrack = await input.getPrimaryAudioTrack();
					const videoTrack = await input.getPrimaryVideoTrack();
					expect({
						condition: audioTrack !== null,
						message: "the exported WAV has no audio track",
					});
					expect({
						condition: videoTrack === null,
						message: "an audio-only export wrote a video track",
					});
					exportedDuration = await input.computeDuration();
					expect({
						condition: Math.abs(exportedDuration - seconds) < 0.05,
						message: `exported ${exportedDuration.toFixed(3)}s of audio, expected ${seconds}s`,
					});
				} finally {
					input.dispose();
				}

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
				wasmCompositor.syncTextures([
					{
						kind: "rendered",
						id: "orientation-probe",
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
				]);
				wasmCompositor.render({
					width: SIZE,
					height: SIZE,
					clear: { color: [0, 0, 0, 1] },
					items: [
						{
							type: "layer",
							textureId: "orientation-probe",
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

				const codec = await resolveExportVideoCodec({
					format: "mp4",
					width: SIZE,
					height: SIZE,
				});
				expect({
					condition: codec !== null,
					message: "this engine has no video encoder, so nothing can be exported",
				});

				// Encodes six frames and reads the picture back out. `copy` is what
				// the exporter does — draw the composited frame into a 2D canvas and
				// encode that; the other way round is handing the compositor's own
				// canvas to `CanvasSource`, which is what put every export on its
				// head.
				const encodeAndRead = async ({
					copy,
				}: {
					copy: boolean;
				}): Promise<VerticalOrder> => {
					const surface = document.createElement("canvas");
					surface.width = SIZE;
					surface.height = SIZE;
					const surfaceCtx = surface.getContext("2d");
					if (!surfaceCtx) throw new Error("no encode surface context");

					const target = new BufferTarget();
					const output = new Output({
						format: new Mp4OutputFormat(),
						target,
					});
					const videoSource = new CanvasSource(copy ? surface : composited, {
						codec: codec!,
						quality: new Quality({ bitrate: 2_000_000 }),
					});
					output.addVideoTrack(videoSource, { frameRate: 30 });
					await output.start();
					for (let i = 0; i < 6; i++) {
						// Re-rendered every frame: a GPU canvas is only reliably readable
						// until the browser next composites it.
						renderProbe();
						if (copy) {
							surfaceCtx.clearRect(0, 0, SIZE, SIZE);
							surfaceCtx.drawImage(composited, 0, 0, SIZE, SIZE);
						}
						await videoSource.add(i / 30, 1 / 30);
					}
					videoSource.close();
					await output.finalize();

					const encoded = target.buffer;
					expect({
						condition: encoded !== null,
						message: "encoding the compositor canvas produced no bytes",
					});

					const input = new Input({
						source: toInputSource({
							ref: { kind: "blob", blob: new Blob([encoded!]) },
						}),
						formats: ALL_FORMATS,
					});
					try {
						const track = await input.getPrimaryVideoTrack();
						expect({
							condition: track !== null,
							message: "the re-encoded canvas has no video track",
						});
						const sample = await new VideoSampleSink(track!).getSample(2 / 30);
						expect({
							condition: sample !== null,
							message: "the re-encoded canvas decoded to no frame",
						});
						try {
							return readVerticalOrder({
								source: sample!.toCanvasImageSource(),
								width: SIZE,
								height: SIZE,
							});
						} finally {
							sample!.close();
						}
					} finally {
						input.dispose();
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
				wasmCompositor.syncTextures([]);
			}
		},
	},
	{
		name: "Every audio codec an export may pick can really encode",
		run: async () => {
			// `resolveExportAudioEncoding` asks WebCodecs whether a codec is
			// supported and believes the answer. This engine has already been caught
			// lying about that once — it reports FLAC as decodable and then fails the
			// first packet — so the same claim is checked here the only way it can
			// be: by encoding a second of sound and reading the samples back.
			//
			// Each codec is announced before it is tried, because an encoder that
			// aborts the process rather than rejecting leaves the marker as the only
			// evidence of which one it was.
			const sampleRate = 44100;
			const seconds = 1;
			const frameCount = Math.round(sampleRate * seconds);
			const tone = new Float32Array(new ArrayBuffer(frameCount * 4));
			for (let i = 0; i < frameCount; i++) {
				tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
			}

			const encodeOne = async ({
				format,
			}: {
				format: ExportFormat;
			}): Promise<string> => {
				const spec = getExportFormatSpec({ format });
				const encoding = await resolveExportAudioEncoding({
					format,
					numberOfChannels: 2,
					sampleRate,
				});
				if (!encoding) return `${spec.label}=none claimed`;

				const name = `${spec.label}/${encoding.codec}`;
				trace({ line: `${name}: encoding` });

				const encoded = await withDeadline({
					label: `${name} encode`,
					timeoutMs: 8_000,
					run: async () => {
						const target = new BufferTarget();
						const output = new Output({
							format: spec.createOutputFormat(),
							target,
						});
						const source = new AudioSampleSource({
							codec: encoding.codec,
							...(encoding.bitrate !== null && {
								quality: new Quality({ bitrate: encoding.bitrate }),
							}),
						});
						output.addAudioTrack(source);
						await output.start();

						const data = new Float32Array(frameCount * 2);
						data.set(tone, 0);
						data.set(tone, frameCount);
						const sample = new AudioSample({
							format: "f32-planar",
							sampleRate,
							numberOfChannels: 2,
							numberOfFrames: frameCount,
							timestamp: 0,
							data,
						});
						try {
							await source.add(sample);
						} finally {
							sample.close();
						}
						source.close();
						await output.finalize();
						return target.buffer;
					},
				});
				if (!encoded) return `${name} wrote nothing`;

				trace({ line: `${name}: encoded ${encoded.byteLength} bytes, decoding` });

				const decoded = await withDeadline({
					label: `${name} decode`,
					timeoutMs: 8_000,
					run: () =>
						decodeAudioBufferFromRef({
							ref: { kind: "blob", blob: new Blob([encoded]) },
							sampleRate,
						}),
				});
				if (!decoded) return `${name} decoded to nothing`;

				const gaps = findAudioDropouts({ buffer: decoded });
				return gaps.count === 0
					? `${name} ok`
					: `${name} DROPPED OUT (${gaps.count} silent windows from ${gaps.firstAtSeconds?.toFixed(2)}s)`;
			};

			// PCM first because it needs no encoder at all, then Opus, then AAC: if
			// a stalled encoder leaves the engine unable to run the next one, the
			// order is what separates "this codec is broken" from "the one before it
			// broke everything after it".
			const ORDER: ExportFormat[] = [
				"wav",
				"ogg",
				"webm",
				"mkv",
				"mp4",
				"mov",
				"m4a",
			];
			const outcomes: string[] = [];
			for (const format of ORDER) {
				const label = getExportFormatSpec({ format }).label;
				try {
					outcomes.push(await encodeOne({ format }));
				} catch (error) {
					outcomes.push(
						`${label}=THREW (${error instanceof Error ? error.message : String(error)})`,
					);
				}
			}

			const broken = outcomes.filter(
				(outcome) => !outcome.endsWith(" ok") && !outcome.endsWith("none claimed"),
			);
			expect({
				condition: broken.length === 0,
				message: `a container's audio codec passed the support check and then failed to encode — ${outcomes.join(", ")}`,
			});

			return outcomes.join(", ");
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
			const fixtureInput = new Input({
				source: toInputSource({ ref: { kind: "blob", blob: file } }),
				formats: ALL_FORMATS,
			});
			let fixture: VerticalOrder = {
				order: "indeterminate",
				detail: "not decoded",
			};
			try {
				fixture = await withDeadline({
					label: "decoding the probe clip back",
					timeoutMs: 30_000,
					run: async () => {
						const track = await fixtureInput.getPrimaryVideoTrack();
						expect({
							condition: track !== null,
							message: "the probe clip has no video track",
						});
						const sample = await new VideoSampleSink(track!).getSample(0.2);
						expect({
							condition: sample !== null,
							message: "the probe clip decoded to no frame",
						});
						try {
							return readVerticalOrder({
								source: sample!.toCanvasImageSource(),
								width: WIDTH,
								height: HEIGHT,
							});
						} finally {
							sample!.close();
						}
					},
				});
			} finally {
				fixtureInput.dispose();
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

				const codec = await resolveExportVideoCodec({
					format: "mp4",
					width: WIDTH,
					height: HEIGHT,
				});
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
				const input = new Input({
					source: toInputSource({ ref: { kind: "url", url } }),
					formats: ALL_FORMATS,
				});
				let exported: VerticalOrder = {
					order: "indeterminate",
					detail: "not decoded",
				};
				try {
					exported = await withDeadline({
						label: "decoding the exported picture",
						timeoutMs: 30_000,
						run: async () => {
							const track = await input.getPrimaryVideoTrack();
							expect({
								condition: track !== null,
								message: "the export has no video track",
							});
							const sample = await new VideoSampleSink(track!).getSample(
								SECONDS / 2,
							);
							expect({
								condition: sample !== null,
								message: "the export decoded to no frame",
							});
							try {
								return readVerticalOrder({
									source: sample!.toCanvasImageSource(),
									width: WIDTH,
									height: HEIGHT,
								});
							} finally {
								sample!.close();
							}
						},
					});
				} finally {
					input.dispose();
				}

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
