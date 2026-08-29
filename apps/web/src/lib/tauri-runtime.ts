/**
 * Detects the Tauri 2 desktop runtime and exposes typed access to the plugin
 * commands and the app's own native commands. Wrapped so the web build doesn't
 * crash when these globals aren't injected — every entry point must be
 * optional-checked at the call site, or routed through `tauriAvailable`.
 *
 * On the desktop shell (apps/desktop/src-tauri) the WebView runs with the
 * `__TAURI__` and `__TAURI_INTERNALS__` globals exposed by Tauri. We don't
 * import `@tauri-apps/api` here to avoid a hard dependency on the JS plugin
 * package; the runtime API is small enough to invoke directly via the
 * `invoke` bridge.
 *
 * ## Why bytes never travel as JSON
 *
 * Tauri serialises an ordinary command payload with `JSON.stringify`, and a
 * `Uint8Array` inside it becomes an array of numbers — a 1 GB video turns into
 * a billion-element JS array and several GB of JSON text before Rust sees a
 * single byte. That is the memory ceiling the desktop build exists to remove,
 * so every byte-carrying call here passes the typed array as the *entire*
 * payload, which Tauri sends as an `application/octet-stream` body, and puts
 * its scalar arguments in headers instead.
 */

declare global {
	interface Window {
		__TAURI__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
		__TAURI_INTERNALS__?: {
			invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>;
			convertFileSrc?: (path: string, protocol?: string) => string;
			/**
			 * Registers a function the Rust side can call back into, returning the
			 * id it is reachable by. Injected by Tauri's own `core.js`; this is
			 * the whole of what `@tauri-apps/api`'s event module is built on.
			 */
			transformCallback?: <T>(
				callback: (message: T) => void,
				once?: boolean,
			) => number;
			unregisterCallback?: (id: number) => void;
		};
	}
}

export function tauriAvailable(): boolean {
	if (typeof window === "undefined") return false;
	return (
		typeof window.__TAURI_INTERNALS__?.invoke === "function" ||
		typeof window.__TAURI__?.invoke === "function"
	);
}

async function invoke<T>(
	cmd: string,
	args?: Record<string, unknown>,
	options?: { headers?: Record<string, string> },
): Promise<T> {
	if (typeof window === "undefined") {
		throw new Error("Tauri runtime is not available");
	}
	const internals = window.__TAURI_INTERNALS__;
	const legacy = window.__TAURI__;
	const call =
		typeof internals?.invoke === "function"
			? internals.invoke.bind(internals)
			: legacy?.invoke.bind(legacy);
	if (!call) {
		throw new Error("Tauri runtime is not available");
	}
	// Tauri 2 expects the args to be wrapped under `payload` for plugin commands
	// invoked via __TAURI_INTERNALS__. The legacy __TAURI__ shape used the args
	// directly. The plugin commands we call here all expect the wrapped shape.
	const payload = args ?? {};
	const result = await (
		call as (c: string, a?: unknown, o?: unknown) => Promise<T>
	)(cmd, payload, options);
	return result;
}

/**
 * Invokes a command with `bytes` as the raw request body. Tauri only takes the
 * binary path when the payload *is* a typed array, so anything else the command
 * needs has to ride along in `headers`.
 */
async function invokeWithBytes<T>({
	cmd,
	bytes,
	headers,
}: {
	cmd: string;
	bytes: Uint8Array;
	headers?: Record<string, string>;
}): Promise<T> {
	if (typeof window === "undefined") {
		throw new Error("Tauri runtime is not available");
	}
	const call = window.__TAURI_INTERNALS__?.invoke;
	if (typeof call !== "function") {
		throw new Error("Binary IPC requires the Tauri 2 runtime");
	}
	return (await call.call(
		window.__TAURI_INTERNALS__,
		cmd,
		bytes,
		headers ? { headers } : undefined,
	)) as T;
}

/**
 * Turns an absolute path into a URL the WebView can load over Tauri's `asset:`
 * protocol. The protocol answers range requests, so a `<video>` or a
 * `UrlSource` reads only the bytes it needs instead of pulling the whole file
 * into the page.
 */
export function tauriConvertFileSrc(path: string): string {
	const convert = window.__TAURI_INTERNALS__?.convertFileSrc;
	if (typeof convert !== "function") {
		throw new Error("Tauri asset protocol is not available");
	}
	return convert(path, "asset");
}

