import {
	getMaxFadeDuration as _getMaxFadeDuration,
	resolveFadeOpacityValue as _resolveFadeOpacityValue,
	withFadeEdgeValue as _withFadeEdgeValue,
} from "bluper-wasm";
import type { FadeConfig, TimelineElement } from "@/timeline/types";
import { mediaTime, type MediaTime } from "@/wasm/media-time";

/**
 * Fading a clip against the background, owned by `editor-core::clip::fades`.
 *
 * A fade needs no neighbour, which is what separates it from a transition: the
 * clip ramps against whatever is behind it rather than against another clip.
 */

function wasmArgs<TArgs>({ args }: { args: TArgs }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return args as unknown as never;
}

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
	return mediaTime({
		ticks: _getMaxFadeDuration(wasmArgs({ args: { element, edge } })),
	});
}

/**
 * The opacity the fades put on a clip at `clipTime`, as a multiplier on whatever
 * the clip already resolved to. 1 outside both ramps.
 *
 * The ramps are clamped to half the clip each when both are set, so they meet in
 * the middle at worst instead of fighting over the same frames.
 *
 * Times are tick counts rather than `MediaTime`, because the renderer asks this
 * per clip per frame with whatever instant it is drawing.
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
	return _resolveFadeOpacityValue(
		wasmArgs({ args: { fade, clipTime, duration } }),
	);
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
	const { fade: next }: { fade: unknown } = _withFadeEdgeValue(
		wasmArgs({ args: { fade, edge, duration } }),
	);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return (next as FadeConfig | undefined) ?? undefined;
}
