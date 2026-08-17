import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
} from "@/timeline";
import { shouldMaintainPitch } from "@/retime/rate";
import type { MediaAsset } from "@/media/types";
import { applyAudioMasteringToBuffer } from "@/media/audio-mastering";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio } from "@/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { TICKS_PER_SECOND } from "@/wasm";
import { createMediaSource, type MediaSourceRef } from "@/media/source";
import { decodeAudioBufferFromRef } from "@/media/decode-audio";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

interface CollectedAudioElement {
	timelineElement: AudioCapableElement;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

interface AudibleElementCandidate {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
}

function collectAudibleCandidates({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): AudibleElementCandidate[] {
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(mediaAssets.map((a) => [a.id, a]));
	const candidates: AudibleElementCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			candidates.push({ element, mediaAsset });
		}
	}

	return candidates;
}

async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
	signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
	signal?: AbortSignal;
}): Promise<CollectedAudioElement[]> {
	const candidates = collectAudibleCandidates({ tracks, mediaAssets });
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	for (const { element, mediaAsset } of candidates) {
		if (element.type === "audio") {
			pendingElements.push(
				resolveAudioBufferForElement({
					element,
					mediaMap,
					audioContext,
					signal,
				}).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: isElementMuted({ element }),
						retime: element.retime,
					};
				}),
			);
			continue;
		}

		if (element.type === "video") {
			if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

			pendingElements.push(
				resolveAudioBufferForAsset({
					asset: mediaAsset,
					audioContext,
				}).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: isElementMuted({ element }),
						retime: element.retime,
					};
				}),
			);
		}
	}

	const resolvedElements = await Promise.all(pendingElements);
	signal?.throwIfAborted();

	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
	signal,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset) return null;
			return await resolveAudioBufferForAsset({ asset, audioContext });
		}

		if (element.buffer) return element.buffer;

		// A cancelled export aborts these fetches - propagate so the caller can
		// report it as cancelled instead of silently exporting without audio.
		const response = await fetch(element.sourceUrl, { signal });
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		return await decodeAudioBufferFromRef({
			ref: { kind: "blob", blob },
			sampleRate: audioContext.sampleRate,
			maxChannels: MAX_AUDIO_CHANNELS,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForAsset({
	asset,
	audioContext,
}: {
	asset: MediaAsset;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	const ref = createMediaSource({ asset });
	if (!ref) return null;
	return await decodeAudioBufferFromRef({
		ref,
		sampleRate: audioContext.sampleRate,
		maxChannels: MAX_AUDIO_CHANNELS,
	});
}

export interface AudioClipSource {
	timelineElement: AudioCapableElement;
	id: string;
	sourceKey: string;
	/**
	 * Where the clip's bytes are. Not a `File`: on the desktop build media is
	 * read off the filesystem through a URL instead of being copied into the
	 * page. See {@link MediaSourceRef}.
	 */
	source: MediaSourceRef;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();

		return {
			timelineElement: element,
			id: element.id,
			sourceKey: element.id,
			source: { kind: "blob", blob },
			// Every other clip source reports seconds; a timeline element stores
			// ticks. Handing the scheduler ticks put a library clip 120000 times
			// its own start into the future, so it never played at all.
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			muted,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	volume: number;
}): AudioClipSource | null {
	const source = createMediaSource({ asset: mediaAsset });
	if (!source) return null;

	return {
		timelineElement: element,
		id: element.id,
		sourceKey: mediaAsset.id,
		source,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: element.retime,
	};
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			const muted = isTrackMuted || isElementMuted({ element });
			const volume = resolveEffectiveAudioGain({
				element,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					const clip = collectMediaAudioClip({
						element,
						mediaAsset,
						muted,
						volume,
					});
					if (clip) clips.push(clip);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					const clip = collectMediaAudioClip({
						element,
						mediaAsset,
						muted,
						volume,
					});
					if (clip) clips.push(clip);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
	signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });

	const audioElements = await collectAudioElements({
		tracks,
		mediaAssets,
		audioContext: context,
		signal,
	});

	if (audioElements.length === 0) return null;

	const outputChannels = 2;
	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = Math.ceil(durationSeconds * sampleRate);
	const outputBuffer = context.createBuffer(
		outputChannels,
		outputLength,
		sampleRate,
	);

	for (const element of audioElements) {
		signal?.throwIfAborted();

		if (!element.muted) {
			const renderedBuffer = shouldMaintainPitch({
				rate: element.retime?.rate ?? 1,
				maintainPitch: element.retime?.maintainPitch,
			})
				? (
						await renderRetimedBuffer({
							audioContext: context,
							sourceBuffer: element.buffer,
							trimStart: element.trimStart,
							clipDuration: element.duration,
							retime: element.retime,
							maintainPitch: true,
						})
					).buffer
				: undefined;

			mixAudioChannels({
				element,
				buffer: renderedBuffer ?? element.buffer,
				trimStart: renderedBuffer ? 0 : element.trimStart,
				retime: renderedBuffer ? undefined : element.retime,
				outputBuffer,
				outputLength,
				sampleRate,
			});
		}
	}

	signal?.throwIfAborted();
	return await applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
}

function mixAudioChannels({
	element,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { startTime, duration: elementDuration } = element;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart +
				getSourceTimeAtClipTime({
					clipTime,
					clipDuration: elementDuration,
					retime,
				});
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ element: element.timelineElement })
				? resolveEffectiveAudioGain({
						element: element.timelineElement,
						localTime: clipTime,
					})
				: element.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