export type SaveDialogOptions = {
	title?: string;
	defaultPath?: string;
	filters?: Array<{ name: string; extensions: string[] }>;
};

export async function tauriSaveDialog(
	options: SaveDialogOptions,
): Promise<string | null> {
	const result = await invoke<string | null>("plugin:dialog|save", {
		options: {
			title: options.title,
			defaultPath: options.defaultPath,
			filters: options.filters,
		},
	});
	return result ?? null;
}

/**
 * Opens the file's folder in the system file manager with the file selected.
 *
 * The command is `reveal_item_in_dir` but its argument is the plural `paths`,
 * and it takes a list: the plugin grew multi-item support without renaming the
 * command. Passing the singular `path` the name suggests fails to deserialise
 * on the Rust side, so the call rejects before any file manager is asked.
 */
export async function tauriRevealItemInDir(path: string): Promise<void> {
	await invoke<void>("plugin:opener|reveal_item_in_dir", { paths: [path] });
}

/**
 * Picks media files with the OS file dialog, returning real filesystem paths.
 *
 * This is the only import route that yields a path. An `<input type="file">`
 * and an HTML drop both produce a `File` whose bytes the page can read but
 * whose location it can never learn, which is what forces media arriving that
 * way to be copied into the project before anything can decode it.
 */
export async function tauriOpenMediaFiles({
	title,
	extensions,
	multiple = true,
}: {
	title?: string;
	extensions: string[];
	multiple?: boolean;
}): Promise<string[]> {
	const result = await invoke<string[] | string | null>("plugin:dialog|open", {
		options: {
			title,
			multiple,
			directory: false,
			filters: [{ name: "Media", extensions }],
		},
	});

	if (result === null) return [];
	return Array.isArray(result) ? result : [result];
}

/* -------------------------------------------------------------------------- */
/* Shell events                                                                */
/* -------------------------------------------------------------------------- */

/** Stops delivery of the events a {@link tauriListen} call subscribed to. */
export type TauriUnlisten = () => void;

/**
 * Subscribes to an event emitted by the shell.
 *
 * The same three calls `@tauri-apps/api` makes — register a callback, hand its
 * id to the event plugin, hand the returned id back to unsubscribe — written
 * out here for the same reason as everything else in this file: the runtime
 * surface is small, and a JS dependency for it would have to be kept in step
 * with the Rust one.
 */
export async function tauriListen<T>({
	event,
	handler,
}: {
	event: string;
	handler: (payload: T) => void;
}): Promise<TauriUnlisten> {
	const transform = window.__TAURI_INTERNALS__?.transformCallback;
	if (typeof transform !== "function") {
		throw new Error("Tauri event bridge is not available");
	}

	const callbackId = transform<{ payload: T }>((message) => {
		handler(message.payload);
	});

	const eventId = await invoke<number>("plugin:event|listen", {
		event,
		target: { kind: "Any" },
		handler: callbackId,
	});

	return () => {
		void invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
		window.__TAURI_INTERNALS__?.unregisterCallback?.(callbackId);
	};
}

/**
 * Files dragged onto the window, reported by the shell rather than by the DOM.
 *
 * This is the only drop that carries paths. `dragDropEnabled` in
 * `tauri.conf.json` decides which of the two arrives: with it on, the webview
 * never sees an HTML drop event, and these come instead.
 */
export type TauriDragDropPayload = {
	paths: string[];
	position: { x: number; y: number };
};

export const TAURI_DRAG_ENTER = "tauri://drag-enter";
export const TAURI_DRAG_OVER = "tauri://drag-over";
export const TAURI_DRAG_DROP = "tauri://drag-drop";
export const TAURI_DRAG_LEAVE = "tauri://drag-leave";

/* -------------------------------------------------------------------------- */
/* Referenced media                                                            */
/* -------------------------------------------------------------------------- */

/** What a file on disk looks like right now. See `bluper_stat_file`. */
export type NativeFileStat = {
	path: string;
	size: number;
	/** Milliseconds since the Unix epoch, on the same scale as `File.lastModified`. */
	lastModified: number;
};

/**
 * Describes any file on disk, or null when there is no file there.
 *
 * Null is the answer a referenced asset gets when its file has been moved,
 * renamed or unplugged, and it is what puts the asset into its offline state
 * rather than an error.
 */
export async function tauriStatFile({
	path,
}: {
	path: string;
}): Promise<NativeFileStat | null> {
	return await invoke<NativeFileStat | null>("bluper_stat_file", { path });
}

