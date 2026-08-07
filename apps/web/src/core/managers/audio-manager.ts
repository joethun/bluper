import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime/rate";
import type { AudioClipSource } from "@/media/audio";
import { createAudioContext, collectAudioClips } from "@/media/audio";
import {
	buildAudioGainAutomation,
	hasAnimatedVolume,
} from "@/timeline/audio-state";
import { createAudioMasteringChain } from "@/media/audio-mastering";
import { rememberInCache } from "@/media/audio-cache";
import {
	getClipTimeAtSourceTime,
	getSourceTimeAtClipTime,
	hasRetimeCurve,
	renderRetimedBuffer,
} from "@/retime";
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";

/**
 * How much decoded and rendered audio is kept. Both hold whole clips in memory,
 * so they are bounded rather than cleared: the point is to survive an edit and a
 * replay, not to hold a long project's every source at once. A decoded source is
 * the bigger of the two — it is the whole file, however little of it a clip
 * uses — so fewer of those are kept.
 */
const MAX_CACHED_DECODED_SOURCES = 4;
const MAX_CACHED_PREPARED_CLIPS = 12;

/**
 * How long a clip's playback gain takes to ramp from 0 to its target volume at
 * its start, and back to 0 at its end. Every video editor masks edit-point
 * discontinuities this way — Premiere, Final Cut, DaVinci Resolve and CapCut
 * all apply an implicit short fade across every cut. Without it, the last
 * chunk of an outgoing half can play past the boundary while the incoming
 * half's first chunk plays over it, summing into `masterGain` and popping.
 */
