/**
 * Turning what the user picked into library entries.
 *
 * There are two routes in, and they differ in one thing: whether the app ends
 * up holding a copy of the media.
 *
 * - {@link processMediaPaths} takes paths, from the native open dialog or a
 *   drop the shell reported. Nothing is copied. The project records where the
 *   file lives and reads it there, the way every other editor treats footage —
 *   an import costs a probe and no disk at all, and the same card can be opened
 *   by two projects without a second copy of it existing.
 * - {@link processMediaAssets} takes `File` objects, which is what the
 *   clipboard produces. Bytes with no path behind them cannot be referenced, so
 *   these are copied into the project's media store.
 *
 * Both end at the same `ProcessedMediaAsset`; nothing downstream has to know
 * which route an asset came in by.
 */

import { toast } from "sonner";
import {
	describeUnsupportedFormat,
	getMediaFormatFromName,
	getMediaTypeFromFile,
	getMediaTypeFromName,
} from "@/wasm/file-types";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import {
	tauriAllowMediaFile,
	tauriConvertFileSrc,
	tauriStatFile,
} from "@/lib/tauri-runtime";
import type { MediaAsset, MediaType } from "@/media/types";
import { discardStagedFile, probeMediaPath, probeStagedFile } from "./probe";
import type { MediaProbe, MediaProbeResult } from "./probe";
import { renderThumbnailDataUrl } from "./thumbnail";

export interface ProcessedMediaAsset extends Omit<MediaAsset, "id"> {}

/** What the probe learned, in the shape the asset record wants. */
type MediaDetails = {
	type: MediaType;
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	thumbnailUrl?: string;
};

/** The last path segment, on either separator. */
function basename({ path }: { path: string }): string {
	const segments = path.split(/[\\/]/);
	return segments[segments.length - 1] || path;
}

const getUnsupportedCodecDescription = ({
	probe,
}: {
	probe: MediaProbe;
}): string => {
	const codecLabel = probe.videoCodec
		? probe.videoCodec.toUpperCase()
		: "this video codec";

	return `${codecLabel} has no decoder in this build, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
};

/**
 * Why a file the app recognised still couldn't be read. Named formats get named
 * advice; anything else gets the honest answer, which is that no demuxer here
 * claimed the container.
 */
const getUnreadableDescription = ({
	name,
	reason,
}: {
	name: string;
	reason: "container" | "no-tracks";
}): string => {
	if (reason === "no-tracks") {
		return "The file has no video or audio track in it.";
	}

	const known = describeUnsupportedFormat({ name });
	if (known) return known;

	const label = getMediaFormatFromName({ name })?.label;
	return label
		? `This doesn't read as a ${label} file — it may be damaged or only partly copied.`
		: "Nothing here could read this container. Convert it to MP4, MOV or MKV and reimport it.";
};

const getStorageLimitDescription = ({
	fileSize,
	availableBytes,
}: {
	fileSize: number;
	availableBytes: number | null;
}): string => {
	const fileSizeLabel = formatStorageBytes({ bytes: fileSize });

	if (availableBytes === null) {
		return `File size is ${fileSizeLabel}.`;
	}

	return `File size is ${fileSizeLabel}, but only ${formatStorageBytes({
		bytes: availableBytes,
	})} of disk space is safely available.`;
};

/**
 * Draws the image once to learn its size and keep a thumbnail. The URL is the
 * caller's — an `asset:` URL for a referenced file, an object URL for bytes —
 * and stays the caller's to revoke.
 */
async function generateImageThumbnail({
	url,
}: {
	url: string;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();

		image.addEventListener("load", () => {
			try {
				const thumbnailUrl = renderThumbnailDataUrl({
					width: image.naturalWidth,
					height: image.naturalHeight,
					draw: ({ context, width, height }) => {
						context.drawImage(image, 0, 0, width, height);
					},
				});
				resolve({
					thumbnailUrl,
					width: image.naturalWidth,
					height: image.naturalHeight,
				});
			} catch (error) {
				reject(
					error instanceof Error ? error : new Error("Could not render image"),
				);
			} finally {
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			image.remove();
			reject(new Error("Could not load image"));
		});

		// `asset:` URLs are a different origin from the page, so without this
		// the canvas `drawImage` is treated as cross-origin and `toDataURL`
		// throws "The operation is insecure" — which the catch below turns
		// into the "no decoder" toast. The asset protocol already sends the
		// matching `Access-Control-Allow-Origin`, so the request succeeds and
		// the image lands CORS-clean.
		image.crossOrigin = "anonymous";
		image.src = url;
	});
}