/**
 * Grants the `asset:` protocol read access to one file outside the app's own
 * folders, and returns the canonical path it was granted under.
 *
 * Referenced media lives wherever the user keeps it, and the protocol's
 * configured scope covers only what the app writes itself. The grant lasts for
 * the life of the process, so this runs again for every referenced asset each
 * time a project loads.
 */
export async function tauriAllowMediaFile({
	path,
}: {
	path: string;
}): Promise<string> {
	return await invoke<string>("bluper_allow_media_file", { path });
}

/* -------------------------------------------------------------------------- */
/* Native media store                                                          */
/* -------------------------------------------------------------------------- */

export async function tauriMediaPath({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}): Promise<string> {
	return await invoke<string>("bluper_media_path", { projectId, mediaId });
}

export async function tauriListMedia({
	projectId,
}: {
	projectId: string;
}): Promise<string[]> {
	return await invoke<string[]>("bluper_list_media", { projectId });
}

export async function tauriRemoveMedia({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}): Promise<void> {
	await invoke<void>("bluper_remove_media", { projectId, mediaId });
}

export async function tauriClearMedia({
	projectId,
}: {
	projectId: string;
}): Promise<void> {
	await invoke<void>("bluper_clear_media", { projectId });
}

export async function tauriMediaSize({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}): Promise<number | null> {
	return await invoke<number | null>("bluper_media_size", {
		projectId,
		mediaId,
	});
}

export async function tauriScratchPath({
	name,
}: {
	name: string;
}): Promise<string> {
	return await invoke<string>("bluper_scratch_path", { name });
}

export async function tauriMoveFile({
	from,
	to,
}: {
	from: string;
	to: string;
}): Promise<void> {
	await invoke<void>("bluper_move_file", { from, to });
}

/**
 * Writes a line from the desktop self-check to the shell's stdout and log, so
 * `/desktop-check` can be run without watching the window.
 */
export async function tauriDiagnosticLog({
	line,
}: {
	line: string;
}): Promise<void> {
	await invoke<void>("bluper_diagnostic_log", { line });
}

/** Deletes a file inside the app's own directories. */
export async function tauriRemoveFile({
	path,
}: {
	path: string;
}): Promise<void> {
	await invoke<void>("bluper_remove_file", { path });
}

/**
 * Free bytes on the filesystem the app stores media on, or `null` when the
 * platform can't report it.
 */
export async function tauriAvailableDiskBytes(): Promise<number | null> {
	return await invoke<number | null>("bluper_available_disk_bytes");
}

/* -------------------------------------------------------------------------- */
/* Native video demux                                                          */
/* -------------------------------------------------------------------------- */

/** One encoded frame inside a GOP file. See {@link NativeGopInfo}. */
export type NativeChunkInfo = {
	/** Byte offset of this frame's packet within the GOP file. */
	offset: number;
	length: number;
	/** Presentation timestamp in seconds. */
	ptsSeconds: number;
	isKeyframe: boolean;
};

export type NativeVideoConfig = {
	/** Ready for `VideoDecoder.configure({ codec })`, profile and level included. */
	codec: string;
	codedWidth: number;
	codedHeight: number;
	/**
	 * Base64 `avcC`/`hvcC`/`vpcC`/`av1C`. Empty for Annex-B streams, which carry
	 * their parameter sets inline and must be configured with no `description`
	 * at all rather than an empty one.
	 */
	descriptionBase64: string;
	/** Clockwise display rotation in degrees: 0, 90, 180 or 270. */
	rotation: number;
};

export type NativeGopInfo = {
	config: NativeVideoConfig;
	chunks: NativeChunkInfo[];
	/** Absolute path of the file holding this GOP's packets, back to back. */
	scratchPath: string;
	startPtsSeconds: number;
	/** Presentation timestamp of the *last* frame in the GOP, not its end. */
	endPtsSeconds: number;
	/**
	 * Where to ask for the following GOP. Null at the end of the file. This is
	 * not derivable from `endPtsSeconds`, which lands back inside this same GOP.
	 */
	nextGopStartSeconds: number | null;
	isTerminal: boolean;
};

/**
 * Demuxes the GOP covering `startSeconds` and writes its packets to a scratch
 * file. No pixels come back: the browser's `VideoDecoder` still does the
 * decoding, this only replaces the container parsing.
 */
