"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useResizeObserver } from "@/hooks/use-resize-observer";
import { TIMELINE_AUDIO_WAVEFORM_COLOR } from "./theme";
import {
	buildWaveformSampleBuckets,
	sampleSourceWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import type { RetimeConfig } from "@/timeline";
import { getBarFractionFromOutputAmplitude } from "@/timeline/audio-display";
import { waveformCache } from "@/services/waveform-cache/service";
import { findScrollParent } from "@/utils/browser";
import { cn } from "@/utils/ui";

const BAR_WIDTH = 1;
const BAR_GAP = 1;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const WAVEFORM_BURN_COLOR = "rgba(255, 110, 20, 0.9)";
export const WAVEFORM_GAIN_SAMPLE_COUNT = 200;

/**
 * Inputs that decide whether the canvas needs repainting. Compared field by
 * field rather than serialised: this runs on every scroll frame for every audio
 * clip on the timeline, and `gainSamples` alone holds
 * WAVEFORM_GAIN_SAMPLE_COUNT entries. `gainSamples` and `retime` are memoised
 * per element upstream, so identity is a sound stand-in for their contents —
 * and a stale identity can only cause an extra repaint, never a missed one.
 */
interface RenderSignature {
	elementWidth: number;
	clipLeft: number;
	clipRight: number;
	visibleWidth: number;
	canvasW: number;
	canvasH: number;
	barCount: number;
	dpr: number;
	clipDurationSec: number;
	sourceStartSec: number;
	pixelsPerSecond: number;
	retime: RetimeConfig | undefined;
	summarySourceKey: string;
	summarySampleRate: number;
	summaryTotalSamples: number;
	summaryBucketSize: number;
	gainSamples: number[] | undefined;
	color: string;
	burnColor: string;
}

function isSameRenderSignature({
	previous,
	next,
}: {
	previous: RenderSignature | null;
	next: RenderSignature;
}): boolean {
	return (
		previous !== null &&
		previous.elementWidth === next.elementWidth &&
		previous.clipLeft === next.clipLeft &&
		previous.clipRight === next.clipRight &&
		previous.visibleWidth === next.visibleWidth &&
		previous.canvasW === next.canvasW &&
		previous.canvasH === next.canvasH &&
		previous.barCount === next.barCount &&
		previous.dpr === next.dpr &&
		previous.clipDurationSec === next.clipDurationSec &&
		previous.sourceStartSec === next.sourceStartSec &&
		previous.pixelsPerSecond === next.pixelsPerSecond &&
		previous.retime === next.retime &&
		previous.summarySourceKey === next.summarySourceKey &&
		previous.summarySampleRate === next.summarySampleRate &&
		previous.summaryTotalSamples === next.summaryTotalSamples &&
		previous.summaryBucketSize === next.summaryBucketSize &&
		previous.gainSamples === next.gainSamples &&
		previous.color === next.color &&
		previous.burnColor === next.burnColor
	);
}

function sampleGainAtClipTime({
	samples,
	clipTimeSec,
	clipDurationSec,
}: {
	samples: number[];
	clipTimeSec: number;
	clipDurationSec: number;
}): number {
	if (samples.length === 0 || clipDurationSec <= 0) {
		return 1;
	}

	const progress = Math.max(0, Math.min(1, clipTimeSec / clipDurationSec));
	const rawIndex = progress * (samples.length - 1);
	const lo = Math.floor(rawIndex);
	const hi = Math.min(samples.length - 1, lo + 1);
	return samples[lo] + (samples[hi] - samples[lo]) * (rawIndex - lo);
}

interface AudioWaveformProps {
	sourceKey: string;
	sourceFile?: File;
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	gainSamples?: number[];
	pixelsPerSecond: number;
	clipDurationSec: number;
	retime?: RetimeConfig;
	sourceStartSec: number;
	color?: string;
	burnColor?: string;
	className?: string;
}

export function AudioWaveform({
	sourceKey,
	sourceFile,
	audioUrl,
	audioBuffer,
	gainSamples,
	pixelsPerSecond,
	clipDurationSec,
	retime,
	sourceStartSec,
	color = TIMELINE_AUDIO_WAVEFORM_COLOR,
	burnColor = WAVEFORM_BURN_COLOR,
	className = "",
}: AudioWaveformProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const summaryRef = useRef<SourceWaveformSummary | null>(null);
	const waveformConfigRef = useCommittedRef({
		gainSamples,
		pixelsPerSecond,
		clipDurationSec,
		retime,
		sourceStartSec,
		color,
		burnColor,
	});
	const scrollParentRef = useRef<HTMLElement | null>(null);
	const heightRef = useRef<number>(0);
	const lastRenderSignatureRef = useRef<RenderSignature | null>(null);

	const clearCanvas = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		const ctx = canvas.getContext("2d");
		if (ctx) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
		lastRenderSignatureRef.current = null;
	}, []);

	const drawVisible = useCallback(() => {
		const container = containerRef.current;
		const canvas = canvasRef.current;
		const summary = summaryRef.current;
		const height = heightRef.current;

		if (!container || !canvas || !summary || height <= 0) {
			clearCanvas();
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const elementWidth = containerRect.width;
		if (elementWidth <= 0) {
			clearCanvas();
			return;
		}

		const scrollParent = scrollParentRef.current;

		let clipLeft: number;
		let clipRight: number;

		if (scrollParent) {
			const parentRect = scrollParent.getBoundingClientRect();
			clipLeft = Math.max(0, parentRect.left - containerRect.left);
			clipRight = Math.min(elementWidth, parentRect.right - containerRect.left);
		} else {
			clipLeft = Math.max(0, -containerRect.left);
			clipRight = Math.min(
				elementWidth,
				window.innerWidth - containerRect.left,
			);
		}

		const visibleWidth = clipRight - clipLeft;
		if (visibleWidth <= 0) {
			clearCanvas();
			return;
		}

		const {
			gainSamples: gainSamplesValue,
			pixelsPerSecond: pixelsPerSecondValue,
			clipDurationSec: clipDurationSecValue,
			retime: retimeValue,
			sourceStartSec: sourceStartSecValue,
			color: colorValue,
			burnColor: burnColorValue,
		} = waveformConfigRef.current;
		const dpr = window.devicePixelRatio || 1;
		const canvasW = Math.max(1, Math.ceil(visibleWidth * dpr));
		const canvasH = Math.max(1, Math.round(height * dpr));
		const barCount = Math.max(1, Math.floor(visibleWidth / BAR_STEP));
		const renderSignature: RenderSignature = {
			elementWidth,
			clipLeft,
			clipRight,
			visibleWidth,
			canvasW,
			canvasH,
			barCount,
			dpr,
			clipDurationSec: clipDurationSecValue,
			sourceStartSec: sourceStartSecValue,
			pixelsPerSecond: pixelsPerSecondValue,
			retime: retimeValue,
			summarySourceKey: summary.sourceKey,
			summarySampleRate: summary.sampleRate,
			summaryTotalSamples: summary.totalSamples,
			summaryBucketSize: summary.bucketSize,
			gainSamples: gainSamplesValue,
			color: colorValue,
			burnColor: burnColorValue,
		};
		if (
			isSameRenderSignature({
				previous: lastRenderSignatureRef.current,
				next: renderSignature,
			})
		) {
			return;
		}
		lastRenderSignatureRef.current = renderSignature;

		canvas.width = canvasW;
		canvas.height = canvasH;
		canvas.style.width = `${visibleWidth}px`;
		canvas.style.height = `${height}px`;
		canvas.style.left = `${clipLeft}px`;

		const backingScaleX = dpr;
		const backingScaleY = canvasH / height;

		const sampleBuckets = buildWaveformSampleBuckets({
			clipLeftPx: clipLeft,
			clipRightPx: clipRight,
			barCount,
			pixelsPerSecond: pixelsPerSecondValue,
			clipDurationSec: clipDurationSecValue,
			sourceStartSec: sourceStartSecValue,
			retime: retimeValue,
			sampleRate: summary.sampleRate,
			maxSampleExclusive: summary.totalSamples,
			barStepPx: BAR_STEP,
		});
		const amplitudes = sampleSourceWaveformSummary({
			summary,
			buckets: sampleBuckets,
		});

		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return;
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvasW, canvasH);

		const clipBottom = canvasH;

		for (let i = 0; i < barCount; i++) {
			const barCenterPx = clipLeft + i * BAR_STEP + BAR_WIDTH * 0.5;
			const clipCenterSec = Math.max(
				0,
				Math.min(clipDurationSecValue, barCenterPx / pixelsPerSecondValue),
			);
			const gain =
				gainSamplesValue != null
					? sampleGainAtClipTime({
							samples: gainSamplesValue,
							clipTimeSec: clipCenterSec,
							clipDurationSec: clipDurationSecValue,
						})
					: 1;
			const amplitude = Math.max(0, amplitudes[i] ?? 0);
			const outputAmplitude = amplitude * Math.max(0, gain);
			const fraction = getBarFractionFromOutputAmplitude({ outputAmplitude });
			const barH = fraction > 0 ? Math.max(1, fraction * height) : 0;
			if (barH <= 0) {
				continue;
			}

			const barLeft = i * BAR_STEP;
			const barRight = barLeft + BAR_WIDTH;
			const deviceLeft = Math.round(barLeft * backingScaleX);
			const deviceRight = Math.max(
				deviceLeft + 1,
				Math.round(barRight * backingScaleX),
			);
			const deviceTop = Math.round((height - barH) * backingScaleY);
			const deviceHeight = Math.max(1, clipBottom - deviceTop);

			ctx.fillStyle = colorValue;
			ctx.fillRect(
				deviceLeft,
				deviceTop,
				deviceRight - deviceLeft,
				deviceHeight,
			);

			if (outputAmplitude > 1) {
				const burnHeight = Math.max(1, Math.round(BAR_WIDTH * backingScaleY));
				ctx.fillStyle = burnColorValue;
				ctx.fillRect(
					deviceLeft,
					deviceTop,
					deviceRight - deviceLeft,
					burnHeight,
				);
			}
		}
	}, [clearCanvas, waveformConfigRef]);

	useEffect(() => {
		let isCancelled = false;
		summaryRef.current = null;
		clearCanvas();

		void waveformCache
			.getSourceSummary({
				sourceKey,
				audioBuffer,
				sourceFile,
				audioUrl,
			})
			.then((summary) => {
				if (isCancelled) {
					return;
				}
				summaryRef.current = summary;
				drawVisible();
			})
			.catch(() => {
				// Waveform loading failed (e.g. corrupt file, unsupported format).
				// Fail silently — a missing waveform is preferable to an error state.
				if (!isCancelled) {
					clearCanvas();
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [audioBuffer, audioUrl, clearCanvas, drawVisible, sourceFile, sourceKey]);

	useLayoutEffect(() => {
		drawVisible();
	}, [
		drawVisible,
		gainSamples,
		pixelsPerSecond,
		clipDurationSec,
		retime,
		sourceStartSec,
		color,
		burnColor,
	]);

	// Scroll fires far more often than once per frame, and every audio clip on
	// the timeline listens to the same scroll parent. Calling drawVisible per
	// event meant one scroll burst did (clips x events) forced layout reads and
	// canvas repaints; coalescing onto a frame collapses that to one pass per
	// clip per frame, which is all the display can show anyway.
	const drawFrameRef = useRef<number | null>(null);
	const scheduleDraw = useCallback(() => {
		if (drawFrameRef.current !== null) {
			return;
		}
		drawFrameRef.current = requestAnimationFrame(() => {
			drawFrameRef.current = null;
			drawVisible();
		});
	}, [drawVisible]);

	useEffect(
		() => () => {
			if (drawFrameRef.current !== null) {
				cancelAnimationFrame(drawFrameRef.current);
				drawFrameRef.current = null;
			}
		},
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		scrollParentRef.current = findScrollParent({ element: container });
		const scrollParent = scrollParentRef.current;
		if (!scrollParent) {
			return;
		}

		scrollParent.addEventListener("scroll", scheduleDraw, { passive: true });
		return () => scrollParent.removeEventListener("scroll", scheduleDraw);
	}, [scheduleDraw]);

	const onResize = useCallback(
		(entry: ResizeObserverEntry) => {
			heightRef.current = entry.contentRect.height;
			scheduleDraw();
		},
		[scheduleDraw],
	);

	useResizeObserver({ ref: containerRef, onResize });

	return (
		<div ref={containerRef} className={cn("relative size-full", className)}>
			<canvas ref={canvasRef} className="absolute bottom-0" />
		</div>
	);
}
