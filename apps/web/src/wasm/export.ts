import {
	exportVideoBitrate as _exportVideoBitrate,
	listExportResolutions as _listExportResolutions,
	planExport as _planExport,
	startExport as _startExport,
	encodeFrame as _encodeFrame,
	finalizeExport as _finalizeExport,
	cancelExport as _cancelExport,
	readbackFrame as _readbackFrame,
} from "bluper-wasm";
import type { ReadbackFrame } from "bluper-wasm";

import type { FrameDescriptor } from "@/services/renderer/compositor/types";
import type { TCanvasSize } from "@/project/types";

/**
 * One size the export panel may offer. `shortSide` is the number the "p" in
 * "1080p" names — the shorter of the two sides, so a portrait project's 720p
 * is 720x1280 rather than a landscape frame.
 */
export interface ExportResolution {
	shortSide: number;
	width: number;
	height: number;
}

export interface ListExportResolutionsOptions {
	canvas: TCanvasSize;
}

export interface ExportVideoBitrateOptions {
	sourceBitrate: number;
	canvas: TCanvasSize;
	output: ExportResolution;
}

type ExportTrackKind = "video" | "audio" | "both";

interface ExportTrackSpec {
	container: string;
	kind: ExportTrackKind;
	fpsNumerator: number;
	fpsDenominator: number;
	videoBitrate: number;
	audioSampleRate: number;
	audioChannels: number;
}

export interface PlanExportOptions {
	spec: ExportTrackSpec;
	durationTicks: number;
}

export interface PlanExportResult {
	frameCount: number;
	ticksPerFrame: number;
}

export interface StartExportOptions {
	spec: ExportTrackSpec;
	durationTicks: number;
}

export interface StartExportResult {
	sessionId: number;
	frameCount: number;
	ticksPerFrame: number;
}

export interface EncodeFrameOptions {
	sessionId: number;
	frameIndex: number;
}

export interface FrameProgress {
	sessionId: number;
	frameIndex: number;
	framesCompleted: number;
	frameCount: number;
}

export interface SessionIdOptions {
	sessionId: number;
}

export interface ExportSessionStatus {
	sessionId: number;
	cancelled: boolean;
	completedFrames: number;
}

/**
 * How many frames a duration produces at the given fps. Today
 * `SceneExporter` derives this in TypeScript: it computes a per-frame tick
 * count from `TICKS_PER_SECOND * denominator / numerator` and floors
 * `duration / ticksPerFrame` to get the renderer's loop bound. Centralising
 * the math in Rust is the small integration seam between today's exporter
 * and the Rust control plane that step 1 of the port is building — both
 * sides agree on the same `frameCount`, so when step 3 swaps mediabunny for
 * an ffmpeg encoder the JS loop bound does not silently change.
 */
export function planExport({
	spec,
	durationTicks,
}: PlanExportOptions): PlanExportResult {
	const result = _planExport({ spec, durationTicks });
	return {
		frameCount: result.frameCount,
		ticksPerFrame: result.ticksPerFrame,
	};
}

/**
 * Mints a session id, registers it against the Rust control plane, and
 * returns the loop bound the renderer will iterate up to. The `sessionId`
 * returned here is the identifier every follow-up call uses; an export
 * without a session id cannot reach the registry.
 */
export function startExport(
	options: StartExportOptions,
): StartExportResult {
	return _startExport(options);
}

/**
 * Records a frame's progress. The Rust side enforces monotonicity: an
 * out-of-order `frameIndex` is reported as a thrown error rather than
 * silently re-sorted.
 */
export function encodeFrame(options: EncodeFrameOptions): FrameProgress {
	return _encodeFrame(options);
}

/**
 * Drops the session. `true` means the run completed without cancellation;
 * `false` means it was cancelled (signal, not error).
 */
export function finalizeExport(options: SessionIdOptions): boolean {
	return _finalizeExport(options);
}

/**
 * Sets the session's cancellation flag. Idempotent — calling it twice has
 * the same effect as once, so a JS callback racing with itself cannot fault.
 */
export function cancelExport(
	options: SessionIdOptions,
): ExportSessionStatus {
	return _cancelExport(options);
}

/**
 * Renders `frame` through the wgpu compositor and reads the result back as a
 * row-major RGBA8 byte buffer, sized `width * height * 4`. The bytes cross
 * the boundary as one `memcpy`; step 3's ffmpeg encoder consumes them
 * inside the same Rust process so this copy disappears in the production
 * path. The current shape exists for the parity harness (step 5) and any JS
 * caller that wants to inspect the pixels directly.
 *
 * Asynchronous by necessity, not by taste: WebGL2 refuses to block on a sync
 * object, so the GPU copy only retires once control has gone back to the
 * event loop. The Rust side yields and re-polls until it lands.
 *
 * Requires `initCompositor` to have been called first — the function reads
 * from the same shared compositor `renderFrame` does.
 */
export function readbackFrame(
	frame: FrameDescriptor,
): Promise<ReadbackFrame> {
	return _readbackFrame(frame);
}

/**
 * The sizes this project may be exported at — its own resolution first, then
 * each standard rung below it.
 *
 * Rust decides these rather than the panel because both constraints on them
 * belong to the encoder: 4:2:0 has no representation for an odd side, and a
 * rung above the project's own size would encode invented pixels. The label is
 * still the panel's to write; the number it labels with comes from here so the
 * name offered and the frame encoded cannot disagree.
 */
export function listExportResolutions({
	canvas,
}: ListExportResolutionsOptions): ExportResolution[] {
	return _listExportResolutions({ canvas });
}

/**
 * What to encode a chosen resolution at, given what the project's own
 * resolution would have been encoded at. Bits scale with area, floored so a
 * small rung stays watchable and capped so an export never claims more
 * bitrate than its source had.
 */
export function exportVideoBitrate({
	sourceBitrate,
	canvas,
	output,
}: ExportVideoBitrateOptions): number {
	return _exportVideoBitrate({ sourceBitrate, canvas, output });
}