export async function tauriDecodeVideoGop({
	mediaPath,
	startSeconds,
}: {
	mediaPath: string;
	startSeconds: number;
}): Promise<NativeGopInfo> {
	return await invoke<NativeGopInfo>("bluper_decode_video_gop", {
		mediaPath,
		startSeconds,
	});
}

/** One frame decoded by the shell, as tightly packed I420 planes. */
export type NativeVideoFrame = {
	codedWidth: number;
	codedHeight: number;
	/** Clockwise display rotation in degrees: 0, 90, 180 or 270. */
	rotation: number;
	/** When this frame starts, in seconds. */
	ptsSeconds: number;
	/**
	 * When the next frame starts, so the caller knows how long this one is on
	 * screen. Null when this is the last picture in the file.
	 */
	nextPtsSeconds: number | null;
	/** Y, U and V back to back, with the strides below. */
	planes: Uint8Array;
	layout: Array<{ offset: number; stride: number }>;
};

/**
 * Header of a frame response: width, height and three plane lengths as
 * little-endian `u32`s, then rotation, then this frame's presentation time and
 * the next one's as `f64`s. Mirrors `media_frames::FRAME_HEADER_BYTES`.
 */
const VIDEO_FRAME_HEADER_BYTES = 4 * 6 + 8 + 8;

/**
 * Decodes the single frame shown at `atSeconds` in the shell.
 *
 * This is what a seek and a scrub use. The webview's own `VideoDecoder` has to
 * decode from the GOP's keyframe to reach an arbitrary time, and on sources
 * re-encoded with almost no keyframes — one GOP of 60 seconds and 1,499 frames —
 * that measured about 700ms per seek. The shell decodes with frame-level
 * threading across every core and sends back only the frame asked for: 89ms for
 * a jump, and 5ms while dragging, because the reader carries on from where it
 * was instead of starting at the keyframe again.
 *
 * Playing *forwards* stays on the webview's decoder, which is 0.71ms a frame and
 * moves no pixels across the IPC boundary at all.
 */
export async function tauriDecodeVideoFrame({
	mediaPath,
	atSeconds,
}: {
	mediaPath: string;
	atSeconds: number;
}): Promise<NativeVideoFrame> {
	const raw = await invoke<ArrayBuffer | Uint8Array>(
		"bluper_decode_video_frame",
		{ mediaPath, atSeconds },
	);
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	if (bytes.byteLength < VIDEO_FRAME_HEADER_BYTES) {
		throw new Error(
			`Decoded frame is too short to hold its header: ${bytes.byteLength} bytes`,
		);
	}
	const header = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		VIDEO_FRAME_HEADER_BYTES,
	);
	const codedWidth = header.getUint32(0, true);
	const codedHeight = header.getUint32(4, true);
	const planeSizes = [
		header.getUint32(8, true),
		header.getUint32(12, true),
		header.getUint32(16, true),
	];
	const rotation = header.getInt32(20, true);
	const ptsSeconds = header.getFloat64(24, true);
	const next = header.getFloat64(32, true);

	// I420 with no row padding, which is what the shell packs: luma at full
	// width, the two chroma planes at half, rounded up so an odd size keeps its
	// last row and column.
	const chromaStride = Math.ceil(codedWidth / 2);
	return {
		codedWidth,
		codedHeight,
		rotation,
		ptsSeconds,
		// The shell says `-1` for "nothing after this".
		nextPtsSeconds: next >= 0 ? next : null,
		planes: bytes.subarray(VIDEO_FRAME_HEADER_BYTES),
		layout: [
			{ offset: 0, stride: codedWidth },
			{ offset: planeSizes[0]!, stride: chromaStride },
			{ offset: planeSizes[0]! + planeSizes[1]!, stride: chromaStride },
		],
	};
}

/** Deletes every cached GOP file belonging to one media file. */
/**
 * What a media file turned out to hold, read from its container.
 *
 * Mirrors `media_decode::MediaProbe`. This is the shell's answer to the
 * question the page used to ask mediabunny on every import: what kind of media
 * is this, how long, how big, and in what codecs.
 */
export type NativeMediaProbe = {
	kind: "video" | "audio";
	durationSeconds: number;
	width: number | null;
	height: number | null;
	fps: number | null;
	hasAudio: boolean;
	/** In the export panel's vocabulary (`avc`, `hevc`, …), or null. */
	videoCodec: string | null;
	audioCodec: string | null;
	bitrate: number | null;
	canDecodeVideo: boolean;
};

/**
 * Reads a media file's header. Cheap — ffmpeg stops as soon as it has parsed
 * enough — so the import probe and the export's source-bitrate lookup both
 * make this same call.
 */
