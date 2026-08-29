import {
	describeUnsupportedMediaFormatValue as _describeUnsupportedMediaFormatValue,
	getMediaFormatFromNameValue as _getMediaFormatFromNameValue,
	getMediaTypeFromFileValue as _getMediaTypeFromFileValue,
	mediaFileAcceptValue as _mediaFileAcceptValue,
	type MediaFileFormat,
} from "bluper-wasm";
import type { MediaType } from "@/media/types";

/**
 * The media format table and the classification over it, owned by
 * `editor-core::media::file_types`.
 *
 * A `File` cannot cross the wasm boundary, so the Rust side takes the two
 * fields the classification actually reads — the name and the OS's MIME guess —
 * and {@link getMediaTypeFromFile} does the unwrapping here. That is also why
 * the answer never depends on the bytes: recognising a container is a question
 * about its name and its declared type, and whether it decodes is settled later
 * by the decoder.
 */

/**
 * Every media type the editor accepts, in `accept` syntax. Wildcards come first
 * so anything the OS knows to be media is covered; the explicit extensions
 * cover the containers it has no MIME type for, which is exactly the set the
 * wildcards would hide.
 *
 * Nothing renders this as an attribute any more — import goes through the OS
 * dialog, which takes {@link MEDIA_FILE_EXTENSIONS} instead. It stays because
 * it is the registry's own summary of what can be opened, and the extension
 * list is derived from it.
 */
export const MEDIA_FILE_ACCEPT = _mediaFileAcceptValue().accept;

/** The registry entry for a filename, or null when the extension is unknown. */
export function getMediaFormatFromName({
	name,
}: {
	name: string;
}): MediaFileFormat | null {
	return _getMediaFormatFromNameValue({ name }).format ?? null;
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
	return (
		_getMediaTypeFromFileValue({ name: file.name, mimeType: file.type })
			.mediaType ?? null
	);
}

/**
 * What kind of media a *path* holds, judged on its extension alone.
 *
 * Media imported by reference never becomes a `File`, so there is no OS MIME
 * guess to consult — only the name. That is the weaker of the two signals
 * {@link getMediaTypeFromFile} uses, which matters only for a file whose
 * extension is missing or wrong; the probe still has the final say on what is
 * actually inside.
 */
export function getMediaTypeFromName({
	name,
}: {
	name: string;
}): MediaType | null {
	return _getMediaTypeFromFileValue({ name }).mediaType ?? null;
}

/**
 * The media extensions the registry knows, without their leading dots, for the
 * native open dialog — which takes a filter list rather than an `accept`
 * string. Derived from {@link MEDIA_FILE_ACCEPT} so both come from one table.
 */
export const MEDIA_FILE_EXTENSIONS: string[] = MEDIA_FILE_ACCEPT.split(",")
	.map((entry) => entry.trim())
	.filter((entry) => entry.startsWith("."))
	.map((entry) => entry.slice(1));

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
	return _describeUnsupportedMediaFormatValue({ name }).advice ?? null;
}
