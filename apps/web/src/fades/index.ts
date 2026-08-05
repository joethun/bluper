import {
	type FadeConfig,
	type TimelineElement,
} from "@/timeline/types";
import {
	roundMediaTime,
	type MediaTime,
} from "@/wasm";

export function readFade({
	element,
}: {
	element: TimelineElement;
}): FadeConfig | undefined {
	return "fade" in element ? element.fade : undefined;
}

/**
 * The longest a fade may run on a clip. A fade in and a fade out have to share
 * the clip between them, or the two ramps would overlap and neither would reach
 * full opacity.
 */
export function getMaxFadeDuration({
	element,
	edge,
}: {
	element: TimelineElement;
	edge: "in" | "out";
}): MediaTime {
	const fade = readFade({ element });
	const opposite = edge === "in" ? fade?.out : fade?.in;
	return opposite && opposite > 0
		? roundMediaTime({ time: element.duration / 2 })
		: element.duration;
}

/**
 * The opacity the fades put on a clip at `clipTime`, as a multiplier on whatever
 * the clip already resolved to. 1 outside both ramps.
 *
 * The ramps are clamped to half the clip each when both are set, so they meet in
 * the middle at worst instead of fighting over the same frames.
 */
export function resolveFadeOpacity({
	fade,
	clipTime,
	duration,
}: {
	fade: FadeConfig | undefined;
	clipTime: number;
	duration: number;
}): number {
	if (!fade) {
		return 1;
	}

	const bothSet = Boolean(fade.in && fade.out);
	const limit = bothSet ? duration / 2 : duration;

	let opacity = 1;

	const fadeIn = fade.in ? Math.min(fade.in, limit) : 0;
	if (fadeIn > 0 && clipTime < fadeIn) {
		opacity = Math.min(opacity, Math.max(0, clipTime / fadeIn));
	}

	const fadeOut = fade.out ? Math.min(fade.out, limit) : 0;
	if (fadeOut > 0) {
		const remaining = duration - clipTime;
		if (remaining < fadeOut) {
			opacity = Math.min(opacity, Math.max(0, remaining / fadeOut));
		}
	}

	return opacity;
}

/** Whether either ramp is set to something that will actually show. */
export function hasActiveFade({
	element,
}: {
	element: TimelineElement;
}): boolean {
	const fade = readFade({ element });
	return Boolean((fade?.in ?? 0) > 0 || (fade?.out ?? 0) > 0);
}

/**
 * Writes one edge of the fade, dropping the config entirely once neither edge
 * ramps — an empty `fade` object would otherwise linger in saved projects.
 */
export function withFadeEdge({
	fade,
	edge,
	duration,
}: {
	fade: FadeConfig | undefined;
	edge: "in" | "out";
	duration: MediaTime;
}): FadeConfig | undefined {
	const next: FadeConfig = {
		in: edge === "in" ? duration : fade?.in,
		out: edge === "out" ? duration : fade?.out,
	};

	const inDuration = next.in && next.in > 0 ? next.in : undefined;
	const outDuration = next.out && next.out > 0 ? next.out : undefined;
	if (!inDuration && !outDuration) {
		return undefined;
	}

	return {
		...(inDuration ? { in: inDuration } : {}),
		...(outDuration ? { out: outDuration } : {}),
	};
}
