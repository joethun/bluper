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
 *
 * The panel itself no longer asks either question. Every project export is an
 * MP4 carrying H.264, which is the pair that plays everywhere without the user
 * having to know why; the table below survives because the desktop self-check
 * still walks every container the shell can write, and because an audio-only
 * export is still a shape the pipeline understands.
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
 * the bundle would otherwise offer a codec nothing here can label.
 */
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

/**
 * The container every project export is written into.
 *
 * There used to be a picker. It offered six other containers, and each one
 * traded away the only property that matters at the point a file leaves the
 * editor: that whatever the user sends it to can open it. The audio-only
 * containers are still reachable through the pipeline — the self-check writes
 * a WAV — but nothing in the editor asks a person to choose one.
 */
export const EXPORT_FORMAT: ExportFormat = "mp4";

/**
 * The codec every project export asks for.
 *
 * H.264 is not the smallest or the newest; it is the one every player, phone,
 * editor and upload form made in the last twenty years decodes. It is a
 * preference rather than an instruction — see `resolveExportVideoCodec` — so a
 * build whose ffmpeg was compiled without it still exports, using whatever the
 * container's own order offers instead.
 */
export const EXPORT_VIDEO_CODEC: VideoCodecName = "avc";

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
async function listEncodableVideoCodecs({
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
