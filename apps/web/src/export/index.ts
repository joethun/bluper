import type { FrameRate } from "opencut-wasm";
import type { VideoCodec } from "mediabunny";
import { getExportFormatSpec } from "./formats";
import type { ExportFormat } from "./formats";

export {
	createExportOutputFormat,
	getExportFormatSpec,
	getVideoCodecLabel,
	isAudioOnlyExportFormat,
	listEncodableVideoCodecs,
	listExportFormats,
	parseExportFormat,
	resolveExportAudioEncoding,
	resolveExportVideoCodec,
} from "./formats";
export type { ExportFormat } from "./formats";

/**
 * The codec to encode video with. `auto` follows the source — a project cut
 * from H.264 comes back out as H.264 — and is what every export used before the
 * choice was offered. An explicit codec is only honoured when the container
 * takes it and this engine can encode it; see `resolveExportVideoCodec`.
 */
export type ExportVideoCodec = "auto" | VideoCodec;

export interface ExportOptions {
	format: ExportFormat;
	fps?: FrameRate;
	includeAudio?: boolean;
	videoCodec?: ExportVideoCodec;
}

/**
 * What an export produced.
 *
 * - `path`: a finished file already sitting on the desktop build's filesystem.
 *   Nothing about it was ever held in memory; the UI asks the user where to put
 *   it and moves it there.
 * - `opfs`: a reference to a file the export Service Worker is holding in OPFS
 *   (memory-bounded; streams straight to disk on download).
 * - `blob`: a fully-materialised Blob, for browsers without OPFS or Service
 *   Workers. This is the only variant whose size is bounded by memory.
 */
export type ExportArtifact =
	| { kind: "path"; path: string }
	| { kind: "opfs"; id: string }
	| { kind: "blob"; blob: Blob };

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

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return getExportFormatSpec({ format }).mimeType;
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${getExportFormatSpec({ format }).extension}`;
}
