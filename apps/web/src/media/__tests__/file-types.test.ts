import { expect, mock, test } from "bun:test";
import * as wasmNative from "bluper-wasm-native";
import type { MediaType } from "@/media/types";

// Mock the *package*, not `@/wasm`: `mock.module` is process-global in bun, so
// stubbing the façade here would leave every later test file in the run holding
// a partial `@/wasm` and failing on whichever export it happened to need.
mock.module("bluper-wasm", () => wasmNative);

// Imported after the mock, not statically at the top: a top-level `import` is
// hoisted above `mock.module` and would load the bundler-target package, which
// `bun test` cannot initialise.
const fileTypes = await import("@/wasm/file-types");

/**
 * The media format table and the classification over it, owned by
 * `editor-core::media::file_types`.
 *
 * The TypeScript original in `apps/web/src/media/file-types.ts` was deleted at
 * the switchover, so this can no longer be a differential — these are the values
 * the two implementations were proven to agree on over all 77 extensions and
 * 3,000 generated filenames while both existed. What they guard now is
 * transcription: the table is data, and a row that quietly loses an extension,
 * a label or its support flag is invisible until a user drops that file in and
 * gets the wrong message.
 */

/** Every extension the table claims, flattened to `type|mime|label|support`. */
const TABLE: Record<string, string> = {
	png: "image|image/png|PNG|decodable",
	apng: "image|image/png|PNG|decodable",
	jpg: "image|image/jpeg|JPEG|decodable",
	jpeg: "image|image/jpeg|JPEG|decodable",
	jpe: "image|image/jpeg|JPEG|decodable",
	jfif: "image|image/jpeg|JPEG|decodable",
	pjpeg: "image|image/jpeg|JPEG|decodable",
	gif: "image|image/gif|GIF|decodable",
	webp: "image|image/webp|WebP|decodable",
	avif: "image|image/avif|AVIF|decodable",
	svg: "image|image/svg+xml|SVG|decodable",
	svgz: "image|image/svg+xml|SVG|decodable",
	bmp: "image|image/bmp|BMP|decodable",
	dib: "image|image/bmp|BMP|decodable",
	ico: "image|image/x-icon|Icon|decodable",
	cur: "image|image/x-icon|Icon|decodable",
	heic: "image|image/heic|HEIC|decodable",
	heif: "image|image/heic|HEIC|decodable",
	heics: "image|image/heic|HEIC|decodable",
	tif: "image|image/tiff|TIFF|decodable",
	tiff: "image|image/tiff|TIFF|decodable",
	jxl: "image|image/jxl|JPEG XL|decodable",
	mp4: "video|video/mp4|MP4|decodable",
	m4v: "video|video/mp4|MP4|decodable",
	mp4v: "video|video/mp4|MP4|decodable",
	mov: "video|video/quicktime|QuickTime (MOV)|decodable",
	qt: "video|video/quicktime|QuickTime (MOV)|decodable",
	webm: "video|video/webm|WebM|decodable",
	mkv: "video|video/x-matroska|Matroska (MKV)|decodable",
	mk3d: "video|video/x-matroska|Matroska (MKV)|decodable",
	ts: "video|video/mp2t|MPEG-TS|decodable",
	m2ts: "video|video/mp2t|MPEG-TS|decodable",
	mts: "video|video/mp2t|MPEG-TS|decodable",
	m2t: "video|video/mp2t|MPEG-TS|decodable",
	tsv: "video|video/mp2t|MPEG-TS|decodable",
	"3gp": "video|video/3gpp|3GPP|decodable",
	"3gpp": "video|video/3gpp|3GPP|decodable",
	"3g2": "video|video/3gpp|3GPP|decodable",
	"3gp2": "video|video/3gpp|3GPP|decodable",
	ogv: "video|video/ogg|Ogg video|decodable",
	avi: "video|video/x-msvideo|AVI|unsupported",
	divx: "video|video/x-msvideo|AVI|unsupported",
	wmv: "video|video/x-ms-wmv|Windows Media|unsupported",
	asf: "video|video/x-ms-wmv|Windows Media|unsupported",
	flv: "video|video/x-flv|Flash video|unsupported",
	f4v: "video|video/x-flv|Flash video|unsupported",
	mpg: "video|video/mpeg|MPEG program stream|unsupported",
	mpeg: "video|video/mpeg|MPEG program stream|unsupported",
	mpe: "video|video/mpeg|MPEG program stream|unsupported",
	m1v: "video|video/mpeg|MPEG program stream|unsupported",
	m2v: "video|video/mpeg|MPEG program stream|unsupported",
	vob: "video|video/mpeg|MPEG program stream|unsupported",
	mod: "video|video/mpeg|MPEG program stream|unsupported",
	rm: "video|application/vnd.rn-realmedia|RealMedia|unsupported",
	rmvb: "video|application/vnd.rn-realmedia|RealMedia|unsupported",
	mxf: "video|application/mxf|MXF|unsupported",
	mp3: "audio|audio/mpeg|MP3|decodable",
	m4a: "audio|audio/mp4|MPEG-4 audio|decodable",
	m4b: "audio|audio/mp4|MPEG-4 audio|decodable",
	m4r: "audio|audio/mp4|MPEG-4 audio|decodable",
	aac: "audio|audio/aac|AAC|decodable",
	adts: "audio|audio/aac|AAC|decodable",
	wav: "audio|audio/wav|WAVE|decodable",
	wave: "audio|audio/wav|WAVE|decodable",
	flac: "audio|audio/flac|FLAC|decodable",
	opus: "audio|audio/opus|Opus|decodable",
	ogg: "audio|audio/ogg|Ogg audio|decodable",
	oga: "audio|audio/ogg|Ogg audio|decodable",
	weba: "audio|audio/webm|WebM audio|decodable",
	mka: "audio|audio/x-matroska|Matroska audio|decodable",
	aif: "audio|audio/aiff|AIFF|decodable",
	aiff: "audio|audio/aiff|AIFF|decodable",
	aifc: "audio|audio/aiff|AIFF|decodable",
	caf: "audio|audio/x-caf|Core Audio|decodable",
	wma: "audio|audio/x-ms-wma|Windows Media Audio|unsupported",
	amr: "audio|audio/amr|AMR|unsupported",
	awb: "audio|audio/amr|AMR|unsupported",
};