const MICRO_FADE_SECONDS = 0.005;

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private playbackStartTime = 0;
	private playbackStartContextTime = 0;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 2;
	private scheduleIntervalMs = 500;
	private clips: AudioClipSource[] = [];
	private sinks = new Map<string, AudioBufferSink>();
	private inputs = new Map<string, Input>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<WrappedAudioBuffer, void, unknown>
	>();
	private queuedSources = new Set<AudioBufferSourceNode>();
	private preparedClipBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private decodedBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private playbackSessionId = 0;
	private lastIsPlaying = false;
	private lastIsScrubbing = false;
	private lastVolume = 1;
	private playbackLatencyCompensationSeconds = 0;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
			this.editor.playback.onSeek(this.handleSeek),
		);
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.disposeSinks();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const isScrubbing = this.editor.playback.getIsScrubbing();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		const wasPlaying = this.lastIsPlaying;
		const wasScrubbing = this.lastIsScrubbing;
		this.lastIsPlaying = isPlaying;
		this.lastIsScrubbing = isScrubbing;

		if (isPlaying === wasPlaying && isScrubbing === wasScrubbing) return;

		// Scrubbing has to be tracked here, not just in handleSeek: every scrub
		// step stops audio, and a gesture released mid-playback emits no further
		// seek to start it again. Without this, audio stays dead until the next
		// play/pause toggle.
		if (isPlaying && !isScrubbing) {
			void this.startPlayback({
				time: this.editor.playback.getCurrentTime() / TICKS_PER_SECOND,
			});
			return;
		}

		this.stopPlayback();
	};

	private handleSeek = (time: number): void => {
		if (this.editor.playback.getIsScrubbing()) {
			this.stopPlayback();
			return;
		}

		if (this.editor.playback.getIsPlaying()) {
			void this.startPlayback({ time: time / TICKS_PER_SECOND });
			return;
		}

		this.stopPlayback();
	};

	/**
	 * Neither audio cache is dropped here.
	 *
	 * Decoding a source means reading its every sample, and rendering a retimed
	 * clip means walking that again — seconds of work for a long file. Both used to
	 * be thrown away on any timeline notification, so a clip that needed rendering
	 * started from nothing on every attempt to play it, and lost the race against
	 * its own playback often enough that it took several tries to hear it.
	 *
	 * Neither cache can go stale. Decoded audio is keyed by its source and comes
	 * from an unchanging file; a rendered clip is keyed by the timing and retime it
	 * was rendered for, so an edit asks a different question and gets a different
	 * entry. What they need is a bound, not invalidation — see `rememberInCache`.
	 */
	private handleTimelineChange = (): void => {
		this.disposeSinks();

		if (!this.editor.playback.getIsPlaying()) return;

		void this.startPlayback({
			time: this.editor.playback.getCurrentTime() / TICKS_PER_SECOND,
		});
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		const { input } = createAudioMasteringChain({
			audioContext: this.audioContext,
			destination: this.audioContext.destination,
		});
		this.masterGain = input;
		this.masterGain.gain.value = this.lastVolume;
		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private getPlaybackTime(): number {
		if (!this.audioContext) return this.playbackStartTime;
		const elapsed =
			this.audioContext.currentTime - this.playbackStartContextTime;
		return this.playbackStartTime + elapsed;
	}

	private async startPlayback({ time }: { time: number }): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		this.stopPlayback();
		this.playbackSessionId++;
		this.playbackLatencyCompensationSeconds = 0;

		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			await audioContext.resume();
		}

		this.clips = await collectAudioClips({ tracks, mediaAssets });
		if (!this.editor.playback.getIsPlaying()) return;
		// A scrub can begin while the awaits above are in flight; its stopPlayback
		// already ran, so scheduling now would leave audio running under the drag.
		if (this.editor.playback.getIsScrubbing()) return;

		this.playbackStartTime = time;
		this.playbackStartContextTime = audioContext.currentTime;

		// Clips that have to be rendered before they can be heard are started now
		// rather than when the playhead is a lookahead away from them. A retimed
		// clip sitting under the playhead has no lead time at all otherwise: the
		// render begins at the moment its audio is already due.
		this.warmPreparedClipBuffers({ fromTime: time });

		this.scheduleUpcomingClips();

		if (typeof window !== "undefined") {
			this.scheduleTimer = window.setInterval(() => {
				this.scheduleUpcomingClips();
			}, this.scheduleIntervalMs);
		}
	}

	private scheduleUpcomingClips(): void {
		if (!this.editor.playback.getIsPlaying()) return;

		const currentTime = this.getPlaybackTime();
		const windowEnd = currentTime + this.lookaheadSeconds;

		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (this.activeClipIds.has(clip.id)) continue;

			const clipEnd = clip.startTime + clip.duration;
			if (clipEnd <= currentTime) continue;
			if (clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			if (this.shouldUsePreparedClipBuffer({ clip })) {
				void this.schedulePreparedClip({
					clip,
					startTime: currentTime,
					sessionId: this.playbackSessionId,
				});
			} else {
				void this.runClipIterator({
					clip,
					startTime: currentTime,
					sessionId: this.playbackSessionId,
				});
			}
		}
	}

	private warmPreparedClipBuffers({ fromTime }: { fromTime: number }): void {
		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (clip.startTime + clip.duration <= fromTime) continue;
			if (!this.shouldUsePreparedClipBuffer({ clip })) continue;

			// Fire and forget: the result is cached, so whoever schedules the clip
			// picks up this same render rather than starting another.
			void this.getPreparedClipBuffer({ clip });
		}
	}

	private stopPlayback(): void {
		if (this.scheduleTimer && typeof window !== "undefined") {
			window.clearInterval(this.scheduleTimer);
		}
		this.scheduleTimer = null;

		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const source of this.queuedSources) {
			try {
				source.stop();
			} catch {}
			source.disconnect();
		}
		this.queuedSources.clear();
	}

	private async runClipIterator({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const sink = await this.getAudioSink({ clip });
		if (!sink || !this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterSinkReady = this.getPlaybackTime();
		const iteratorStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterSinkReady,
		);
		if (iteratorStartTime >= clipEnd) {
			return;
		}
		const sourceStartTime =
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: iteratorStartTime - clip.startTime,
				clipDuration: clip.duration,
				retime: clip.retime,
			});

		const iterator = sink.buffers(sourceStartTime);
		this.clipIterators.set(clip.id, iterator);
		let consecutiveDroppedBufferCount = 0;

		for await (const { buffer, timestamp } of iterator) {
			if (!this.editor.playback.getIsPlaying()) return;
			if (sessionId !== this.playbackSessionId) return;

			const timelineTime =
				clip.startTime +
				getClipTimeAtSourceTime({
					sourceTime: timestamp - clip.trimStart,
					clipDuration: clip.duration,
					retime: clip.retime,
				});
			if (timelineTime >= clipEnd) break;

			const node = audioContext.createBufferSource();
			node.buffer = buffer;
			const playbackRate = clip.retime
				? clampRetimeRate({ rate: clip.retime.rate })
				: 1;
			node.playbackRate.value = playbackRate;
			const clipGain = audioContext.createGain();
			node.connect(clipGain);
			clipGain.connect(this.masterGain ?? audioContext.destination);

			const startTimestamp =
				this.playbackStartContextTime +
				this.playbackLatencyCompensationSeconds +
				(timelineTime - this.playbackStartTime);

			// The iterator's first chunk can land slightly before its requested
			// source time (mediabunny snaps to packet boundaries) and `playbackStartContextTime`
			// can be near zero right after the audio context is created, so the
			// computed `startTimestamp` can be a small negative number. AudioParam
			// scheduling rejects negative times, so clamp to the current audio
			// context time and skip into the buffer by the same offset.
			const lateOffset =
				startTimestamp < audioContext.currentTime
					? audioContext.currentTime - startTimestamp
					: 0;
			const actualStartTimestamp = startTimestamp + lateOffset;

			if (lateOffset >= buffer.duration) {
				consecutiveDroppedBufferCount += 1;
				if (consecutiveDroppedBufferCount >= 5) {
					const nextCompensationSeconds = Math.max(
						this.playbackLatencyCompensationSeconds,
						Math.min(0.25, lateOffset + 0.01),
					);
					if (
						nextCompensationSeconds >
						this.playbackLatencyCompensationSeconds + 0.001
					) {
						this.playbackLatencyCompensationSeconds = nextCompensationSeconds;
					}
					const resyncStartTime = this.getPlaybackTime();
					this.clipIterators.delete(clip.id);
					void this.runClipIterator({
						clip,
						startTime: resyncStartTime,
						sessionId,
					});
					return;
				}
				continue;
			}

			// Fade the chunk's gain envelope in at the clip's head (if this is
			// the first chunk) and out at the clip's tail (if this chunk crosses
			// it). A streamed chunk's boundary does not line up with the cut, so
			// the outgoing half's last chunk is scheduled to start before the
			// cut and would otherwise keep playing through it. Ramping to zero
			// at `clipEndTimestamp` keeps that overlap silent.
			const clipEndTimestamp =
				this.playbackStartContextTime +
				this.playbackLatencyCompensationSeconds +
				(clipEnd - this.playbackStartTime);
			const chunkEndTimestamp = startTimestamp + buffer.duration / playbackRate;
			this.scheduleChunkGainEnvelope({
				clipGain,
				startTimestamp: actualStartTimestamp,
				chunkEndTimestamp,
				clipEndTimestamp,
				volume: clip.volume,
				applyFadeIn: timelineTime - clip.startTime < MICRO_FADE_SECONDS,
			});

			node.start(actualStartTimestamp, lateOffset);
			consecutiveDroppedBufferCount = 0;

			this.queuedSources.add(node);
			node.addEventListener("ended", () => {
				node.disconnect();
				clipGain.disconnect();
				this.queuedSources.delete(node);
			});

			const aheadTime = timelineTime - this.getPlaybackTime();
			if (aheadTime >= 1) {
				await this.waitUntilCaughtUp({ timelineTime, targetAhead: 1 });
				if (sessionId !== this.playbackSessionId) return;
			}
		}

		this.clipIterators.delete(clip.id);
		// don't remove from activeClipIds - prevents scheduler from restarting this clip
		// the set is cleared on stopPlayback anyway
	}

	private async schedulePreparedClip({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		const buffer = await this.getPreparedClipBuffer({ clip });
		if (!buffer) {
			// Nothing came back, so this clip is not on its way to being heard.
			// Releasing it puts it back in front of the scheduler, which comes round
			// again every `scheduleIntervalMs` — a clip whose audio was still being
			// rendered then starts as soon as it is ready, instead of staying silent
			// until the user stops and plays again. A clip that genuinely cannot be
			// prepared answers from cache, so retrying it costs nothing.
			this.activeClipIds.delete(clip.id);
			return;
		}
		if (!this.editor.playback.getIsPlaying()) return;
		if (sessionId !== this.playbackSessionId) return;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterReady = this.getPlaybackTime();
		const effectiveStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterReady,
		);
		if (effectiveStartTime >= clipEnd) {
			return;
		}

		const node = audioContext.createBufferSource();
		node.buffer = buffer;
		const clipGain = audioContext.createGain();
		node.connect(clipGain);
		clipGain.connect(this.masterGain ?? audioContext.destination);

		const startTimestamp =
			this.playbackStartContextTime +
			this.playbackLatencyCompensationSeconds +
			(effectiveStartTime - this.playbackStartTime);
		const clipOffset = effectiveStartTime - clipStart;
		let actualStartTimestamp = startTimestamp;
		let actualClipOffset = clipOffset;

		if (startTimestamp >= audioContext.currentTime) {
			node.start(startTimestamp, clipOffset);
		} else {
			const lateOffset = audioContext.currentTime - startTimestamp;
			actualStartTimestamp = audioContext.currentTime;
			actualClipOffset = clipOffset + lateOffset;
			node.start(actualStartTimestamp, actualClipOffset);
		}

		this.scheduleClipGainAutomation({
			audioContext,
			clip,
			clipGain,
			startTimestamp: actualStartTimestamp,
			startLocalTime: actualClipOffset,
		});

		this.queuedSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			clipGain.disconnect();
			this.queuedSources.delete(node);
		});
	}

	private waitUntilCaughtUp({
		timelineTime,
		targetAhead,
	}: {
		timelineTime: number;
		targetAhead: number;
	}): Promise<void> {
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				if (!this.editor.playback.getIsPlaying()) {
					clearInterval(checkInterval);
					resolve();
					return;
				}

				const playbackTime = this.getPlaybackTime();
				if (timelineTime - playbackTime < targetAhead) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}

	private disposeSinks(): void {
		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
		this.sinks.clear();
	}

	/**
	 * Whether a clip has to be rendered up front instead of streamed. Streaming
	 * plays decoded chunks through a buffer source, which can only hold one
	 * playback rate, so a speed curve — like animated volume or pitch
	 * preservation — needs the whole clip laid out in advance.
	 */
	private shouldUsePreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): boolean {
		return (
			hasRetimeCurve({ retime: clip.retime }) ||
			hasAnimatedVolume({ element: clip.timelineElement }) ||
			shouldMaintainPitch({
				rate: clip.retime?.rate ?? 1,
				maintainPitch: clip.retime?.maintainPitch,
			})
		);
	}

	private scheduleChunkGainEnvelope({
		clipGain,
		startTimestamp,
		chunkEndTimestamp,
		clipEndTimestamp,
		volume,
		applyFadeIn,
	}: {
		clipGain: GainNode;
		startTimestamp: number;
		chunkEndTimestamp: number;
		clipEndTimestamp: number;
		volume: number;
		applyFadeIn: boolean;
	}): void {
		// AudioParam scheduling rejects negative times, and the iterator can
		// pass a small negative value when the first chunk arrives before the
		// audio context has had time to advance from zero. Clamp here as a
		// safety net so a miss elsewhere cannot poison playback.
		const safeStartTimestamp = Math.max(0, startTimestamp);

		clipGain.gain.cancelScheduledValues(safeStartTimestamp);

		if (applyFadeIn) {
			clipGain.gain.setValueAtTime(0, safeStartTimestamp);
			clipGain.gain.linearRampToValueAtTime(volume, safeStartTimestamp + MICRO_FADE_SECONDS);
		} else {
			clipGain.gain.setValueAtTime(volume, safeStartTimestamp);
		}

		// The chunk crosses the clip's fade-out window, so ramp to silence by
		// `clipEndTimestamp`. This is the half that masks the boundary pop: the
		// outgoing chunk plays past the cut, but it is already at 0 by the time
		// the next half's first chunk begins, so the two do not sum.
		if (chunkEndTimestamp >= clipEndTimestamp - MICRO_FADE_SECONDS) {
			const fadeOutStart = clipEndTimestamp - MICRO_FADE_SECONDS;
			const holdStart = applyFadeIn
				? Math.max(safeStartTimestamp + MICRO_FADE_SECONDS, fadeOutStart)
				: Math.max(safeStartTimestamp, fadeOutStart);
			clipGain.gain.setValueAtTime(volume, holdStart);
			clipGain.gain.linearRampToValueAtTime(0, clipEndTimestamp);
		}
	}

	private scheduleClipGainAutomation({
		audioContext,
		clip,
		clipGain,
		startTimestamp,
		startLocalTime,
	}: {
		audioContext: AudioContext;
		clip: AudioClipSource;
		clipGain: GainNode;
		startTimestamp: number;
		startLocalTime: number;
	}): void {
		const microFade = MICRO_FADE_SECONDS;
		const clipEndTimestamp = startTimestamp + (clip.duration - startLocalTime);
		const fadeOutStart = clipEndTimestamp - microFade;

		clipGain.gain.cancelScheduledValues(startTimestamp);
		clipGain.gain.setValueAtTime(0, startTimestamp);

		if (!hasAnimatedVolume({ element: clip.timelineElement })) {
			clipGain.gain.linearRampToValueAtTime(clip.volume, startTimestamp + microFade);
			if (fadeOutStart > startTimestamp + microFade) {
				clipGain.gain.setValueAtTime(clip.volume, fadeOutStart);
			}
			clipGain.gain.linearRampToValueAtTime(0, clipEndTimestamp);
			return;
		}

		const points = buildAudioGainAutomation({
			element: clip.timelineElement,
			fromLocalTime: startLocalTime,
			toLocalTime: clip.duration,
		});

		if (points.length === 0) {
			clipGain.gain.linearRampToValueAtTime(clip.volume, startTimestamp + microFade);
			if (fadeOutStart > startTimestamp + microFade) {
				clipGain.gain.setValueAtTime(clip.volume, fadeOutStart);
			}
			clipGain.gain.linearRampToValueAtTime(0, clipEndTimestamp);
			return;
		}

		// Fade in to the first keyframe's gain (the value the original code
		// snapped to there), then continue with the existing keyframe ramps.
		const firstPoint = points[0];
		const firstPointTimestamp =
			startTimestamp + (firstPoint.localTime - startLocalTime);
		const fadeInEnd = startTimestamp + microFade;
		if (firstPointTimestamp > fadeInEnd) {
			clipGain.gain.linearRampToValueAtTime(firstPoint.gain, fadeInEnd);
			clipGain.gain.setValueAtTime(firstPoint.gain, firstPointTimestamp);
		} else {
			clipGain.gain.linearRampToValueAtTime(firstPoint.gain, firstPointTimestamp);
		}

		for (let index = 1; index < points.length; index++) {
			const point = points[index];
			const pointTimestamp =
				startTimestamp + (point.localTime - startLocalTime);
			if (pointTimestamp < audioContext.currentTime) {
				continue;
			}

			clipGain.gain.linearRampToValueAtTime(point.gain, pointTimestamp);
		}

		// Fade out from the last keyframe (or the fade-out anchor) to silence
		// at the clip's end. Anchoring at `Math.max(lastPointTimestamp,
		// fadeOutStart)` lets a keyframe close to the end override the ramp.
		const lastPoint = points[points.length - 1];
		const lastPointTimestamp =
			startTimestamp + (lastPoint.localTime - startLocalTime);
		const holdStart = Math.max(lastPointTimestamp, fadeOutStart);
		clipGain.gain.setValueAtTime(lastPoint.gain, holdStart);
		clipGain.gain.linearRampToValueAtTime(0, clipEndTimestamp);
	}

	private buildPreparedClipCacheKey({
		clip,
	}: {
		clip: AudioClipSource;
	}): string {
		return JSON.stringify({
			id: clip.id,
			sourceKey: clip.sourceKey,
			startTime: clip.startTime,
			duration: clip.duration,
			trimStart: clip.trimStart,
			trimEnd: clip.trimEnd,
			retime: clip.retime ?? null,
		});
	}

	private async getPreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const cacheKey = this.buildPreparedClipCacheKey({ clip });
		const existing = this.preparedClipBuffers.get(cacheKey);
		if (existing) {
			return existing;
		}

		const promise = (async () => {
			const audioContext = this.ensureAudioContext();
			if (!audioContext) {
				return null;
			}

			const decodedBuffer = await this.getDecodedBuffer({ clip });
			if (!decodedBuffer) {
				return null;
			}

			return await renderRetimedBuffer({
				audioContext,
				sourceBuffer: decodedBuffer,
				trimStart: clip.trimStart,
				clipDuration: clip.duration,
				retime: clip.retime,
				maintainPitch: clip.retime?.maintainPitch === true,
			});
		})().catch((error) => {
			// A rejection has to become a cached `null` rather than a cached
			// rejection: the entry is read again on every scheduling pass, and a
			// stored rejection would both go unhandled and keep the clip silent for
			// as long as the entry lived.
			console.warn("Failed to prepare clip audio:", error);
			return null;
		});

		rememberInCache({
			cache: this.preparedClipBuffers,
			key: cacheKey,
			value: promise,
			limit: MAX_CACHED_PREPARED_CLIPS,
		});
		return promise;
	}

	private async getDecodedBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const existing = this.decodedBuffers.get(clip.sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.decodeClipBuffer({ clip });
		rememberInCache({
			cache: this.decodedBuffers,
			key: clip.sourceKey,
			value: promise,
			limit: MAX_CACHED_DECODED_SOURCES,
		});
		return promise;
	}

	private async decodeClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) {
			return null;
		}

		const input = new Input({
			source: new BlobSource(clip.file),
			formats: ALL_FORMATS,
		});

		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			const chunks: AudioBuffer[] = [];
			let totalSamples = 0;

			for await (const { buffer } of sink.buffers(0)) {
				chunks.push(buffer);
				totalSamples += buffer.length;
			}

			if (chunks.length === 0) {
				return null;
			}

			const targetSampleRate = audioContext.sampleRate;
			const nativeSampleRate = chunks[0].sampleRate;
			const numChannels = Math.min(2, chunks[0].numberOfChannels);
			const nativeChannels = Array.from(
				{ length: numChannels },
				() => new Float32Array(totalSamples),
			);

			let offset = 0;
			for (const chunk of chunks) {
				for (let channel = 0; channel < numChannels; channel++) {
					nativeChannels[channel].set(
						chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)),
						offset,
					);
				}
				offset += chunk.length;
			}

			const outputSamples = Math.ceil(
				totalSamples * (targetSampleRate / nativeSampleRate),
			);
			const offlineContext = new OfflineAudioContext(
				numChannels,
				outputSamples,
				targetSampleRate,
			);
			const nativeBuffer = audioContext.createBuffer(
				numChannels,
				totalSamples,
				nativeSampleRate,
			);

			for (let channel = 0; channel < numChannels; channel++) {
				nativeBuffer.copyToChannel(nativeChannels[channel], channel);
			}

			const sourceNode = offlineContext.createBufferSource();
			sourceNode.buffer = nativeBuffer;
			sourceNode.connect(offlineContext.destination);
			sourceNode.start(0);

			return await offlineContext.startRendering();
		} catch (error) {
			console.warn("Failed to decode clip audio:", error);
			return null;
		} finally {
			input.dispose();
		}
	}

	private async getAudioSink({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBufferSink | null> {
		const existingSink = this.sinks.get(clip.sourceKey);
		if (existingSink) return existingSink;

		try {
			const input = new Input({
				source: new BlobSource(clip.file),
				formats: ALL_FORMATS,
			});
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				input.dispose();
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			this.inputs.set(clip.sourceKey, input);
			this.sinks.set(clip.sourceKey, sink);
			return sink;
		} catch (error) {
			console.warn("Failed to initialize audio sink:", error);
			return null;
		}
	}
}
