"use client";

import { useEffect } from "react";

/**
 * Input types whose native context menu is the editing one — Cut, Copy, Paste
 * and Select All against the caret. Every other type (`range`, `checkbox`,
 * `color`, `file`) has no caret, so right-clicking it gets the WebView's page
 * menu instead, which is the one being removed.
 *
 * An `<input>` with no `type` reports `"text"`, so it is covered here.
 */
const TEXT_INPUT_TYPES = new Set([
	"email",
	"number",
	"password",
	"search",
	"tel",
	"text",
	"url",
]);

/**
 * Whether the WebView would open its *editing* menu over this element.
 *
 * Deliberately not `isTypableDOMElement` from `utils/browser`: that answers
 * "would a keystroke land in this?", which is the right question for
 * swallowing a keybinding and the wrong one here — it counts a slider and a
 * checkbox as typable, and those get the page menu.
 */
function hasNativeEditingMenu({ element }: { element: HTMLElement }): boolean {
	if (element.isContentEditable) return true;

	if (element instanceof HTMLTextAreaElement) {
		return !element.disabled;
	}

	if (element instanceof HTMLInputElement) {
		return !element.disabled && TEXT_INPUT_TYPES.has(element.type);
	}

	return false;
}

/**
 * Suppresses the WebView's own context menu.
 *
 * The shell is an application window, not a page, so the menu the WebView
 * opens on right-click is wrong everywhere it appears: it offers Reload, Back
 * and Copy Image Address against an editor that has no navigation, and on the
 * surfaces that carry a real context menu — the preview, the timeline, the
 * asset panel, the project list — it is a second menu competing with the
 * app's own.
 *
 * Radix already calls `preventDefault()` from its `ContextMenuTrigger` and
 * does not stop propagation, so this document-level listener only decides
 * what happens on the surfaces that have no menu of their own, where the
 * answer is nothing. Preventing an already-prevented event is a no-op.
 *
 * Text fields keep theirs: that menu is Cut/Copy/Paste against the caret,
 * which the app does not reimplement and which carries none of the navigation
 * entries this exists to remove.
 */
export function NativeMenuSuppressor() {
	useEffect(() => {
		const handleContextMenu = (event: MouseEvent) => {
			const { target } = event;
			if (
				target instanceof HTMLElement &&
				hasNativeEditingMenu({ element: target })
			) {
				return;
			}
			event.preventDefault();
		};

		document.addEventListener("contextmenu", handleContextMenu);

		return () => {
			document.removeEventListener("contextmenu", handleContextMenu);
		};
	}, []);

	return null;
}
