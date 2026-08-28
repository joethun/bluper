/**
 * Programmatic scroll notifications for the timeline.
 *
 * The browser fires `scroll` asynchronously, so a component that mirrors
 * scroll position in React state is one frame behind whenever something
 * assigns `scrollLeft` imperatively. That is fine for user scrolling — the
 * position only moves a few pixels per frame — but zoom rewrites `scrollLeft`
 * to keep the zero-second mark anchored, and that jump is proportional to how
 * far the user is scrolled from the start of the timeline.
 *
 * Writers announce the new position here so subscribers can update in the
 * same commit, before paint.
 */

type ScrollListener = (scrollLeft: number) => void;

const listenersByElement = new WeakMap<HTMLElement, Set<ScrollListener>>();

export function subscribeToProgrammaticScroll({
	element,
	listener,
}: {
	element: HTMLElement;
	listener: ScrollListener;
}): () => void {
	let listeners = listenersByElement.get(element);
	if (!listeners) {
		listeners = new Set();
		listenersByElement.set(element, listeners);
	}
	listeners.add(listener);

	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			listenersByElement.delete(element);
		}
	};
}

/**
 * Announce that `element.scrollLeft` was just assigned.
 *
 * Reads the value back off the element, since the browser clamps an
 * out-of-range assignment. The preceding write already flushed layout, so
 * the read costs nothing extra.
 */
export function publishProgrammaticScroll({
	element,
}: {
	element: HTMLElement | null;
}): void {
	if (!element) return;

	const listeners = listenersByElement.get(element);
	if (!listeners) return;

	const { scrollLeft } = element;
	for (const listener of listeners) {
		listener(scrollLeft);
	}
}
