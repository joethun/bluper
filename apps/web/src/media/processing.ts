import { toast } from "sonner";
import {
	describeUnsupportedFormat,
	getMediaFormatFromName,
	getMediaTypeFromFile,
} from "@/wasm/file-types";
import { formatStorageBytes } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import type { MediaAsset, MediaType } from "@/media/types";
import { probeMediaFile } from "./probe";
import type { MediaProbe } from "./probe";
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

const getUnsupportedCodecDescription = ({
	probe,
}: {
	probe: MediaProbe;
}): string => {
	const codecLabel = probe.videoCodec
		? probe.videoCodec.toUpperCase()
		: "this video codec";

	return probe.videoCodec === "hevc"
		? `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 or try importing it in Safari.`
		: `${codecLabel} cannot be decoded in this browser, so this clip may not preview correctly. Convert it to H.264 MP4 and reimport it.`;
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
	})} is safely available in browser storage.`;
};

async function generateImageThumbnail({
	imageFile,
}: {
	imageFile: File;
}): Promise<{ thumbnailUrl: string; width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		const objectUrl = URL.createObjectURL(imageFile);

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
				URL.revokeObjectURL(objectUrl);
				image.remove();
			}
		});

		image.addEventListener("error", () => {
			URL.revokeObjectURL(objectUrl);
			image.remove();
			reject(new Error("Could not load image"));
		});

		image.src = objectUrl;
	});
}

/**
 * Reads an image, or explains why the engine wouldn't. HEIC, TIFF and JPEG XL
 * all depend on the platform's own decoders, so whether they load is a property
 * of the machine rather than of the file.
 *
 * Null means the file was reported and should be skipped: an image the browser
 * won't decode is one nothing downstream can draw either, and a library entry
 * that renders nothing is worse than an honest refusal.
 */
async function readImageDetails({
	file,
}: {
	file: File;
}): Promise<MediaDetails | null> {
	try {
		const { thumbnailUrl, width, height } = await generateImageThumbnail({
			imageFile: file,
		});
		return { type: "image", thumbnailUrl, width, height };
	} catch (error) {
		const label = getMediaFormatFromName({ name: file.name })?.label;
		toast.error(`Can't read ${file.name}`, {
			description: label
				? `${label} images aren't decoded by this browser. Convert it to PNG or JPEG and reimport it.`
				: error instanceof Error
					? error.message
					: "The image could not be decoded.",
		});
		return null;
	}
}

/**
 * Reads whatever a file turns out to hold. The declared kind is only a starting
 * point — an audio-only MP4 imports as audio, and a `.mkv` the OS had no name
 * for is read exactly like an `.mp4`.
 */
async function readTimedMediaDetails({
	file,
	declaredType,
}: {
	file: File;
	declaredType: Extract<MediaType, "video" | "audio">;
}): Promise<MediaDetails | null> {
	const result = await probeMediaFile({ file });

	if (result.status === "unreadable") {
		// Audio has a second chance: `decodeAudioData` runs the platform's own
		// decoders rather than ffmpeg's, and reads a container the shell
		// declined — the same fallback playback already relies on.
		if (declaredType === "audio") {
			const duration = await getElementMediaDuration({ file }).catch(() => null);
			if (duration !== null) {
				return { type: "audio", duration, hasAudio: true };
			}
		}

		// Frames only ever come from the shell's demuxer, so a container it
		// refuses is one the timeline could only show as nothing at all.
		toast.error(`Can't read ${file.name}`, {
			description: getUnreadableDescription({
				name: file.name,
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
		toast.error(`Can't preview ${file.name}`, {
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
			toast.error(`Not enough browser storage for ${file.name}`, {
				description: getStorageLimitDescription({
					fileSize: file.size,
					availableBytes: storageCheck.availableBytes,
				}),
			});
			continue;
		}

		const url = URL.createObjectURL(file);

		try {
			const details =
				fileType === "image"
					? await readImageDetails({ file })
					: await readTimedMediaDetails({ file, declaredType: fileType });

			// Null means nothing here could read the file, and it has already said
			// so. Adding it anyway would put an entry in the library that draws
			// nothing and exports nothing.
			if (!details) {
				URL.revokeObjectURL(url);
				continue;
			}

			processedAssets.push({
				name: file.name,
				type: details.type,
				file,
				url,
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
		}
	}

	return processedAssets;
}

/**
 * Duration from the platform's own media pipeline. Only reached when mediabunny
 * has already refused the file, so this is the last thing that might know.
 */
const getElementMediaDuration = ({ file }: { file: File }): Promise<number> => {
	return new Promise((resolve, reject) => {
		const element = document.createElement("audio");
		const objectUrl = URL.createObjectURL(file);

		const cleanUp = () => {
			URL.revokeObjectURL(objectUrl);
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

		element.src = objectUrl;
		element.load();
	});
};