test("the accept list is the wildcards followed by every extension, in table order", () => {
	// Order is pinned, not just membership: the list is derived by flattening the
	// table, so a reordering here means a row moved.
	expect(fileTypes.MEDIA_FILE_ACCEPT).toBe(
		[
			"image/*",
			"video/*",
			"audio/*",
			...Object.keys(TABLE).map((extension) => `.${extension}`),
		].join(","),
	);
});

test("every extension resolves to the format the table claims", () => {
	for (const [extension, expected] of Object.entries(TABLE)) {
		const format = fileTypes.getMediaFormatFromName({
			name: `clip.${extension}`,
		});
		expect(
			format && [format.type, format.mime, format.label, format.support].join("|"),
		).toBe(expected);
	}
});

test("an extension is matched case-insensitively", () => {
	for (const name of ["clip.MP4", "clip.Mp4", "clip.mP4"]) {
		expect(fileTypes.getMediaFormatFromName({ name })?.label).toBe("MP4");
	}
});

test("only the last dot names the extension", () => {
	expect(
		fileTypes.getMediaFormatFromName({ name: "a.b.c.d.webm" })?.label,
	).toBe("WebM");
});

test("a name with no usable extension resolves to nothing", () => {
	// A trailing dot has nothing after it, and a leading one is a dotfile rather
	// than an extension — `.mp4` is a file *named* `.mp4`, not an MP4.
	for (const name of ["", "noext", "trailing.", ".mp4", "clip.xyz"]) {
		expect(fileTypes.getMediaFormatFromName({ name })).toBeNull();
		expect(fileTypes.describeUnsupportedFormat({ name })).toBeNull();
	}
});

test("a file's media type comes from its extension", () => {
	const cases: [string, MediaType | null][] = [
		["clip.MP4", "video"],
		["song.mp3", "audio"],
		["photo.png", "image"],
		["noext", null],
		["clip.xyz", null],
	];
	for (const [name, expected] of cases) {
		expect(
			fileTypes.getMediaTypeFromFile({ file: new File([], name) }),
		).toBe(expected);
	}
});

test("a declared MIME type is trusted over the extension", () => {
	// The case this exists for is a container the OS knows and the table does
	// not, and the typeless MKV Windows hands over with an empty `type`.
	expect(
		fileTypes.getMediaTypeFromFile({
			file: new File([], "recording", { type: "video/mp4" }),
		}),
	).toBe("video");
	expect(
		fileTypes.getMediaTypeFromFile({
			file: new File([], "clip.mkv", { type: "" }),
		}),
	).toBe("video");
});

test("an unsupported format is described as advice, a decodable one is not", () => {
	expect(fileTypes.describeUnsupportedFormat({ name: "x.avi" })).toBe(
		"AVI files can't be decoded here. Convert this to MP4, MOV or MKV and reimport it.",
	);
	expect(fileTypes.describeUnsupportedFormat({ name: "x.wmv" })).toBe(
		"Windows Media files can't be decoded here. Convert this to MP4, MOV or MKV and reimport it.",
	);
	// A format the editor expects to read says nothing: its failures are the
	// decoder's to report, not this module's to guess at.
	expect(fileTypes.describeUnsupportedFormat({ name: "x.mp4" })).toBeNull();
});

test("every unsupported row has advice and every decodable row has none", () => {
	for (const [extension, row] of Object.entries(TABLE)) {
		const advice = fileTypes.describeUnsupportedFormat({
			name: `clip.${extension}`,
		});
		expect(advice === null).toBe(row.endsWith("|decodable"));
	}
});
