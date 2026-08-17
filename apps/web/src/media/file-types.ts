/**
 * What counts as media on the way in, and what the editor can do with it.
 *
 * `File.type` is the OS's opinion, not the file's: it comes from the shared
 * MIME database on Linux, from the registry on Windows and from the extension
 * map in the webview. Plenty of real media arrives with an empty string — MKV,
 * M2TS and Opus routinely do on Windows — and the import used to reject those
 * outright, because the only question asked was whether the type started with
 * `video/`. The extension is the fallback answer, and between the two nearly
 * everything a user drops in is now recognised.
 *
 * Recognising a container is not the same as decoding it. Frames only ever come
 * from mediabunny, so a container it cannot demux (AVI, WMV, MPEG program
 * streams) can never render, however well the platform plays it elsewhere.
 * Those are listed anyway, with `support: "unsupported"`, so the import can name
 * the format and say what to convert it to instead of failing anonymously.
 */

import type { MediaType } from "@/media/types";

/**
 * - `decodable`: something in the stack reads it — mediabunny demuxes it
 *   through WebCodecs, or the platform decoders do behind `<img>`, `<audio>`
 *   or `decodeAudioData`. Not a promise that every engine can: HEIC needs
 *   Safari, AIFF needs WebKit. Import probes rather than assumes.
 * - `unsupported`: recognised only so the failure can be specific.
 */
type FormatSupport = "decodable" | "unsupported";

export type MediaFileFormat = {
	/** Lower-case, no leading dot. The first is the canonical one. */
	extensions: readonly string[];
	/** MIME to assume when the file arrives without one. */
	mime: string;
	type: MediaType;
	/** How the format is named to the user, e.g. "Matroska (MKV)". */
	label: string;
	support: FormatSupport;
};

const IMAGE_FORMATS: readonly MediaFileFormat[] = [
	{
		extensions: ["png", "apng"],
		mime: "image/png",
		type: "image",
		label: "PNG",
		support: "decodable",
	},
	{
		extensions: ["jpg", "jpeg", "jpe", "jfif", "pjpeg"],
		mime: "image/jpeg",
		type: "image",
		label: "JPEG",
		support: "decodable",
	},
	{
		extensions: ["gif"],
		mime: "image/gif",
		type: "image",
		label: "GIF",
		support: "decodable",
	},
	{
		extensions: ["webp"],
		mime: "image/webp",
		type: "image",
		label: "WebP",
		support: "decodable",
	},
	{
		extensions: ["avif"],
		mime: "image/avif",
		type: "image",
		label: "AVIF",
		support: "decodable",
	},
	{
		extensions: ["svg", "svgz"],
		mime: "image/svg+xml",
		type: "image",
		label: "SVG",
		support: "decodable",
	},
	{
		extensions: ["bmp", "dib"],
		mime: "image/bmp",
		type: "image",
		label: "BMP",
		support: "decodable",
	},
	{
		extensions: ["ico", "cur"],
		mime: "image/x-icon",
		type: "image",
		label: "Icon",
		support: "decodable",
	},
	// Decoded by the platform rather than by anything portable: HEIC needs a
	// system decoder (Safari, and Windows with the codec pack), TIFF needs
	// WebKit. Listed as decodable so the attempt is made — the import falls
	// back to a message naming the format when the attempt fails.
	{
		extensions: ["heic", "heif", "heics"],
		mime: "image/heic",
		type: "image",
		label: "HEIC",
		support: "decodable",
	},
	{
		extensions: ["tif", "tiff"],
		mime: "image/tiff",
		type: "image",
		label: "TIFF",
		support: "decodable",
	},
	{
		extensions: ["jxl"],
		mime: "image/jxl",
		type: "image",
		label: "JPEG XL",
		support: "decodable",
	},
];