export async function tauriProbeMedia({
	path,
}: {
	path: string;
}): Promise<NativeMediaProbe> {
	return await invoke<NativeMediaProbe>("bluper_probe_media", { path });
}

/**
 * One frame from a media file, as a PNG `data:` URL.
 *
 * `atSeconds` is a hint: a seek past the end of a short clip falls back to the
 * first frame rather than failing. `maxEdge` bounds the longer side, keeping
 * the aspect ratio and never scaling up.
 */
export async function tauriMediaThumbnail({
	path,
	atSeconds = 1,
	maxEdge = 320,
}: {
	path: string;
	atSeconds?: number;
	maxEdge?: number;
}): Promise<string> {
	return await invoke<string>("bluper_media_thumbnail", {
		path,
		atSeconds,
		maxEdge,
	});
}

export async function tauriClearDecodeCache({
	mediaPath,
}: {
	mediaPath: string;
}): Promise<void> {
	await invoke<void>("bluper_clear_decode_cache", { mediaPath });
}

/* -------------------------------------------------------------------------- */
/* Native audio decode                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What the first decoded frame turned out to be — read off the frame rather
 * than the container, because HE-AAC decodes at twice the rate it declares.
 */
export type NativeAudioShape = {
	sampleRate: number;
	channels: number;
	/** Frames at `sampleRate`, from the container's declared duration. */
	totalFrames: number;
	durationSeconds: number;
};

export type NativeWaveformSegment = {
	shape: NativeAudioShape;
	/** Bucket index, on the track-wide grid, that the first peak belongs to. */
	firstBucket: number;
	/** One absolute peak per bucket, `f32` little-endian, base64. */
	peaksBase64: string;
	/** Where the next window starts, or null at the end of the track. */
	nextStartSeconds: number | null;
};

export type NativeAudioPcm = {
	shape: NativeAudioShape;
	/** One file per channel, each a flat run of little-endian `f32`. */
	channelPaths: string[];
	/** Frames the files actually hold, which is not always what was declared. */
	frames: number;
	/** Pass to {@link tauriReleaseAudioPcm} once the samples have been read. */
	token: string;
};

/**
 * Decodes one window of an audio track and folds it to peaks. The samples
 * themselves never cross the IPC boundary — a window comes back as a few
 * thousand floats rather than a few million.
 *
 * Pass `durationSeconds: 0` for the whole track in one call.
 */
export async function tauriAudioWaveformSegment({
	mediaPath,
	startSeconds,
	durationSeconds,
	bucketSize,
}: {
	mediaPath: string;
	startSeconds: number;
	durationSeconds: number;
	bucketSize: number;
}): Promise<NativeWaveformSegment> {
	return await invoke<NativeWaveformSegment>("bluper_audio_waveform_segment", {
		mediaPath,
		startSeconds,
		durationSeconds,
		bucketSize,
	});
}

/**
 * Decodes a whole audio track to `f32`, one file per channel, resampled and
 * mixed down to what the caller asks for. The files are the size of the decoded
 * track, so {@link tauriReleaseAudioPcm} has to run once they have been read.
 */
export async function tauriDecodeAudioPcm({
	mediaPath,
	sampleRate,
	maxChannels,
}: {
	mediaPath: string;
	sampleRate?: number;
	maxChannels?: number;
}): Promise<NativeAudioPcm> {
	return await invoke<NativeAudioPcm>("bluper_decode_audio_pcm", {
		mediaPath,
		sampleRate: sampleRate ?? null,
		maxChannels: maxChannels ?? null,
	});
}

/**
 * What a track turns out to be, without decoding it.
 *
 * Read off the first decoded frame rather than the container, because HE-AAC
 * decodes at twice the rate it declares. Cheap: the shell keeps the container
 * open between calls, so this is one frame's work.
 */
export async function tauriAudioShape({
	mediaPath,
	sampleRate,
	maxChannels,
}: {
	mediaPath: string;
	sampleRate?: number;
	maxChannels?: number;
}): Promise<NativeAudioShape> {
	return await invoke<NativeAudioShape>("bluper_audio_shape", {
		mediaPath,
		sampleRate: sampleRate ?? null,
		maxChannels: maxChannels ?? null,
	});
}

/** One window of decoded audio, planar `f32` per channel. */
export type NativeAudioWindowData = {
	channels: Float32Array<ArrayBuffer>[];
	sampleRate: number;
	frames: number;
	/** Where these samples belong on the track, in seconds. */
	firstSeconds: number;
};

