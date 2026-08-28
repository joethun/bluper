import {
	getRulerConfigValue as _getRulerConfigValue,
	shouldShowLabelValue as _shouldShowLabelValue,
	formatRulerLabelValue as _formatRulerLabelValue,
	type RulerConfig,
} from "bluper-wasm";

/**
 * Ruler tick layout and label formatting for the timeline header. Owned by
 * `editor-core::timeline::ruler_utils`.
 */

export type { RulerConfig };

export function getRulerConfig({
	zoomLevel,
	fps,
}: {
	zoomLevel: number;
	fps: import("bluper-wasm").FrameRate;
}): RulerConfig {
	return _getRulerConfigValue({ zoomLevel, fps });
}

export function shouldShowLabel({
	time,
	labelIntervalSeconds,
}: {
	time: number;
	labelIntervalSeconds: number;
}): boolean {
	return _shouldShowLabelValue({ time, labelIntervalSeconds });
}

export function formatRulerLabel({
	timeInSeconds,
	fps,
}: {
	timeInSeconds: number;
	fps: import("bluper-wasm").FrameRate;
}): string {
	return _formatRulerLabelValue({ timeInSeconds, fps });
}
