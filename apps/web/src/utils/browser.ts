import { tauriSaveBlob } from "@/lib/tauri-runtime";

/**
 * Hands a blob to the user as a file.
 *
 * There is no download manager here — a click on an `<a download>` in the
 * WebView is silently ignored — so this opens a save dialog and streams the
 * bytes to the chosen path. Resolves once the file has been written, or
 * immediately if the user cancels the dialog.
 *
 * Only for content that is already a `Blob` and small enough to be one, such as
 * a frame snapshot. An export is streamed to disk as it encodes and never
 * becomes a `Blob` at all.
 */
export async function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): Promise<void> {
	await tauriSaveBlob({ blob, defaultFilename: filename });
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
