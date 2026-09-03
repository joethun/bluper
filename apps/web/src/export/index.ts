import type { FrameRate } from "bluper-wasm";
import { getExportFormatSpec } from "./formats";
import type { ExportFormat } from "./formats";
import type { ExportResolution } from "./resolutions";

export {
	EXPORT_FORMAT,
	EXPORT_VIDEO_CODEC,
	getExportFormatSpec,
	isAudioOnlyExportFormat,
	listExportFormats,
	resolveExportAudioEncoding,
	resolveExportVideoCodec,
} from "./formats";
export type { ExportFormat, VideoCodecName } from "./formats";
export {
	describeExportResolution,
	getExportResolutionKey,
	getExportResolutionLabel,
	listProjectExportResolutions,
} from "./resolutions";
export type { ExportResolution } from "./resolutions";

/**
 * What the panel asks the user, which is now one question: how big.
 *
 * Container and codec are settled — see `EXPORT_FORMAT` and
 * `EXPORT_VIDEO_CODEC` — and audio is always carried, because a timeline with
 * sound on it that exports silent is a bug report rather than a preference.
 */
export interface ExportOptions {
	/** One of `listProjectExportResolutions`, in output pixels. */
	resolution: ExportResolution;
	fps?: FrameRate;
}

/**
 * What an export produced: a finished file already sitting on the filesystem.
 *
 * Nothing about it was ever held in memory — the encoders streamed into it as
 * they ran — and the UI asks the user where to put it and moves it there. An
 * export that cannot open its file fails; there is deliberately no variant that
 * buffers the render, because a long one does not fit.
 */
export type ExportArtifact = { kind: "path"; path: string };

export interface ExportResult {
	success: boolean;
	artifact?: ExportArtifact;
	error?: string;
	cancelled?: boolean;
}

// "preparing" covers decoding and mixing audio, which happens before the first
// frame is rendered and reports no measurable progress. "rendering" is the only
// phase with a meaningful percentage.
export type ExportPhase = "idle" | "preparing" | "rendering";

export interface ExportState {
	isExporting: boolean;
	phase: ExportPhase;
	progress: number;
	result: ExportResult | null;
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${getExportFormatSpec({ format }).extension}`;
}
