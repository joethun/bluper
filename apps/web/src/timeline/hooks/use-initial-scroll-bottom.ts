import { type RefObject, useLayoutEffect, useRef } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";

interface UseInitialScrollBottomProps {
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: RefObject<HTMLDivElement | null>;
	onAfterScroll?: () => void;
	/** Defers the scroll until there is at least one track to measure against. */
	isReady: boolean;
}

/**
 * Scrolls the timeline tracks viewport to the bottom once on mount.
 * useLayoutEffect runs synchronously after React commits the DOM but before
 * the browser paints, so the initial scroll position is never visible.
 */
export function useInitialScrollBottom({
	tracksScrollRef,
	trackLabelsScrollRef,
	onAfterScroll,
	isReady,
}: UseInitialScrollBottomProps): void {
	const hasScrolledRef = useRef(false);
	// Callers pass an inline closure, which would change identity on every
	// render and re-run this layout effect each time. Because the effect bails
	// out *without* latching when there is nothing to scroll yet, that turned a
	// once-on-mount measurement into a `scrollHeight` read — and so a forced
	// synchronous reflow — on every render, including every zoom frame.
	const onAfterScrollRef = useCommittedRef(onAfterScroll);

	useLayoutEffect(() => {
		if (!isReady || hasScrolledRef.current) return;

		const viewport = tracksScrollRef.current;
		if (!viewport) return;

		const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
		if (maxScrollTop <= 0) return;

		viewport.scrollTop = maxScrollTop;

		if (trackLabelsScrollRef.current) {
			trackLabelsScrollRef.current.scrollTop = maxScrollTop;
		}

		onAfterScrollRef.current?.();
		hasScrolledRef.current = true;
	}, [isReady, tracksScrollRef, trackLabelsScrollRef, onAfterScrollRef]);
}
