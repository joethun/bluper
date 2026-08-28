import {
	buildSeparatedAudioElement as _buildSeparatedAudioElement,
	getSourceAudioActionLabel as _getSourceAudioActionLabel,
	isSourceAudioEnabled as _isSourceAudioEnabled,
	isSourceAudioSeparated as _isSourceAudioSeparated,
} from "bluper-wasm";
import type {
	CreateUploadAudioElement,
	VideoElement,
} from "@/timeline/types";
import { DEFAULTS } from "@/timeline/defaults";

/**
 * Source-audio extraction, now owned by `editor-core::audio_separation`.
 *
 * The three boolean/string helpers take just the field they need rather than
 * the whole video element — `is_source_audio_enabled` is the only source-audio
 * field they look at, and shipping the rest of the element across the bridge
 * to be ignored would round-trip nothing useful.
 *
 * `buildSeparatedAudioElement` takes the source video's fields explicitly for
 * the same reason. The caller spreads the result into a typed
 * `CreateUploadAudioElement` once Rust has done the construction.
 */

export function isSourceAudioEnabled({
	element,
}: {
	element: VideoElement;
}): boolean {
	return _isSourceAudioEnabled({
		isSourceAudioEnabled: element.isSourceAudioEnabled,
	});
}

export function isSourceAudioSeparated({
	element,
}: {
	element: VideoElement;
}): boolean {
	return _isSourceAudioSeparated({
		isSourceAudioEnabled: element.isSourceAudioEnabled,
	});
}

export function getSourceAudioActionLabel({
	element,
}: {
	element: VideoElement;
}): "Extract audio" | "Recover audio" {
	const label = _getSourceAudioActionLabel({
		isSourceAudioEnabled: element.isSourceAudioEnabled,
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return label as "Extract audio" | "Recover audio";
}

/** Cast helper: `MediaTime` flattens to `number` across the boundary. */
function toWasm<T>({ value }: { value: T }): never {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as unknown as never;
}

export function buildSeparatedAudioElement({
	sourceElement,
}: {
	sourceElement: VideoElement;
}): CreateUploadAudioElement {
	const built = _buildSeparatedAudioElement(toWasm({
		value: {
			mediaId: sourceElement.mediaId,
			name: sourceElement.name,
			duration: sourceElement.duration,
			startTime: sourceElement.startTime,
			trimStart: sourceElement.trimStart,
			trimEnd: sourceElement.trimEnd,
			sourceDuration: sourceElement.sourceDuration,
			volume:
				typeof sourceElement.params.volume === "number"
					? sourceElement.params.volume
					: DEFAULTS.element.volume,
			muted: sourceElement.params.muted === true,
			retime: sourceElement.retime,
			animations: sourceElement.animations,
		},
	}));
	return {
		type: "audio",
		sourceType: "upload" as const,
		mediaId: built.mediaId,
		name: built.name,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		duration: built.duration as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		startTime: built.startTime as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		trimStart: built.trimStart as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		trimEnd: built.trimEnd as never,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		sourceDuration: built.sourceDuration as never,
		params: {
			volume: built.params.volume,
			muted: built.params.muted,
		},
		retime: built.retime,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		animations: built.animations as never,
	};
}
