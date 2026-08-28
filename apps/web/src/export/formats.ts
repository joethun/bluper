/**
 * The containers an export can be written into, and the codecs each one takes.
 *
 * Two different questions decide what an export ends up as. What a container
 * *may* hold is a property of the format; what this machine can actually
 * *encode* is a property of the engine. Both used to be asked of the page —
 * mediabunny for the first, WebCodecs for the second — and both are now asked
 * of the desktop shell's ffmpeg, which is also the thing that runs the encode.
 * That is the point of the change: the list offered here and the encoder that
 * opens are the same authority, so a codec cannot be offered and then fail.
 *
 * What stays on this side is presentation — the label, the one-line
 * description, the MIME type. Those are UI copy, not capability.
 */

import {
	tauriAvailable,
	tauriExportCapabilities,
	type NativeExportCapability,
} from "@/lib/tauri-runtime";

const EXPORT_FORMAT_VALUES = [
	"mp4",
	"mov",
	"mkv",
	"webm",
	"m4a",
	"wav",
	"ogg",
] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];

/** Whether the container carries pictures or is a sound file. */
export type ExportFormatKind = "video" | "audio";

/**
 * The codec names the Rust sink speaks. These are the same strings the old
 * mediabunny vocabulary used, which is deliberate: they are already in users'
 * saved export settings.
 */
const VIDEO_CODEC_NAMES = [
	"avc",
	"hevc",
	"av1",
	"vp9",
	"vp8",
	"prores",
] as const;

const AUDIO_CODEC_NAMES = [
	"aac",
	"opus",
	"vorbis",
	"flac",
	"mp3",
	"pcm-s16",
	"pcm-s24",
	"pcm-f32",
] as const;

export type VideoCodecName = (typeof VIDEO_CODEC_NAMES)[number];
type AudioCodecName = (typeof AUDIO_CODEC_NAMES)[number];

/**
 * The shell answers with plain strings, so its list is filtered against the
 * names this side knows rather than asserted into them. A binary newer than
 * the bundle would otherwise put a codec in the dropdown that nothing here can
 * label — which shows up as a blank menu entry rather than as the missing
 * option it really is.
 */
export function asVideoCodecName({
	name,
}: {
	name: string | null;
}): VideoCodecName | null {
	return name !== null &&
		(VIDEO_CODEC_NAMES as readonly string[]).includes(name)
		? (VIDEO_CODEC_NAMES as readonly VideoCodecName[]).find(
				(known) => known === name,
			) ?? null
		: null;
}

function knownVideoCodecs({ names }: { names: string[] }): VideoCodecName[] {
	return names.filter((name): name is VideoCodecName =>
		(VIDEO_CODEC_NAMES as readonly string[]).includes(name),
	);
}

function knownAudioCodecs({ names }: { names: string[] }): AudioCodecName[] {
	return names.filter((name): name is AudioCodecName =>
		(AUDIO_CODEC_NAMES as readonly string[]).includes(name),
	);
}

type ExportFormatSpec = {
	label: string;
	/** The one-line trade-off shown next to the label. */
	description: string;
	extension: string;
	mimeType: string;
	kind: ExportFormatKind;
};

const EXPORT_FORMAT_SPECS: Readonly<Record<ExportFormat, ExportFormatSpec>> = {
	mp4: {
		label: "MP4",
		description: "Plays everywhere",
		extension: "mp4",
		mimeType: "video/mp4",
		kind: "video",
	},
	mov: {
		label: "MOV",
		description: "QuickTime, for other editors",
		extension: "mov",
		mimeType: "video/quicktime",
		kind: "video",
	},
	mkv: {
		label: "MKV",
		description: "Takes any codec",
		extension: "mkv",
		mimeType: "video/x-matroska",
		kind: "video",
	},
	webm: {
		label: "WebM",
		description: "Smaller file size",
		extension: "webm",
		mimeType: "video/webm",
		kind: "video",
	},
	m4a: {
		label: "M4A",
		description: "Audio only, AAC",
		extension: "m4a",
		mimeType: "audio/mp4",
		kind: "audio",
	},
	wav: {
		label: "WAV",
		description: "Audio only, uncompressed",
		extension: "wav",
		mimeType: "audio/wav",
		kind: "audio",
	},
	ogg: {
		label: "OGG",
		description: "Audio only, Opus",
		extension: "ogg",
		mimeType: "audio/ogg",
		kind: "audio",
	},
};

/** How each codec is named in the UI, rather than in the spec that defines it. */
const VIDEO_CODEC_LABELS: Readonly<Record<VideoCodecName, string>> = {
	avc: "H.264",
	hevc: "H.265 (HEVC)",
	av1: "AV1",
	vp9: "VP9",
	vp8: "VP8",
	prores: "ProRes",
};

/**
 * The format a string names, or null. Returns the value rather than narrowing
 * it, because a type predicate can't be written for a destructured parameter.
 */