/**
 * Reads an image, or explains why the engine wouldn't. HEIC, TIFF and JPEG XL
 * all depend on the platform's own decoders, so whether they load is a property
 * of the machine rather than of the file.
 *
 * Null means the file was reported and should be skipped: an image the WebView
 * won't decode is one nothing downstream can draw either, and a library entry
 * that renders nothing is worse than an honest refusal.
 */
async function readImageDetails({
	url,
	name,
}: {
	url: string;
	name: string;
}): Promise<MediaDetails | null> {
	try {
		const { thumbnailUrl, width, height } = await generateImageThumbnail({
			url,
		});
		return { type: "image", thumbnailUrl, width, height };
	} catch (error) {
		const label = getMediaFormatFromName({ name })?.label;
		const reason =
			error instanceof Error && error.message !== "Could not load image"
				? error.message
				: null;
		toast.error(`Can't read ${name}`, {
			description: reason ?? getImageUnsupportedDescription({ label }),
		});
		return null;
	}
}

/**
 * Why an image the app recognised still couldn't be loaded. Universal formats
 * (PNG, JPEG, GIF, WebP, BMP) decode on every WebView the editor runs on, so a
 * failure to load them isn't a missing decoder — it is something else, and the
 * catch handler surfaces that other cause by name. The message below is the
 * fallback for the formats the WebView genuinely may refuse (HEIC, TIFF,
 * JPEG XL).
 */
const getImageUnsupportedDescription = ({
	label,
}: {
	label: string | undefined;
}): string => {
	if (!label) {
		return "The image could not be decoded.";
	}
	return `${label} images may not be supported on this system. Convert it to PNG or JPEG and reimport it.`;
};

/**
 * Reads whatever a file turns out to hold. The declared kind is only a starting
 * point — an audio-only MP4 imports as audio, and a `.mkv` the OS had no name
 * for is read exactly like an `.mp4`.
 *
 * The probe has already run: each route in has its own way of reaching a path,
 * and what the probe said is the only part they share.
 */
async function readTimedMediaDetails({
	result,
	name,
	url,
	declaredType,
}: {
	result: MediaProbeResult;
	name: string;
	url: string;
	declaredType: Extract<MediaType, "video" | "audio">;
}): Promise<MediaDetails | null> {
	if (result.status === "unreadable") {
		// Audio has a second chance: the WebView's own decoders are not ffmpeg's
		// and read a container the shell declined — the same fallback playback
		// already relies on.
		if (declaredType === "audio") {
			const duration = await getElementMediaDuration({ url }).catch(() => null);
			if (duration !== null) {
				return { type: "audio", duration, hasAudio: true };
			}
		}

		// Frames only ever come from the shell's demuxer, so a container it
		// refuses is one the timeline could only show as nothing at all.
		toast.error(`Can't read ${name}`, {
			description: getUnreadableDescription({
				name,
				reason: result.reason,
			}),
		});
		return null;
	}

	const { probe } = result;

	if (probe.type === "audio") {
		return {
			type: "audio",
			duration: probe.duration,
			hasAudio: true,
		};
	}

	if (!probe.canDecodeVideo) {
		toast.error(`Can't preview ${name}`, {
			description: getUnsupportedCodecDescription({ probe }),
		});
	}

	return {
		type: "video",
		duration: probe.duration,
		width: probe.width ?? undefined,
		height: probe.height ?? undefined,
		fps: probe.fps === null ? undefined : Math.round(probe.fps),
		hasAudio: probe.hasAudio,
		thumbnailUrl: probe.thumbnailUrl ?? undefined,
	};
}

/**
 * Imports files where they already are.
 *
 * Nothing is copied and free space is never consulted, because nothing is
 * written: the project keeps the path and reads through it. Importing a 40 GB
 * card dump costs one probe.
 */
