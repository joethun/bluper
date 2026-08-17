/**
 * The containers an export can be written into, and the codecs each one takes.
 *
 * Two different questions decide what an export ends up as, and they are asked
 * of two different authorities. What a container *may* hold is a property of the
 * format — mediabunny answers that, and the preference lists here only order
 * what it allows. What this machine can actually *encode* is a property of the
 * engine, and can only be learned by asking WebCodecs, which is why every
 * resolver below is async and why nothing here hard-codes "MP4 means H.264":
 * WebKitGTK ships without an H.264 encoder often enough that assuming it is how
 * an export fails with nothing to say for itself.
 */

import {
	MkvOutputFormat,
	MovOutputFormat,
	Mp4OutputFormat,
	OggOutputFormat,
	Quality,
	WavOutputFormat,
	WebMOutputFormat,
	getFirstEncodableAudioCodec,
	getFirstEncodableVideoCodec,
	type AudioCodec,
	type OutputFormat,
	type VideoCodec,
} from "mediabunny";

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

type ExportFormatSpec = {
	label: string;
	/** The one-line trade-off shown next to the label. */
	description: string;
	extension: string;
	mimeType: string;
	kind: ExportFormatKind;
	/**
	 * Video codecs to try, best first. Intersected with what the container
	 * accepts and with what the engine can encode before one is picked.
	 */
	videoCodecs: readonly VideoCodec[];
	/** Audio codecs to try, best first. Same intersection applies. */
	audioCodecs: readonly AudioCodec[];
	createOutputFormat: () => OutputFormat;
};

const EXPORT_FORMAT_SPECS: Readonly<Record<ExportFormat, ExportFormatSpec>> = {
	mp4: {
		label: "MP4",
		description: "Plays everywhere",
		extension: "mp4",
		mimeType: "video/mp4",
		kind: "video",
		videoCodecs: ["avc", "hevc", "av1", "vp9"],
		audioCodecs: ["aac", "opus", "flac"],
		createOutputFormat: () => new Mp4OutputFormat(),
	},
	mov: {
		label: "MOV",
		description: "QuickTime, for other editors",
		extension: "mov",
		mimeType: "video/quicktime",
		kind: "video",
		videoCodecs: ["avc", "hevc", "prores", "av1", "vp9"],
		audioCodecs: ["aac", "opus", "pcm-s16", "flac"],
		createOutputFormat: () => new MovOutputFormat(),
	},
	mkv: {
		label: "MKV",
		description: "Takes any codec",
		extension: "mkv",
		mimeType: "video/x-matroska",
		kind: "video",
		videoCodecs: ["avc", "hevc", "av1", "vp9", "vp8"],
		audioCodecs: ["opus", "aac", "vorbis", "flac"],
		createOutputFormat: () => new MkvOutputFormat(),
	},
	webm: {
		label: "WebM",
		description: "Smaller file size",
		extension: "webm",
		mimeType: "video/webm",
		kind: "video",
		videoCodecs: ["vp9", "av1", "vp8"],
		audioCodecs: ["opus", "vorbis"],
		createOutputFormat: () => new WebMOutputFormat(),
	},
	m4a: {
		label: "M4A",
		description: "Audio only, AAC",
		extension: "m4a",
		mimeType: "audio/mp4",
		kind: "audio",
		videoCodecs: [],
		audioCodecs: ["aac", "opus", "flac"],
		createOutputFormat: () => new Mp4OutputFormat(),
	},
	wav: {
		label: "WAV",
		description: "Audio only, uncompressed",
		extension: "wav",
		mimeType: "audio/wav",
		kind: "audio",
		videoCodecs: [],
		audioCodecs: ["pcm-s16", "pcm-s24", "pcm-f32"],
		createOutputFormat: () => new WavOutputFormat(),
	},
	ogg: {
		label: "OGG",
		description: "Audio only, Opus",
		extension: "ogg",
		mimeType: "audio/ogg",
		kind: "audio",
		videoCodecs: [],
		audioCodecs: ["opus", "vorbis"],
		createOutputFormat: () => new OggOutputFormat(),
	},
};

/** How each codec is named in the UI, rather than in the spec that defines it. */
const VIDEO_CODEC_LABELS: Readonly<Record<VideoCodec, string>> = {
	avc: "H.264",
	hevc: "H.265 (HEVC)",
	av1: "AV1",
	vp9: "VP9",
	vp8: "VP8",
	prores: "ProRes",
};

