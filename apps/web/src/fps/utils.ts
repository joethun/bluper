import type { FrameRate } from "bluper-wasm";
import {
	frameRateToFloatValue as _frameRateToFloatValue,
	frameRatesEqualValue as _frameRatesEqualValue,
	floatToFrameRateValue as _floatToFrameRateValue,
	getHighestImportedVideoFpsValue as _getHighestImportedVideoFpsValue,
	getRaisedProjectFpsForImportedMediaValue as _getRaisedProjectFpsForImportedMediaValue,
} from "bluper-wasm";
import type { MediaAsset } from "@/media/types";

/**
 * Frame-rate conversion and the import-time rate decision. Owned by
 * `editor-core::media::fps`.
 *
 * Assets are projected down to `{ type, fps }` before they cross: a
 * `MediaAsset` can carry a `File`, and handing one to the bridge would walk a
 * host object the Rust side has no field for.
 */

type MediaAssetFpsInput = Pick<MediaAsset, "type" | "fps">;

function toImportedAssets(
	assets: MediaAssetFpsInput[],
): { type: string; fps?: number }[] {
	return assets.map((asset) => ({ type: asset.type, fps: asset.fps }));
}

export function frameRateToFloat(rate: FrameRate): number {
	return _frameRateToFloatValue({ rate });
}

export function frameRatesEqual({
	a,
	b,
}: {
	a: FrameRate;
	b: FrameRate;
}): boolean {
	return _frameRatesEqualValue({ a, b });
}

export function floatToFrameRate(fps: number): FrameRate {
	return _floatToFrameRateValue({ fps });
}

export function getHighestImportedVideoFps({
	mediaAssets,
}: {
	mediaAssets: MediaAssetFpsInput[];
}): number | null {
	return (
		_getHighestImportedVideoFpsValue({
			mediaAssets: toImportedAssets(mediaAssets),
		}) ?? null
	);
}

export function getRaisedProjectFpsForImportedMedia({
	currentFps,
	importedAssets,
}: {
	currentFps: FrameRate;
	importedAssets: MediaAssetFpsInput[];
}): FrameRate | null {
	return (
		_getRaisedProjectFpsForImportedMediaValue({
			currentFps,
			importedAssets: toImportedAssets(importedAssets),
		}) ?? null
	);
}
