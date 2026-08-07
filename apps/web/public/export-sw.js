/*
 * Service worker for streaming OPFS export files to the browser as downloads.
 *
 * Lifecycle:
 *  - install/activate: skipWaiting + clients.claim so a new SW version takes
 *    over open tabs without a reload. Stale files left behind by a previous
 *    session are swept on activate.
 *  - fetch: intercepts only /__export-download requests. Anything else falls
 *    through to the default network handler.
 *  - message: { type: "sweep-stale" } triggers a cleanup pass on demand.
 *
 * The page calls registerExportServiceWorker() to install this. It must be
 * served from the origin root (sitting in /public) so its scope is "/".
 */

const EXPORT_DIR = "exports";
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await self.clients.claim();
			await sweepStaleExports();
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname !== "/__export-download") return;

	event.respondWith(handleDownload(url));
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "sweep-stale") {
		event.waitUntil(sweepStaleExports());
	}
});

async function getExportDir() {
	const root = await self.navigator.storage.getDirectory();
	return root.getDirectoryHandle(EXPORT_DIR, { create: true });
}

async function sweepStaleExports() {
	try {
		const dir = await getExportDir();
		const now = Date.now();
		for await (const [name, handle] of dir.entries()) {
			try {
				const file = await handle.getFile();
				if (now - file.lastModified > STALE_AFTER_MS) {
					await dir.removeEntry(name);
				}
			} catch {
				// Entry was removed between listing and inspection; safe to ignore.
			}
		}
	} catch {
		// OPFS unavailable in this SW context; nothing to sweep.
	}
}

async function handleDownload(url) {
	const id = url.searchParams.get("id");
	if (!id) {
		return new Response("Missing id", { status: 400 });
	}

	let file;
	try {
		const dir = await getExportDir();
		const fileHandle = await dir.getFileHandle(id);
		file = await fileHandle.getFile();
	} catch {
		return new Response("Export not found", { status: 404 });
	}

	const filename =
		url.searchParams.get("filename") || `${id}.mp4`;
	const mimeType =
		url.searchParams.get("mime") || "application/octet-stream";

	const headers = new Headers({
		"Content-Type": mimeType,
		"Content-Length": String(file.size),
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
		"Cache-Control": "no-store",
	});

	// Tie cleanup to body consumption. The transform's writable closes when the
	// download finishes (success) or the consumer cancels (network drop,
	// navigation away). Either way the file is gone after the response.
	const transform = new TransformStream({
		flush() {
			getExportDir()
				.then((dir) => dir.removeEntry(id))
				.catch(() => {});
		},
	});

	return new Response(file.stream().pipeThrough(transform), { headers });
}
