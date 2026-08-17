import { tauriAvailable, tauriSaveBlob } from "@/lib/tauri-runtime";

/**
 * Hands a blob to the user as a file.
 *
 * The desktop shell has no download manager — a click on an `<a download>`
 * there is silently ignored — so it opens a save dialog and streams the bytes
 * to the chosen path instead. Resolves once the file has been written, or
 * immediately after the click in the browser, where the download continues on
 * its own.
 */
export async function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): Promise<void> {
	if (tauriAvailable()) {
		await tauriSaveBlob({ blob, defaultFilename: filename });
		return;
	}

	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function findScrollParent({
	element,
}: {
	element: HTMLElement;
}): HTMLElement | null {
	let parent = element.parentElement;
	while (parent) {
		const { overflow, overflowX } = window.getComputedStyle(parent);
		if (/auto|scroll/.test(overflow + overflowX)) return parent;
		parent = parent.parentElement;
	}
	return null;
}

export function isTypableDOMElement({
	element,
}: {
	element: HTMLElement;
}): boolean {
	if (element.isContentEditable) return true;

	if (element.tagName === "INPUT") {
		return !(element as HTMLInputElement).disabled;
	}

	if (element.tagName === "TEXTAREA") {
		return !(element as HTMLTextAreaElement).disabled;
	}

	return false;
}