const VIDEO_FORMATS: readonly MediaFileFormat[] = [
	{
		extensions: ["mp4", "m4v", "mp4v"],
		mime: "video/mp4",
		type: "video",
		label: "MP4",
		support: "decodable",
	},
	{
		extensions: ["mov", "qt"],
		mime: "video/quicktime",
		type: "video",
		label: "QuickTime (MOV)",
		support: "decodable",
	},
	{
		extensions: ["webm"],
		mime: "video/webm",
		type: "video",
		label: "WebM",
		support: "decodable",
	},
	{
		extensions: ["mkv", "mk3d"],
		mime: "video/x-matroska",
		type: "video",
		label: "Matroska (MKV)",
		support: "decodable",
	},
	// Camera and broadcast transport streams. AVCHD camcorders write .mts and
	// .m2ts, and neither has ever had a MIME type the OS agrees on.
	{
		extensions: ["ts", "m2ts", "mts", "m2t", "tsv"],
		mime: "video/mp2t",
		type: "video",
		label: "MPEG-TS",
		support: "decodable",
	},
	{
		extensions: ["3gp", "3gpp", "3g2", "3gp2"],
		mime: "video/3gpp",
		type: "video",
		label: "3GPP",
		support: "decodable",
	},
	{
		extensions: ["ogv"],
		mime: "video/ogg",
		type: "video",
		label: "Ogg video",
		support: "decodable",
	},
	// Recognised, never readable: no demuxer in the stack handles these, so the
	// clip would import and then render nothing.
	{
		extensions: ["avi", "divx"],
		mime: "video/x-msvideo",
		type: "video",
		label: "AVI",
		support: "unsupported",
	},
	{
		extensions: ["wmv", "asf"],
		mime: "video/x-ms-wmv",
		type: "video",
		label: "Windows Media",
		support: "unsupported",
	},
	{
		extensions: ["flv", "f4v"],
		mime: "video/x-flv",
		type: "video",
		label: "Flash video",
		support: "unsupported",
	},
	{
		extensions: ["mpg", "mpeg", "mpe", "m1v", "m2v", "vob", "mod"],
		mime: "video/mpeg",
		type: "video",
		label: "MPEG program stream",
		support: "unsupported",
	},
	{
		extensions: ["rm", "rmvb"],
		mime: "application/vnd.rn-realmedia",
		type: "video",
		label: "RealMedia",
		support: "unsupported",
	},
	{
		extensions: ["mxf"],
		mime: "application/mxf",
		type: "video",
		label: "MXF",
		support: "unsupported",
	},
];

const AUDIO_FORMATS: readonly MediaFileFormat[] = [
	{
		extensions: ["mp3"],
		mime: "audio/mpeg",
		type: "audio",
		label: "MP3",
		support: "decodable",
	},
	{
		extensions: ["m4a", "m4b", "m4r"],
		mime: "audio/mp4",
		type: "audio",
		label: "MPEG-4 audio",
		support: "decodable",
	},
	{
		extensions: ["aac", "adts"],
		mime: "audio/aac",
		type: "audio",
		label: "AAC",
		support: "decodable",
	},
	{
		extensions: ["wav", "wave"],
		mime: "audio/wav",
		type: "audio",
		label: "WAVE",
		support: "decodable",
	},
	{
		extensions: ["flac"],
		mime: "audio/flac",
		type: "audio",
		label: "FLAC",
		support: "decodable",
	},
	{
		extensions: ["opus"],
		mime: "audio/opus",
		type: "audio",
		label: "Opus",
		support: "decodable",
	},
	{
		extensions: ["ogg", "oga"],
		mime: "audio/ogg",
		type: "audio",
		label: "Ogg audio",
		support: "decodable",
	},
	{
		extensions: ["weba"],
		mime: "audio/webm",
		type: "audio",
		label: "WebM audio",
		support: "decodable",
	},
	{
		extensions: ["mka"],
		mime: "audio/x-matroska",
		type: "audio",
		label: "Matroska audio",
		support: "decodable",
	},
	// No WebCodecs path, but `decodeAudioData` runs the platform decoders and
	// WebKit reads both — which is what the desktop build runs on.
	{
		extensions: ["aif", "aiff", "aifc"],
		mime: "audio/aiff",
		type: "audio",
		label: "AIFF",
		support: "decodable",
	},
	{
		extensions: ["caf"],
		mime: "audio/x-caf",
		type: "audio",
		label: "Core Audio",
		support: "decodable",
	},
	{
		extensions: ["wma"],
		mime: "audio/x-ms-wma",
		type: "audio",
		label: "Windows Media Audio",
		support: "unsupported",
	},
	{
		extensions: ["amr", "awb"],
		mime: "audio/amr",
		type: "audio",
		label: "AMR",
		support: "unsupported",
	},
];

