import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
}

/**
 * What an export produced. Either a reference to a file the export Service
 * Worker is holding in OPFS (memory-bounded; streams straight to disk on
 * download), or a Blob for environments without OPFS / Service Workers.
 */
export type ExportArtifact =
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
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}
