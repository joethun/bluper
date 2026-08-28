import type { FrameRate } from "bluper-wasm";
import { getExportFormatSpec } from "./formats";
import type { VideoCodecName } from "./formats";
import type { ExportFormat } from "./formats";

export {
	asVideoCodecName,
	getExportFormatSpec,
	getVideoCodecLabel,
	isAudioOnlyExportFormat,
	listEncodableVideoCodecs,
	listExportFormats,
	parseExportFormat,
	resolveExportAudioEncoding,
	resolveExportVideoCodec,
} from "./formats";
export type { ExportFormat, VideoCodecName } from "./formats";

/**
 * The codec to encode video with. `auto` follows the source — a project cut
 * from H.264 comes back out as H.264 — and is what every export used before the
 * choice was offered. An explicit codec is only honoured when the container
 * takes it and this engine can encode it; see `resolveExportVideoCodec`.
 */
export type ExportVideoCodec = "auto" | VideoCodecName;

export interface ExportOptions {
	format: ExportFormat;
	fps?: FrameRate;
	includeAudio?: boolean;
	videoCodec?: ExportVideoCodec;
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
