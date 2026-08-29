/**
 * OS file drops, reported by the shell instead of by the DOM.
 *
 * A file dragged from a file manager is the ordinary way footage enters an
 * editor, and it is the only drop that can be imported by reference: an HTML
 * `drop` event carries a `File` whose bytes the page can read but whose
 * location it can never learn, so anything arriving that way has to be copied
 * before it can be decoded. `dragDropEnabled` in `tauri.conf.json` chooses
 * between the two, and it is on — which means the webview never sees an HTML
 * drop of an external file, and these events arrive instead.
 *
 * ## Why targets are registered rather than bound to elements
 *
 * The shell reports a drop against the window, with a position, and knows
 * nothing about what is under it. So the panels that accept media register
 * themselves here and the point is hit-tested against them.
 * `document.elementFromPoint` does the work, which means an overlay covering a
 * panel wins over the panel and a nested target wins over its parent — the same
 * order the DOM would have used, without asking each panel to reason about it.
 *
 * In-page dragging — an asset tile onto the timeline — is untouched by any of
 * this: it never leaves the webview and stays on the HTML drag events.
 */

import {
	TAURI_DRAG_DROP,
	TAURI_DRAG_ENTER,
	TAURI_DRAG_LEAVE,
	TAURI_DRAG_OVER,
	type TauriDragDropPayload,
	type TauriUnlisten,
	tauriAvailable,
	tauriListen,
} from "@/lib/tauri-runtime";

export type NativeDropPoint = { clientX: number; clientY: number };

export type NativeDropTarget = {
	/** Looked up per event: a panel may not be mounted when it registers. */
	element: () => HTMLElement | null;
	/** Files were dropped on this target. */
	onPaths: (args: { paths: string[] } & NativeDropPoint) => void;
	/** Whether a drag is currently over this target, for the drop overlay. */
	onOver: (args: { isOver: boolean }) => void;
};

const targets = new Set<NativeDropTarget>();
let overTarget: NativeDropTarget | null = null;
let subscription: Promise<TauriUnlisten[]> | null = null;

/**
 * Window physical pixels to viewport CSS pixels. The webview fills the window,
 * so the only difference between the two is the display's scale factor.
 */
function toClientPoint({
	position,
}: {
	position: TauriDragDropPayload["position"];
}): NativeDropPoint {
	const scale = window.devicePixelRatio || 1;
	return { clientX: position.x / scale, clientY: position.y / scale };
}

function targetAt({ clientX, clientY }: NativeDropPoint): NativeDropTarget | null {
	let node = document.elementFromPoint(clientX, clientY);

	while (node) {
		for (const target of targets) {
			if (target.element() === node) return target;
		}
		node = node.parentElement;
	}

	return null;
}

function setOverTarget({ target }: { target: NativeDropTarget | null }): void {
	if (overTarget === target) return;
	overTarget?.onOver({ isOver: false });
	overTarget = target;
	overTarget?.onOver({ isOver: true });
}

async function ensureSubscribed(): Promise<TauriUnlisten[]> {
	const track = (payload: TauriDragDropPayload) => {
		setOverTarget({ target: targetAt(toClientPoint({ position: payload.position })) });
	};

	return await Promise.all([
		tauriListen<TauriDragDropPayload>({
			event: TAURI_DRAG_ENTER,
			handler: track,
		}),
		tauriListen<TauriDragDropPayload>({
			event: TAURI_DRAG_OVER,
			handler: track,
		}),
		tauriListen<TauriDragDropPayload>({
			event: TAURI_DRAG_LEAVE,
			handler: () => setOverTarget({ target: null }),
		}),
		tauriListen<TauriDragDropPayload>({
			event: TAURI_DRAG_DROP,
			handler: (payload) => {
				const point = toClientPoint({ position: payload.position });
				setOverTarget({ target: null });

				const target = targetAt(point);
				if (!target || payload.paths.length === 0) return;
				target.onPaths({ paths: payload.paths, ...point });
			},
		}),
	]);
}

/**
 * Registers somewhere media can be dropped, and returns the undo of that.
 *
 * The subscription to the shell is opened once for the whole app and left open:
 * these are four listeners against a window that lives as long as the process,
 * and tearing them down when the last panel unmounts would only mean opening
 * them again when the next one mounts.
 */
export function registerNativeDropTarget(target: NativeDropTarget): () => void {
	if (!tauriAvailable()) return () => {};

	targets.add(target);
	subscription ??= ensureSubscribed().catch((error) => {
		console.error("Failed to subscribe to native file drops:", error);
		subscription = null;
		return [];
	});

	return () => {
		targets.delete(target);
		if (overTarget === target) overTarget = null;
	};
}
