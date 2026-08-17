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