/**
 * Bytes at the front of a window response: channel count, sample rate and
 * frame count as little-endian `u32`s, then the track time of the first frame
 * as an `f64`. Mirrors `media_audio::WINDOW_HEADER_BYTES`.
 */
const AUDIO_WINDOW_HEADER_BYTES = 4 + 4 + 4 + 8;

/**
 * Decodes one window of a track.
 *
 * This is what playback reads. {@link tauriDecodeAudioPcm} decodes the *whole*
 * track to disk before it returns, which on a 74-minute source measured 4.1s
 * and 1.71GB written — and playback needs one second of audio to begin, which
 * costs about 15ms. The whole-track route stays for export, which really does
 * want every sample at once.
 *
 * Comes back as an `ArrayBuffer` rather than JSON: a window is a few hundred
 * kilobytes, too much to base64 per window and too little to be worth a scratch
 * file and an `asset:` round trip.
 */
export async function tauriDecodeAudioWindow({
	mediaPath,
	startSeconds,
	durationSeconds,
	sampleRate,
	maxChannels,
}: {
	mediaPath: string;
	startSeconds: number;
	durationSeconds: number;
	sampleRate?: number;
	maxChannels?: number;
}): Promise<NativeAudioWindowData> {
	const raw = await invoke<ArrayBuffer | Uint8Array>(
		"bluper_decode_audio_window",
		{
			mediaPath,
			startSeconds,
			durationSeconds,
			sampleRate: sampleRate ?? null,
			maxChannels: maxChannels ?? null,
		},
	);
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
	if (bytes.byteLength < AUDIO_WINDOW_HEADER_BYTES) {
		throw new Error(
			`Decoded audio window is too short to hold its header: ${bytes.byteLength} bytes`,
		);
	}
	// A `DataView` over the exact region, because `bytes` may be a view into a
	// larger buffer and the offsets below are relative to the window.
	const header = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		AUDIO_WINDOW_HEADER_BYTES,
	);
	const channelCount = header.getUint32(0, true);
	const sampleRateOut = header.getUint32(4, true);
	const frames = header.getUint32(8, true);
	const firstSeconds = header.getFloat64(12, true);

	const channels: Float32Array<ArrayBuffer>[] = [];
	// Copied rather than viewed: a `Float32Array` over the response would keep
	// the whole window's buffer alive for as long as any channel is held, and
	// `copyToChannel` wants its own alignment anyway.
	for (let channel = 0; channel < channelCount; channel += 1) {
		const start =
			bytes.byteOffset +
			AUDIO_WINDOW_HEADER_BYTES +
			channel * frames * Float32Array.BYTES_PER_ELEMENT;
		const plane = new Float32Array(frames);
		if (
			start + frames * Float32Array.BYTES_PER_ELEMENT <=
			bytes.byteOffset + bytes.byteLength
		) {
			plane.set(new Float32Array(bytes.buffer, start, frames));
		}
		channels.push(plane);
	}

	return { channels, sampleRate: sampleRateOut, frames, firstSeconds };
}

/** Deletes the files a {@link tauriDecodeAudioPcm} run wrote. */
export async function tauriReleaseAudioPcm({
	token,
}: {
	token: string;
}): Promise<void> {
	await invoke<void>("bluper_release_audio_pcm", { token });
}

/* -------------------------------------------------------------------------- */
/* Streaming writes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How much of a file is held in memory at once while it's written. Each chunk
 * is read out of the `Blob` (which the browser keeps on disk), handed to the
 * IPC layer, and released before the next one is read, so peak usage is one
 * chunk regardless of the file's size.
 */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * A file open for writing on the native side. Bytes are appended chunk by
 * chunk; nothing is buffered in the page.
 */
export class TauriWriteStream {
	private readonly id: number;
	private closed = false;

	private constructor(id: number) {
		this.id = id;
	}

	static async open({ path }: { path: string }): Promise<TauriWriteStream> {
		const id = await invoke<number>("bluper_open_write", { path });
		return new TauriWriteStream(id);
	}