const MEDIA_FILE_FORMATS: readonly MediaFileFormat[] = [
	...IMAGE_FORMATS,
	...VIDEO_FORMATS,
	...AUDIO_FORMATS,
];

const FORMATS_BY_EXTENSION = new Map<string, MediaFileFormat>(
	MEDIA_FILE_FORMATS.flatMap((format) =>
		format.extensions.map((extension) => [extension, format] as const),
	),
);

/**
 * MIME types that describe media without saying so in the prefix. `.ogg` and
 * `.m4a` are the ones seen in the wild; the generic bucket is what an OS falls
 * back to when it recognises nothing, so it resolves by extension instead.
 */
const MIME_TYPE_OVERRIDES: Readonly<Record<string, MediaType>> = {
	"application/ogg": "audio",
	"application/x-ogg": "audio",
	"application/mp4": "video",
	"application/x-matroska": "video",
	"application/x-mpegurl": "video",
	"application/vnd.apple.mpegurl": "video",
};

/** The extension of `name`, lower-cased and without the dot. */
function getFileExtension({ name }: { name: string }): string {
	const lastDot = name.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === name.length - 1) return "";
	return name.slice(lastDot + 1).toLowerCase();
}

/** The registry entry for a filename, or null when the extension is unknown. */
export function getMediaFormatFromName({
	name,
}: {
	name: string;
}): MediaFileFormat | null {
	return FORMATS_BY_EXTENSION.get(getFileExtension({ name })) ?? null;
}

/**
 * The media kind a MIME type describes, or null when it describes something
 * else — or nothing, which is the common case for media on Windows.
 */
function getMediaTypeFromMimeType({
	mimeType,
}: {
	mimeType: string;
}): MediaType | null {
	const normalized = mimeType.toLowerCase().split(";")[0].trim();
	if (!normalized) return null;

	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("video/")) return "video";
	if (normalized.startsWith("audio/")) return "audio";

	return MIME_TYPE_OVERRIDES[normalized] ?? null;
}

/**
 * What kind of media a file holds: its MIME type when the OS supplied a usable
 * one, its extension otherwise. Null means neither recognised it.
 */
export function getMediaTypeFromFile({
	file,
}: {
	file: File;
}): MediaType | null {
	const fromMimeType = getMediaTypeFromMimeType({ mimeType: file.type });
	if (fromMimeType) return fromMimeType;

	return getMediaFormatFromName({ name: file.name })?.type ?? null;
}

/**
 * The MIME type a file should be treated as. Object URLs and the desktop
 * `asset:` protocol both type their responses from this, and an untyped blob
 * is one the platform decoders may refuse to touch.
 */
export function getMediaMimeTypeFromName({
	name,
}: {
	name: string;
}): string | null {
	return getMediaFormatFromName({ name })?.mime ?? null;
}

/**
 * The `accept` for a file input. Wildcards come first so anything the OS knows
 * to be media is offered; the explicit extensions cover the containers it has
 * no MIME type for, which is exactly the set the wildcards would hide.
 */
export const MEDIA_FILE_ACCEPT = [
	"image/*",
	"video/*",
	"audio/*",
	...MEDIA_FILE_FORMATS.flatMap((format) =>
		format.extensions.map((extension) => `.${extension}`),
	),
].join(",");

/**
 * Why a recognised file cannot be used, phrased as advice. Returns null for
 * formats the editor expects to read, whose failures are reported from the
 * decoder rather than guessed at here.
 */
export function describeUnsupportedFormat({
	name,
}: {
	name: string;
}): string | null {
	const format = getMediaFormatFromName({ name });
	if (!format || format.support !== "unsupported") return null;

	const target =
		format.type === "audio" ? "WAV, MP3 or FLAC" : "MP4, MOV or MKV";
	return `${format.label} files can't be decoded here. Convert this to ${target} and reimport it.`;
}