/**
 * Bitrates for the codecs that need one. Transparent for stereo music and well
 * above what speech needs; PCM and FLAC are absent because they are lossless
 * and a bitrate would mean nothing to them.
 */
const AUDIO_BITRATES: Readonly<Partial<Record<AudioCodec, number>>> = {
	aac: 192_000,
	opus: 128_000,
	vorbis: 160_000,
	mp3: 192_000,
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

export function createExportOutputFormat({
	format,
}: {
	format: ExportFormat;
}): OutputFormat {
	return EXPORT_FORMAT_SPECS[format].createOutputFormat();
}

export function getVideoCodecLabel({ codec }: { codec: VideoCodec }): string {
	return VIDEO_CODEC_LABELS[codec];
}

/**
 * The video codecs this container accepts, in preference order. What the
 * machine can encode is a separate question — see
 * {@link listEncodableVideoCodecs}.
 */
function listContainerVideoCodecs({
	format,
}: {
	format: ExportFormat;
}): VideoCodec[] {
	const spec = EXPORT_FORMAT_SPECS[format];
	if (spec.kind === "audio") return [];

	const supported = spec.createOutputFormat().getSupportedVideoCodecs();
	return spec.videoCodecs.filter((codec) => supported.includes(codec));
}

/**
 * The subset of the above this engine has an encoder for. Probing costs a
 * `VideoEncoder.isConfigSupported` per codec, which mediabunny memoises, but it
 * is still a round-trip per call — the export panel asks once when it opens.
 */
export async function listEncodableVideoCodecs({
	format,
	width,
	height,
}: {
	format: ExportFormat;
	width: number;
	height: number;
}): Promise<VideoCodec[]> {
	const candidates = listContainerVideoCodecs({ format });
	const encodable = await Promise.all(
		candidates.map(async (codec) => ({
			codec,
			ok: await isVideoCodecEncodable({ codec, width, height }),
		})),
	);
	return encodable.filter(({ ok }) => ok).map(({ codec }) => codec);
}

async function isVideoCodecEncodable({
	codec,
	width,
	height,
}: {
	codec: VideoCodec;
	width: number;
	height: number;
}): Promise<boolean> {
	const first = await getFirstEncodableVideoCodec([codec], { width, height });
	return first !== null;
}

/**
 * The codec an export should actually use.
 *
 * `preferred` is what the caller wants — the user's pick, or the source's own
 * codec so a re-export lands where it started. It only wins if the container
 * takes it and the engine can encode it; otherwise the container's preference
 * order decides, and null means this machine cannot encode into this container
 * at all, which the caller has to report rather than discover mid-render.
 */
export async function resolveExportVideoCodec({
	format,
	preferred,
	width,
	height,
}: {
	format: ExportFormat;
	preferred?: VideoCodec | null;
	width: number;
	height: number;
}): Promise<VideoCodec | null> {
	const candidates = listContainerVideoCodecs({ format });
	if (candidates.length === 0) return null;

	const ordered =
		preferred && candidates.includes(preferred)
			? [preferred, ...candidates.filter((codec) => codec !== preferred)]
			: candidates;

	return getFirstEncodableVideoCodec(ordered, { width, height });
}

export type ExportAudioEncoding = {
	codec: AudioCodec;
	/** Null for lossless codecs, which take no bitrate. */
	bitrate: number | null;
};

/**
 * The audio codec for a container, picked the same way: preference order,
 * filtered by what the container holds and what the engine encodes.
 *
 * PCM never fails this check — mediabunny writes those samples itself rather
 * than handing them to an encoder — so a WAV export works on any engine, which
 * makes it the honest fallback to suggest when nothing else does.
 */
export async function resolveExportAudioEncoding({
	format,
	numberOfChannels,
	sampleRate,
}: {
	format: ExportFormat;
	numberOfChannels: number;
	sampleRate: number;
}): Promise<ExportAudioEncoding | null> {
	const spec = EXPORT_FORMAT_SPECS[format];
	const supported = spec.createOutputFormat().getSupportedAudioCodecs();
	const candidates = spec.audioCodecs.filter((codec) =>
		supported.includes(codec),
	);

	for (const codec of candidates) {
		const bitrate = AUDIO_BITRATES[codec] ?? null;
		const encodable = await getFirstEncodableAudioCodec([codec], {
			numberOfChannels,
			sampleRate,
			...(bitrate !== null && { quality: new Quality({ bitrate }) }),
		});
		if (encodable) return { codec: encodable, bitrate };
	}

	return null;
}
