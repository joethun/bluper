import { useEffect, useRef } from "react";

/**
 * Runs `callback` once per animation frame, with the milliseconds since the
 * previous one.
 *
 * The callback is read through a ref rather than depended on, so a caller that
 * rebuilds it — the preview's render pass closes over the render tree, which is
 * a new object on every mousemove of a drag — does not cancel and re-request
 * the frame each time. Restarting the loop mid-gesture skipped a frame at the
 * point where the picture most needed to keep up, which is exactly during a
 * scrub or a trim.
 */
export function useRafLoop(callback: ({ time }: { time: number }) => void) {
	const callbackRef = useRef(callback);

	useEffect(() => {
		callbackRef.current = callback;
	}, [callback]);

	useEffect(() => {
		let frameId = 0;
		// The first frame has nothing to measure against, so it only records
		// the clock.
		let previousTime: number | null = null;

		const loop = (time: number) => {
			if (previousTime !== null) {
				callbackRef.current({ time: time - previousTime });
			}
			previousTime = time;
			frameId = requestAnimationFrame(loop);
		};

		frameId = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frameId);
	}, []);
}
