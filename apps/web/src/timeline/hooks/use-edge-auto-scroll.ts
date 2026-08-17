import { useEffect, useRef } from "react";

interface UseEdgeAutoScrollParams {
	isActive: boolean;
	/**
	 * Per-frame liveness check. Defaults to `true` once `isActive` is true.
	 * Callers that distinguish "click-and-hold" from "actually dragging" (e.g.
	 * the playhead) pass a getter that returns false until movement has been
	 * observed, so the initial click position is not treated as a near-edge
	 * cursor and the timeline does not scroll while the user is holding still.
	 */
	getIsActive?: () => boolean;
	getMouseClientX: () => number;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	contentWidth: number;
	edgeThreshold?: number;
	maxScrollSpeed?: number;
}

export function useEdgeAutoScroll({
	isActive,
	getIsActive,
	getMouseClientX,
	rulerScrollRef,
	tracksScrollRef,
	contentWidth,
	edgeThreshold = 100,
	maxScrollSpeed = 15,
}: UseEdgeAutoScrollParams): void {
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		if (!isActive) {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			return;
		}

		const step = () => {
			if (getIsActive && !getIsActive()) {
				rafRef.current = requestAnimationFrame(step);
				return;
			}

			const rulerViewport = rulerScrollRef.current;
			const tracksViewport = tracksScrollRef.current;
			if (!rulerViewport || !tracksViewport) {
				rafRef.current = requestAnimationFrame(step);
				return;
			}

			const viewportRect = rulerViewport.getBoundingClientRect();
			const mouseX = getMouseClientX();
			const mouseXRelative = mouseX - viewportRect.left;

			const viewportWidth = rulerViewport.clientWidth;
			const intrinsicContentWidth = rulerViewport.scrollWidth;
			const effectiveContentWidth = Math.max(
				contentWidth,
				intrinsicContentWidth,
			);
			const scrollMax = Math.max(0, effectiveContentWidth - viewportWidth);

			let scrollSpeed = 0;

			if (mouseXRelative < edgeThreshold && rulerViewport.scrollLeft > 0) {
				const edgeDistance = Math.max(0, mouseXRelative);
				const intensity = 1 - edgeDistance / edgeThreshold;
				scrollSpeed = -maxScrollSpeed * intensity;
			} else if (
				mouseXRelative > viewportWidth - edgeThreshold &&
				rulerViewport.scrollLeft < scrollMax
			) {
				const edgeDistance = Math.max(0, viewportWidth - mouseXRelative);
				const intensity = 1 - edgeDistance / edgeThreshold;
				scrollSpeed = maxScrollSpeed * intensity;
			}

			if (scrollSpeed !== 0) {
				const newScrollLeft = Math.max(
					0,
					Math.min(scrollMax, rulerViewport.scrollLeft + scrollSpeed),
				);
				rulerViewport.scrollLeft = newScrollLeft;
				tracksViewport.scrollLeft = newScrollLeft;
			}

			rafRef.current = requestAnimationFrame(step);
		};

		rafRef.current = requestAnimationFrame(step);

		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [
		isActive,
		getIsActive,
		getMouseClientX,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth,
		edgeThreshold,
		maxScrollSpeed,
	]);
}
