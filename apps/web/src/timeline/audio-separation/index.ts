import type { MediaAsset } from "@/media/types";
import {
	buildSeparatedAudioElement as _buildSeparatedAudioElement,
	getSourceAudioActionLabel as _getSourceAudioActionLabel,
	isSourceAudioEnabled as _isSourceAudioEnabled,
	isSourceAudioSeparated as _isSourceAudioSeparated,
} from "@/wasm";
import type {
	AudioElement,
	CreateUploadAudioElement,
	TimelineElement,
	VideoElement,
} from "../types";

type MediaAudioState = Pick<MediaAsset, "hasAudio">;

/**
 * Whether the clip's built-in audio is still playing. `false` only when the user
 * has extracted it; `true` is stored as `undefined` so a project written by an
 * older build still plays audio.
 */
function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return _isSourceAudioEnabled({ element });
}

/**
 * Inverse of {@link isSourceAudioEnabled}: a video is separated when its
 * `isSourceAudioEnabled` is the one value it does not default to.
 */
export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return _isSourceAudioSeparated({ element });
}

export function canExtractSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		element.type === "video" &&
		isSourceAudioEnabled({ element }) &&
		!!mediaAsset &&
		mediaAsset.hasAudio !== false
	);
}

export function canRecoverSourceAudio(
	element: TimelineElement,
): element is VideoElement {
	return element.type === "video" && isSourceAudioSeparated({ element });
}

export function canToggleSourceAudio(
	element: TimelineElement,
	mediaAsset: MediaAudioState | null | undefined,
): element is VideoElement {
	return (
		canRecoverSourceAudio(element) || canExtractSourceAudio(element, mediaAsset)
	);
}

export function doesElementHaveEnabledAudio({
	element,
	mediaAsset,
}: {
	element: AudioElement | VideoElement;
	mediaAsset?: MediaAudioState | null;
}): boolean {
	if (element.type === "audio") {
		return true;
	}

	return (
		!!mediaAsset &&
		mediaAsset.hasAudio !== false &&
		isSourceAudioEnabled({ element })
	);
}

/**
 * Constructs a standalone audio element from a video clip's source. Math now
 * owned by `editor-core::audio_separation`.
 */
export function buildSeparatedAudioElement({
	sourceElement,
}: {
	sourceElement: VideoElement;
}): CreateUploadAudioElement {
	return _buildSeparatedAudioElement({ sourceElement });
}

/** Which label the action button shows. "Recover" when the audio is already off. */
export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Extract audio" | "Recover audio" {
	return _getSourceAudioActionLabel({ element });
}