	/**
	 * Writes a chunk and resolves with the file's length so far.
	 *
	 * `position` places the write. Sequential writes can leave it out; a muxer
	 * that seeks back to patch a header it already wrote must pass it.
	 */
	async write({
		bytes,
		position,
	}: {
		bytes: Uint8Array;
		position?: number;
	}): Promise<number> {
		if (this.closed) {
			throw new Error("Cannot write to a closed stream");
		}
		const headers: Record<string, string> = { "stream-id": String(this.id) };
		if (position !== undefined) {
			headers["stream-position"] = String(position);
		}
		return await invokeWithBytes<number>({
			cmd: "bluper_write_chunk",
			bytes,
			headers,
		});
	}

	/** Flushes to disk and resolves with the total bytes written. */
	async close(): Promise<number> {
		if (this.closed) return 0;
		this.closed = true;
		return await invoke<number>("bluper_close_write", { id: this.id });
	}

	/** Closes the file and deletes it. Safe to call after `close`. */
	async abort(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await invoke<void>("bluper_abort_write", { id: this.id });
	}
}

/**
 * A container the shell's encoder can write, and the codecs it can write into
 * it on this machine.
 *
 * Mirrors `editor_core::export::sink::ContainerCapability`. This replaced the
 * WebCodecs probe the page used to run: the library that reports the encoder
 * is now the library that runs it, so a codec offered here cannot fail to
 * open a moment later.
 */
export type NativeExportCapability = {
	container: string;
	extension: string;
	audioOnly: boolean;
	/** Encodable video codecs, best first. Empty for an audio container. */
	videoCodecs: string[];
	audioCodecs: string[];
};

/**
 * Which containers and codecs this build can write. Asked once when the
 * export panel opens; the answer does not change while the app runs.
 */
export async function tauriExportCapabilities(): Promise<
	NativeExportCapability[]
> {
	return await invoke<NativeExportCapability[]>("bluper_export_capabilities");
}

/**
 * What the native encoder is opened with. Mirrors
 * `editor_core::export::sink::MediaSinkConfig` field for field; the Rust side
 * validates it and reports the reason a config was rejected, so a bad width
 * comes back as a sentence rather than an ffmpeg failure three frames in.
 *
 * A null `videoCodec` means an audio-only export, a null `audioCodec` a silent
 * one. The sink drops whatever it has no stream for rather than erroring, so a
 * caller need not branch on the container.
 */
export type NativeSinkConfig = {
	container: string;
	videoCodec: string | null;
	width: number;
	height: number;
	fpsNumerator: number;
	fpsDenominator: number;
	videoBitrate: number;
	audioCodec: string | null;
	audioSampleRate: number;
	audioChannels: number;
};

/**
 * The desktop shell's ffmpeg encoder, driven a frame at a time.
 *
 * The shell links `ffmpeg-next` against the system libavcodec, which the
 * webview has no way to reach on its own. Frames and audio travel as raw request bodies —
 * the same binary IPC `TauriWriteStream` uses — because a 1080p frame is 8 MB
 * and JSON would turn it into eight million numbers before Rust saw a byte.
 *
 * The scalars that go with each body (which session, which presentation
 * index) travel as headers for the same reason `bluper_write_chunk` puts its
 * `stream-id` there: a command with a raw body has no JSON map for tauri to
 * deserialise named arguments out of.
 */
export class NativeMediaSink {
	private readonly sessionId: number;
	private closed = false;

	private constructor(sessionId: number) {
		this.sessionId = sessionId;
	}

	static isSupported(): boolean {
		return tauriAvailable();
	}

	/** Opens an encoder against a scratch file and mints a session. */
	static async open({
		config,
	}: {
		config: NativeSinkConfig;
	}): Promise<NativeMediaSink> {
		const sessionId = await invoke<number>("bluper_export_start", {
			config,
		});
		return new NativeMediaSink(sessionId);
	}

	/**
	 * Encodes one frame. `pixels` is row-major RGBA8, exactly
	 * `width * height * 4` bytes — what `CanvasRenderingContext2D.getImageData`
	 * hands back, and what the wgpu readback produces.
	 */
	async writeFrame({
		pixels,
		ptsIndex,
	}: {
		pixels: Uint8Array;
		ptsIndex: number;
	}): Promise<void> {
		this.assertOpen();
		await invokeWithBytes<void>({
			cmd: "bluper_export_write_frame",
			bytes: pixels,
			headers: {
				"export-session-id": String(this.sessionId),
				"export-pts-index": String(ptsIndex),
			},
		});
	}

