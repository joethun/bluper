/**
 * Bridge between the page and the export Service Worker.
 *
 * The SW lives at /export-sw.js and intercepts /__export-download requests.
 * Once registered, the page can ask it to stream an OPFS file back to the
 * user by navigating a hidden `<a>` to that URL; the browser handles the
 * download UI from there, with no `Blob` materialized in JS memory.
 */

const SW_URL = "/export-sw.js";
const DOWNLOAD_PATH = "/__export-download";

type ServiceWorkerCapability = "ready" | "unsupported" | "failed";

function supportsServiceWorker(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined"
	);
}

let registrationPromise: Promise<ServiceWorkerCapability> | null = null;

/**
 * Registers the export SW. Idempotent: repeat calls reuse the same promise.
 * Errors are swallowed; the page can still fall back to the Blob path.
 */
export function registerExportServiceWorker(): Promise<ServiceWorkerCapability> {
	if (!supportsServiceWorker()) {
		return Promise.resolve("unsupported");
	}

	if (!registrationPromise) {
		registrationPromise = (async () => {
			try {
				const registration = await navigator.serviceWorker.register(SW_URL, {
					scope: "/",
				});
				// Wait for the SW to be controlling the page so the fetch
				// interception actually fires on the first download.
				if (registration.active && !navigator.serviceWorker.controller) {
					await new Promise<void>((resolve) => {
						const onChange = () => {
							navigator.serviceWorker.removeEventListener(
								"controllerchange",
								onChange,
							);
							resolve();
						};
						navigator.serviceWorker.addEventListener(
							"controllerchange",
							onChange,
						);
					});
				}
				return "ready";
			} catch (error) {
				console.warn("Export service worker registration failed:", error);
				return "failed";
			}
		})();
	}

	return registrationPromise;
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
