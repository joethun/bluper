/**
 * Bridge between the page and the export Service Worker.
 *
 * The SW lives at /export-sw.js and intercepts /__export-download requests.
 * Once registered, the page can ask it to stream an OPFS file back to the
 * user as a download by navigating a hidden `<a>` to that URL; the browser
 * handles the download UI from there, with no `Blob` materialized in JS memory.
 *
 * The SW is registered eagerly on editor mount. The export path itself does
 * NOT await registration — instead it reads the cached status synchronously
 * and falls back to the Blob path if the SW isn't ready yet. Otherwise an
 * export clicked during the SW install would sit at 0% for several seconds
 * (or forever if `controllerchange` never fires).
 *
 * In the Tauri desktop shell exports bypass the browser entirely: bytes are
 * handed to the native save dialog via the `dialog:save` plugin command.
 * The SW is skipped so it never tries to register on a `tauri://` origin.
 */

import { tauriAvailable } from "@/lib/tauri-runtime";

const SW_URL = "/export-sw.js";
const DOWNLOAD_PATH = "/__export-download";
const SW_TIMEOUT_MS = 10_000;

export type ServiceWorkerCapability =
	| "pending"
	| "ready"
	| "unsupported"
	| "failed";

function supportsServiceWorker(): boolean {
	if (tauriAvailable()) return false;
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined"
	);
}

let registrationPromise: Promise<ServiceWorkerCapability> | null = null;
let cachedStatus: ServiceWorkerCapability = tauriAvailable()
	? "unsupported"
	: "pending";

/**
 * Synchronous read of the SW's current state. The export path uses this to
 * decide whether to take the OPFS path (only when "ready") without blocking
 * the encoder on registration.
 */
export function getExportServiceWorkerStatus(): ServiceWorkerCapability {
	return cachedStatus;
}

/**
 * Registers the export SW. Idempotent: repeat calls reuse the same promise.
 * Errors are swallowed; the page can still fall back to the Blob path.
 */
export function registerExportServiceWorker(): Promise<ServiceWorkerCapability> {
	if (!supportsServiceWorker()) {
		cachedStatus = "unsupported";
		return Promise.resolve("unsupported");
	}

	if (!registrationPromise) {
		registrationPromise = (async () => {
			try {
				await navigator.serviceWorker.register(SW_URL, { scope: "/" });
				// `navigator.serviceWorker.ready` resolves once there's an active
				// SW, not just a registered one. The previous version only checked
				// `registration.active` and could resolve "ready" before the SW
				// had a chance to install, leaving the first download racing the
				// install and silently 404'ing.
				await navigator.serviceWorker.ready;
				if (!navigator.serviceWorker.controller) {
					await waitForController(SW_TIMEOUT_MS);
				}
				cachedStatus = "ready";
				return "ready" as const;
			} catch (error) {
				console.warn("Export service worker registration failed:", error);
				cachedStatus = "failed";
				return "failed" as const;
			}
		})();
	}

	return registrationPromise;
}

function waitForController(timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve) => {
		if (navigator.serviceWorker.controller) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onChange,
			);
			resolve();
		}, timeoutMs);
		const onChange = () => {
			clearTimeout(timer);
			navigator.serviceWorker.removeEventListener(
				"controllerchange",
				onChange,
			);
			resolve();
		};
		navigator.serviceWorker.addEventListener("controllerchange", onChange);
	});
}

/**
 * Triggers a browser download of an OPFS file the SW has access to. Waits
 * for the SW to be controlling the page so the interception fires.
 */
export async function triggerOPFSDownload({
	id,
	filename,
	mimeType,
}: {
	id: string;
	filename: string;
	mimeType: string;
}): Promise<void> {
	const status = await registerExportServiceWorker();
	if (status !== "ready") {
		throw new Error("Service worker not available");
	}

	const url = new URL(DOWNLOAD_PATH, window.location.origin);
	url.searchParams.set("id", id);
	url.searchParams.set("filename", filename);
	url.searchParams.set("mime", mimeType);

	const anchor = document.createElement("a");
	anchor.href = url.toString();
	anchor.rel = "noopener";
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
}