	/**
	 * Encodes one chunk of audio. `samples` is interleaved little-endian f32
	 * (`s0_c0, s0_c1, s1_c0, …`), `frames` many per channel. `ptsIndex` is the
	 * sample offset of the chunk, not a frame number — the audio stream's time
	 * base is `1 / sampleRate`.
	 */
	async writeAudio({
		samples,
		frames,
		ptsIndex,
	}: {
		samples: Float32Array;
		frames: number;
		ptsIndex: number;
	}): Promise<void> {
		this.assertOpen();
		const bytes = new Uint8Array(
			samples.buffer,
			samples.byteOffset,
			samples.byteLength,
		);
		await invokeWithBytes<void>({
			cmd: "bluper_export_write_audio",
			bytes,
			headers: {
				"export-session-id": String(this.sessionId),
				"export-frames": String(frames),
				"export-pts-index": String(ptsIndex),
			},
		});
	}

	/**
	 * Writes the trailer, closes the encoders and resolves with the scratch
	 * path holding the finished file. The caller moves it to the user's
	 * destination with `tauriMoveFile`.
	 */
	async finish(): Promise<string> {
		this.assertOpen();
		this.closed = true;
		return await invoke<string>("bluper_export_finish", {
			sessionId: this.sessionId,
		});
	}

	/**
	 * Drops the session without writing a trailer. The half-encoded file is
	 * left for the shell's scratch sweep. Idempotent, and safe to call after
	 * `finish` — an unknown session is a no-op on the Rust side, because a
	 * cancel racing a finish is an ordinary thing for a user to do.
	 */
	async cancel(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await invoke<void>("bluper_export_cancel", {
			sessionId: this.sessionId,
		});
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("This export session is already finished");
		}
	}
}

/**
 * Streams a `Blob` to `path` in bounded chunks.
 *
 * `blob.arrayBuffer()` is deliberately not used: it materialises the whole file
 * as one `ArrayBuffer`, which both doubles peak memory and runs into the engine's
 * single-buffer size limit on large exports. Slicing a `Blob` is cheap — the
 * browser keeps its backing bytes on disk and only reads the slice.
 */
async function tauriWriteBlobStreaming({
	path,
	blob,
	onProgress,
}: {
	path: string;
	blob: Blob;
	onProgress?: (bytesWritten: number) => void;
}): Promise<number> {
	const stream = await TauriWriteStream.open({ path });
	try {
		let offset = 0;
		let written = 0;
		while (offset < blob.size) {
			const end = Math.min(offset + CHUNK_BYTES, blob.size);
			const slice = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
			written = await stream.write({ bytes: slice });
			offset = end;
			onProgress?.(written);
		}
		return await stream.close();
	} catch (error) {
		await stream.abort().catch(() => {
			// The write already failed; losing the scratch file too isn't worth
			// masking the original error.
		});
		throw error;
	}
}

/**
 * Save dialog + streaming write: the desktop equivalent of a browser download,
 * for content that is already a `Blob`. Returns the path the file was written
 * to, or null if the user cancelled the dialog.
 *
 * Content that is produced incrementally (an export) should not come through
 * here — it should be streamed into a scratch file as it's encoded and moved
 * into place with {@link tauriMoveFile}, so it never exists as a `Blob` at all.
 */
export async function tauriSaveBlob({
	blob,
	defaultFilename,
	filters,
	title,
}: {
	blob: Blob;
	defaultFilename: string;
	filters?: Array<{ name: string; extensions: string[] }>;
	title?: string;
}): Promise<string | null> {
	const path = await tauriSaveDialog({
		title,
		defaultPath: defaultFilename,
		filters,
	});
	if (!path) return null;
	const scratch = await tauriScratchPath({ name: scratchNameFor(path) });
	await tauriWriteBlobStreaming({ path: scratch, blob });
	await tauriMoveFile({ from: scratch, to: path });
	return path;
}

/**
 * Scratch files live in the app's cache directory, which only accepts plain
 * names, so a user-chosen filename is reduced to something safe and made unique
 * enough that two concurrent saves can't collide.
 */
function scratchNameFor(destination: string): string {
	// Both separators: the destination comes from the OS save dialog, so on
	// Windows it arrives as `C:\Users\me\Videos\clip.mp4` with no forward slash
	// in it at all. Splitting on `/` alone would keep the whole path, and the
	// sanitiser below would flatten it to `C__Users_me_Videos_clip.mp4` — legal,
	// but not the filename, and `slice(-64)` would then cut a deep path down to
	// an arbitrary tail.
	const base = destination.split(/[\\/]/).pop() ?? "file";
	const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(-64) || "file";
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
}
