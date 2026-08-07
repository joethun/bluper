import { useEffect, useState, useRef } from "react";
import { subscribeToProgrammaticScroll } from "@/timeline/scroll-sync";

interface UseScrollPositionReturn {
	scrollLeft: number;
	viewportWidth: number;
}

export function useScrollPosition({
	scrollRef,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
}): UseScrollPositionReturn {
	const [scrollLeft, setScrollLeft] = useState(0);
	const [viewportWidth, setViewportWidth] = useState(0);
	const rafIdRef = useRef<number | null>(null);

	useEffect(() => {
		const scrollElement = scrollRef.current;
		if (!scrollElement) return;

		const updatePosition = () => {
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
			}

			rafIdRef.current = requestAnimationFrame(() => {
				setScrollLeft(scrollElement.scrollLeft);
				setViewportWidth(scrollElement.clientWidth);
				rafIdRef.current = null;
			});
		};

		const resizeObserver = new ResizeObserver(() => {
			updatePosition();
		});

		updatePosition();

		// Imperative scrollLeft writes (zoom anchoring, scroll restore) land
		// before the browser's async `scroll` event. Applying them synchronously
		// keeps consumers from rendering a window that belongs to the previous
		// scroll position.
		const unsubscribeProgrammaticScroll = subscribeToProgrammaticScroll({
			element: scrollElement,
			listener: (nextScrollLeft) => {
				if (rafIdRef.current !== null) {
					cancelAnimationFrame(rafIdRef.current);
					rafIdRef.current = null;
				}
				setScrollLeft(nextScrollLeft);
				setViewportWidth(scrollElement.clientWidth);
			},
		});

		scrollElement.addEventListener("scroll", updatePosition, { passive: true });
		resizeObserver.observe(scrollElement);

		return () => {
			scrollElement.removeEventListener("scroll", updatePosition);
			resizeObserver.disconnect();
			unsubscribeProgrammaticScroll();
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
			}
		};
	}, [scrollRef]);

	return { scrollLeft, viewportWidth };
}