export async function processMediaPaths({
	paths,
	onProgress,
}: {
	paths: string[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = paths.length;
	let completed = 0;

	for (const path of paths) {
		const name = basename({ path });
		const fileType = getMediaTypeFromName({ name });

		if (!fileType) {
			toast.error(`Unsupported file type: ${name}`);
			continue;
		}

		try {
			const stat = await tauriStatFile({ path });
			if (!stat) {
				toast.error(`Can't read ${name}`, {
					description: "There is no file at that location.",
				});
				continue;
			}

			// Grant before reading. The canonical path this returns is what the
			// `asset:` protocol matches a request against, so it is also the path
			// worth recording — a relink later compares against the same spelling.
			const allowedPath = await tauriAllowMediaFile({ path });
			const url = tauriConvertFileSrc(allowedPath);

			const details =
				fileType === "image"
					? await readImageDetails({ url, name })
					: await readTimedMediaDetails({
							result: await probeMediaPath({ path: allowedPath }),
							name,
							url,
							declaredType: fileType,
						});

			if (!details) continue;

			processedAssets.push({
				name,
				type: details.type,
				sourcePath: allowedPath,
				path: allowedPath,
				url,
				size: stat.size,
				lastModified: stat.lastModified,
				thumbnailUrl: details.thumbnailUrl,
				duration: details.duration,
				width: details.width,
				height: details.height,
				fps: details.fps,
				hasAudio: details.hasAudio,
			});

			completed += 1;
			onProgress?.({ progress: Math.round((completed / total) * 100) });
		} catch (error) {
			console.error("Error processing path:", path, error);
			toast.error(`Failed to process ${name}`);
		}
	}

	return processedAssets;
}

/**
 * Imports bytes the app has to keep a copy of.
 *
 * Only reached by media with no path behind it — the clipboard, and a drop from
 * an app that handed over bytes rather than a file. All of it is written into
 * the project's media store, so free space is checked first, and the probe's
 * scratch file is carried forward to be moved into place rather than having the
 * same bytes written a second time.
 */
export async function processMediaAssets({
	files,
	onProgress,
}: {
	files: FileList | File[];
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<ProcessedMediaAsset[]> {
	const fileArray = Array.from(files);
	const processedAssets: ProcessedMediaAsset[] = [];

	const total = fileArray.length;
	let completed = 0;

	for (const file of fileArray) {
		const fileType = getMediaTypeFromFile({ file });

		if (!fileType) {
			toast.error(`Unsupported file type: ${file.name}`);
			continue;
		}

		const storageCheck = await storageService.canStoreFile({
			size: file.size,
		});

		if (!storageCheck.canStore) {
			toast.error(`Not enough disk space for ${file.name}`, {
				description: getStorageLimitDescription({
					fileSize: file.size,
					availableBytes: storageCheck.availableBytes,
				}),
			});
			continue;
		}

		const url = URL.createObjectURL(file);
		let stagedPath: string | null = null;

		try {
			let details: MediaDetails | null;

			if (fileType === "image") {
				details = await readImageDetails({ url, name: file.name });
			} else {
				const staged = await probeStagedFile({ file });
				stagedPath = staged.stagedPath;
				details = await readTimedMediaDetails({
					result: staged.result,
					name: file.name,
					url,
					declaredType: fileType,
				});
			}

			// Null means nothing here could read the file, and it has already said
			// so. Adding it anyway would put an entry in the library that draws
			// nothing and exports nothing.
			if (!details) {
				URL.revokeObjectURL(url);
				await discardStagedFile({ stagedPath });
				continue;
			}

			processedAssets.push({
				name: file.name,
				type: details.type,
				file,
				url,
				stagedPath: stagedPath ?? undefined,
				thumbnailUrl: details.thumbnailUrl,
				duration: details.duration,
				width: details.width,
				height: details.height,
				fps: details.fps,
				hasAudio: details.hasAudio,
			});

			await new Promise((resolve) => setTimeout(resolve, 0));

			completed += 1;
			if (onProgress) {
				const percent = Math.round((completed / total) * 100);
				onProgress({ progress: percent });
			}
		} catch (error) {
			console.error("Error processing file:", file.name, error);
			toast.error(`Failed to process ${file.name}`);
			URL.revokeObjectURL(url);
			await discardStagedFile({ stagedPath });
		}
	}

	return processedAssets;
}

/**
 * Duration from the WebView's own media pipeline. Only reached when the shell
 * has already refused the file, so this is the last thing that might know.
 */
const getElementMediaDuration = ({ url }: { url: string }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement("audio");

		const cleanUp = () => {
			element.remove();
		};

		element.addEventListener("loadedmetadata", () => {
			const { duration } = element;
			cleanUp();
			if (Number.isFinite(duration) && duration > 0) {
				resolve(duration);
			} else {
				reject(new Error("Media reported no duration"));
			}
		});

		element.addEventListener("error", () => {
			cleanUp();
			reject(new Error("Could not load media"));
		});

		element.src = url;
		element.load();
	});
};
