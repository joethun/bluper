import {
	audioBufferPeak as _audioBufferPeak,
	averageRateOverWindow as _averageRateOverWindow,
	clampAudioBufferPeak as _clampAudioBufferPeak,
	sampleLinear as _sampleLinear,
	stretcherWindowPlan as _stretcherWindowPlan,
} from "bluper-wasm";
import type { RetimeConfig } from "@/timeline";

/**
 * Audio retiming math, now owned by `editor-core::audio`.
 *
 * The wrapper code around the `soundtouchjs` call still lives in TypeScript:
 * `OfflineAudioContext` is a browser-only API and the library reads PCM straight
 * through it. What moves here is the small numerics that the wrapper calls —
 * sampling a frame buffer, sizing the render's retune windows, averaging the
 * curve's speed over one of those windows, finding a buffer's peak amplitude,
 * clamping samples in place — so both implementations agree on the same
 * answer at the boundaries the browser hands over.
 */

export function sampleLinear({
	channelData,
	position,
}: {
	channelData: number[] | Float32Array;
	position: number;
}): number {
	return _sampleLinear({
		channelData: Array.from(channelData),
		position,
	});
}

/**
 * Average speed across a single render window. The browser calls this once per
 * window (up to {@link MAX_TEMPO_UPDATES} per clip render) and tunes the
 * stretcher to the result.
 */
export function averageRateOverWindow({
	from,
	to,
	clipDuration,
	retime,
}: {
	from: number;
	to: number;
	clipDuration: number;
	retime: RetimeConfig;
}): number {
	return _averageRateOverWindow({ from, to, clipDuration, retime });
}

export interface StretcherWindowPlan {
	windowCount: number;
	windowSeconds: number;
	quantumSeconds: number;
	quantaPerWindow: number;
}

/**
 * Sizes the retune windows the pitch-preserved curve render will use. The
 * browser schedules each suspension on a quantum boundary, so this also
 * reports the quantum length and the number of quanta per window.
 */
export function stretcherWindowPlan({
	clipDuration,
	targetSampleRate,
}: {
	clipDuration: number;
	targetSampleRate: number;
}): StretcherWindowPlan {
	const plan = _stretcherWindowPlan({ clipDuration, targetSampleRate });
	return {
		windowCount: plan.windowCount,
		windowSeconds: plan.windowSeconds,
		quantumSeconds: plan.quantumSeconds,
		quantaPerWindow: plan.quantaPerWindow,
	};
}

/**
 * The largest absolute sample across every channel of `channels`. Used to
 * decide whether a render needs the limiter pass at all.
 */
export function audioBufferPeak({
	channels,
}: {
	channels: Float32Array[];
}): number {
	return _audioBufferPeak(channels);
}

/**
 * Clamps every sample in `channels` to `[-maxPeak, maxPeak]` in place. The
 * post-limiter render can still spike past the headroom by a fraction of a
 * dB on some engines, so this is what catches the tail.
 */
export function clampAudioBufferPeak({
	channels,
	maxPeak,
}: {
	channels: Float32Array[];
	maxPeak: number;
}): void {
	_clampAudioBufferPeak(channels, maxPeak);
}