export function parseExportFormat({
	value,
}: {
	value: string;
}): ExportFormat | null {
	return EXPORT_FORMAT_VALUES.find((format) => format === value) ?? null;
}

export function getExportFormatSpec({
	format,
}: {
	format: ExportFormat;
}): ExportFormatSpec {
	return EXPORT_FORMAT_SPECS[format];
}

/** Formats in the order they should be offered, video containers first. */
export function listExportFormats({
	kind,
}: {
	kind?: ExportFormatKind;
} = {}): { format: ExportFormat; spec: ExportFormatSpec }[] {
	return EXPORT_FORMAT_VALUES.map((format) => ({
		format,
		spec: EXPORT_FORMAT_SPECS[format],
	})).filter(({ spec }) => kind === undefined || spec.kind === kind);
}

/** An audio-only export renders no frames at all — there is nowhere to put them. */
export function isAudioOnlyExportFormat({
	format,
}: {
	format: ExportFormat;
}): boolean {
	return EXPORT_FORMAT_SPECS[format].kind === "audio";
}

export function getVideoCodecLabel({
	codec,
}: {
	codec: VideoCodecName;
}): string {
	return VIDEO_CODEC_LABELS[codec];
}

/**
 * The shell's answer, fetched once and kept.
 *
 * Which encoders an ffmpeg build carries cannot change while the app runs, so
 * asking more than once would be a round-trip for a constant. The promise
 * rather than the value is cached, so two panels opening at the same moment
 * share one call.
 */
let capabilitiesPromise: Promise<NativeExportCapability[]> | null = null;

function loadCapabilities(): Promise<NativeExportCapability[]> {
	if (!capabilitiesPromise) {
		capabilitiesPromise = tauriAvailable()
			? tauriExportCapabilities().catch((error: unknown) => {
					// Let the next caller try again rather than caching a
					// failure for the life of the process.
					capabilitiesPromise = null;
					throw error;
				})
			: Promise.reject(
					new Error(
						"Export needs the desktop shell's encoder, which is unavailable.",
					),
				);
	}
	return capabilitiesPromise;
}

async function capabilityFor({
	format,
}: {
	format: ExportFormat;
}): Promise<NativeExportCapability | null> {
	const capabilities = await loadCapabilities();
	return (
		capabilities.find(
			(capability) => capability.container === format,
		) ?? null
	);
}

/**
 * The video codecs this machine can encode into this container, best first.
 *
 * Empty means the container cannot be written at all here, which the caller
 * has to report rather than discover mid-render.
 */
export async function listEncodableVideoCodecs({
	format,
}: {
	format: ExportFormat;
}): Promise<VideoCodecName[]> {
	const capability = await capabilityFor({ format });
	return knownVideoCodecs({ names: capability?.videoCodecs ?? [] });
}

/**
 * The codec an export should actually use.
 *
 * `preferred` is what the caller wants — the user's pick, or the source's own
 * codec so a re-export lands where it started. It only wins if the container
 * takes it and the engine can encode it; otherwise the container's preference
 * order decides, and null means this machine cannot encode into this container
 * at all.
 */
export async function resolveExportVideoCodec({
	format,
	preferred,
}: {
	format: ExportFormat;
	preferred?: VideoCodecName | null;
}): Promise<VideoCodecName | null> {
	const candidates = await listEncodableVideoCodecs({ format });
	if (candidates.length === 0) return null;
	if (preferred && candidates.includes(preferred)) return preferred;
	return candidates[0];
}

type ExportAudioEncoding = {
	codec: AudioCodecName;
	/** Null for lossless codecs, which take no bitrate. */
	bitrate: number | null;
};

/**
 * Bitrates for the codecs that need one. Transparent for stereo music and well
 * above what speech needs; the lossless codecs are absent because a bitrate
 * would mean nothing to them. Kept in step with `ExportAudioCodec::bitrate` on
 * the Rust side, which is what the encoder is actually opened with — this copy
 * exists so the UI can say what it will be without a round-trip.
 */
const AUDIO_BITRATES: Readonly<Partial<Record<AudioCodecName, number>>> = {
	aac: 192_000,
	opus: 128_000,
	vorbis: 160_000,
	mp3: 192_000,
};

/**
 * The audio codec for a container: the container's preference order, filtered
 * by what this build can encode.
 *
 * PCM never fails this check, which makes WAV the honest fallback to suggest
 * when nothing else works.
 */
export async function resolveExportAudioEncoding({
	format,
}: {
	format: ExportFormat;
}): Promise<ExportAudioEncoding | null> {
	const capability = await capabilityFor({ format });
	const codec = knownAudioCodecs({ names: capability?.audioCodecs ?? [] })[0];
	if (!codec) return null;
	return { codec, bitrate: AUDIO_BITRATES[codec] ?? null };
}
