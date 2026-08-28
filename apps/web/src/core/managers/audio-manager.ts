import type { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime";
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
	type RenderedClipAudio,
} from "@/retime";
import { StreamResampler } from "@/media/stream-resampler";
import {
	NativeAudioStream,
	type NativeAudioWindow,
} from "@/media/native-audio";
import {
	createEmptyAudioBuffer,
	decodeAudioBufferFromRef,
} from "@/media/decode-audio";

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
 * How many decoded sources may stay staged once no clip reads them.
 *
 * A stream is a whole track decoded to `f32` on disk, so this is the ceiling on
 * what a session leaves in the cache directory. Sources that clips *do* read
 * are held regardless of this number — see {@link AudioManager.evictUnusedSinks}.
 */
const MAX_OPEN_AUDIO_SINKS = 8;

/**
 * How long an edit point takes to cross from the outgoing clip to the incoming
 * one.
 *
 * The two ramps cover the *same* window, which is the whole point. A clip fades
 * in over the material it has before its own start — the pre-roll every trimmed
 * clip has — so while the outgoing half falls from 1 to 0 the incoming half
 * rises from 0 to 1 over exactly the same span. Where a cut splits continuous
 * audio both halves carry the same signal there, so the two ramps sum back to
 * it and the edit is inaudible; where a cut joins unrelated material this is a
 * 5ms crossfade, which is what every editor puts there.
 *
 * Fading each half to silence at the cut instead — which is what this used to
 * do — punches a 10ms hole through a waveform that was continuous, and a hole
 * is a pop.
 */
const CROSSFADE_SECONDS = 0.005;

/**
 * Ramp used where audio has to begin somewhere other than a clip's own edge —
 * playback started under the clip, or a packet arrived too late to play whole.
 * There is no material to crossfade with there, only a waveform starting
 * abruptly at whatever value it happens to hold, so it gets a slope short
 * enough not to be heard as a fade but long enough not to be heard as a click.
 */
const DECLICK_SECONDS = 0.002;

/**
 * How far a packet's own timing may sit from where the scheduler was going to
 * put it before the scheduler gives up and follows the packet. Normal jitter is
 * far below this; a gap in the stream is far above it.
 */
const CURSOR_RESYNC_TOLERANCE_SECONDS = 0.02;

/** Late packets in a row before playback is resynchronised. */
const MAX_CONSECUTIVE_DROPPED_BUFFERS = 5;

/** Upper bound on how much output latency playback will compensate for. */
const MAX_LATENCY_COMPENSATION_SECONDS = 0.25;

/** How long the master volume takes to reach a newly set level. */
const VOLUME_RAMP_SECONDS = 0.02;

/** The mix is stereo, so there is nothing to gain from decoding more. */
const PLAYBACK_CHANNELS = 2;

/**
 * A clip's gain envelope in audio context time: silent before `inStart`, at
 * full gain between `inEnd` and `outStart`, silent again from `outEnd`.
 */
interface ClipFadeWindows {
	inStart: number;
	inEnd: number;
	outStart: number;
	outEnd: number;
}

function buildClipFadeWindows({
	clipStartTimestamp,
	clipEndTimestamp,
	preRollSeconds,
}: {
	clipStartTimestamp: number;
	clipEndTimestamp: number;
	preRollSeconds: number;
}): ClipFadeWindows {
	// With pre-roll the ramp finishes on the clip's start, so it overlaps the
	// outgoing clip's ramp. Without it there is nothing to overlap with and the
	// clip fades up from its own first sample, which is right: audio genuinely
	// begins there.
	const inEnd = Math.min(
		preRollSeconds > 0
			? clipStartTimestamp
			: clipStartTimestamp + CROSSFADE_SECONDS,
		clipEndTimestamp,
	);

	return {
		inStart: clipStartTimestamp - preRollSeconds,
		inEnd,
		outStart: Math.max(inEnd, clipEndTimestamp - CROSSFADE_SECONDS),
		outEnd: clipEndTimestamp,
	};
}

function envelopeFactorAt({
	time,
	fade,
}: {
	time: number;
	fade: ClipFadeWindows;
}): number {
	if (time <= fade.inStart) return 0;
	if (time < fade.inEnd) {
		return (time - fade.inStart) / (fade.inEnd - fade.inStart);
	}
	if (time <= fade.outStart) return 1;
	if (time >= fade.outEnd) return 0;
	return (fade.outEnd - time) / (fade.outEnd - fade.outStart);
}

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private playbackStartTime = 0;
	private playbackStartContextTime = 0;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 2;
	private scheduleIntervalMs = 500;
	private clips: AudioClipSource[] = [];
	private sinks = new Map<string, NativeAudioStream>();
	/**
	 * Sink opens in flight, by source.
	 *
	 * Opening one means constructing an `Input` and reading the container's
	 * header, which is asynchronous — so without this, every caller that asked
	 * during that window opened another. Adjusting a clip during playback
	 * notifies per frame and each notification both tears the sinks down and
	 * starts playback again, which asks twice: 30 frames opened 62 inputs and
	 * tracked one. The other 61 stayed open on the file with nothing left
	 * holding them, and on an hour-long recording that is what ran the audio
	 * out of handles and memory until the app was restarted.
	 */
	private sinkPromises = new Map<string, Promise<NativeAudioStream | null>>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<NativeAudioWindow, void, unknown>
	>();
	/**
	 * Sources whose packets WebCodecs turned out to refuse. Streaming is the
	 * cheaper path, so it is tried first, but whether a decoder will actually
	 * accept a codec can only be learned by feeding it one — see
	 * {@link decodeAudioBufferFromRef}. A source that failed once is played from a
	 * decoded buffer instead, and stays that way: this is a fact about the file,
	 * not about the edit, so it survives a timeline change.
	 */
	private unstreamableSources = new Set<string>();
	/**
	 * Bumped whenever the readers are stopped, which happens on every timeline
	 * notification. An iterator started before the bump has had its position
	 * pulled out from under it, so the error it raises says nothing about the
	 * file — see {@link runClipIterator}.
	 */
	private sinkGeneration = 0;
	/**
	 * Bumped only when the streams themselves are released, which is rarer than
	 * a reader being stopped. An open that lands after one of these has nothing
	 * left to belong to and releases its own staged PCM — see
	 * {@link openAudioSink}.
	 */
	private sinkReleaseGeneration = 0;
	/** Every stream this manager has opened and released, for the self-check. */
	private inputsOpened = 0;
	private inputsDisposed = 0;
	private queuedSources = new Set<AudioBufferSourceNode>();
	private preparedClipBuffers = new Map<
		string,
		Promise<RenderedClipAudio | null>
	>();
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

	/**
	 * What the manager currently believes, for the desktop self-check.
	 *
	 * `unstreamableSources` is the one that matters: it is permanent for the
	 * session and demotes a source to being decoded whole, so a count above zero
	 * for a file that streams perfectly well is the bug this exists to catch.
	 */
	getDiagnostics(): {
		unstreamableSources: number;
		openInputs: number;
		activeClips: number;
		sinkGeneration: number;
		inputsOpened: number;
		inputsDisposed: number;
	} {
		return {
			unstreamableSources: this.unstreamableSources.size,
			openInputs: this.sinks.size,
			activeClips: this.activeClipIds.size,
			sinkGeneration: this.sinkGeneration,
			inputsOpened: this.inputsOpened,
			inputsDisposed: this.inputsDisposed,
		};
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.releaseSinks();
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
		void this.stopReaders();

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

	/**
	 * Follows the master volume, over a ramp rather than in a step. A slider
	 * being dragged emits a change per frame, and a gain that jumps between them
	 * puts a step into the waveform at each one — a burst of clicks for as long
	 * as the drag lasts. The ramp is short enough to feel immediate.
	 */
	private updateGain(): void {
		if (!this.masterGain || !this.audioContext) return;

		const gain = this.masterGain.gain;
		const now = this.audioContext.currentTime;
		gain.cancelScheduledValues(now);
		gain.setValueAtTime(gain.value, now);
		gain.linearRampToValueAtTime(this.lastVolume, now + VOLUME_RAMP_SECONDS);
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
		// Claimed up front and checked after every await. Adjusting a clip during
		// playback notifies per frame and each notification starts one of these,
		// so several run at once; without the check the loser still reached the
		// bottom and installed a second interval over the winner's handle, which
		// then ticked unowned for the rest of the session.
		const sessionId = ++this.playbackSessionId;
		const isSuperseded = () => sessionId !== this.playbackSessionId;
		this.playbackLatencyCompensationSeconds = 0;

		const tracks = this.editor.scenes.getActiveScene().tracks;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			await audioContext.resume();
			if (isSuperseded()) return;
		}

		const clips = await collectAudioClips({ tracks, mediaAssets });
		if (isSuperseded()) return;
		this.clips = clips;
		this.evictUnusedSinks({ clips });
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
			if (this.shouldUsePreparedClipBuffer({ clip })) {
				// Fire and forget: the result is cached, so whoever schedules the clip
				// picks up this same render rather than starting another.
				void this.getPreparedClipBuffer({ clip });
				continue;
			}

			// A streaming clip has to fetch its audio track on the first call to
			// `getAudioSink`, and that fetch can outrun the lookahead window: the
			// sink returns after the playhead has crossed the clip, and
			// `streamClipChunks` short-circuits with `iteratorStartTime >=
			// clipEnd`. The clip stays in `activeClipIds` so the scheduler will
			// not retry it, and the rest of the session is silent. Kicking the
			// sink off here puts the fetch on the same footing as a prepared
			// buffer — cached by `sourceKey`, so the second clip on the same
			// source costs nothing.
			void this.getAudioSink({ clip });
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

	/**
	 * Plays a clip by streaming it, and takes the buffered path instead if the
	 * stream fails part-way.
	 *
	 * A decoder that cannot read the codec only says so once it has been handed a
	 * packet, which is well after `getAudioSink` succeeded, so the failure surfaces
	 * here as a rejected iterator rather than as a missing sink. Left uncaught it
	 * was an unhandled rejection that took the clip's audio with it, and because
	 * the clip stayed in `activeClipIds` the scheduler never tried it again — the
	 * clip was silent for the rest of the session, with nothing said about it.
	 */
	private async runClipIterator(args: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<void> {
		const sinkGeneration = this.sinkGeneration;
		try {
			await this.streamClipChunks(args);
		} catch (error) {
			const { clip, sessionId } = args;

			// Whether this says anything about the file depends on whether anyone
			// took the decoder away. A timeline change disposes every sink, and a
			// read in flight when that happens fails for that reason and no
			// other — recording it against the source would condemn a perfectly
			// streamable file to being decoded whole for the rest of the session.
			const wasCancelled =
				sinkGeneration !== this.sinkGeneration ||
				sessionId !== this.playbackSessionId ||
				!this.editor.playback.getIsPlaying();

			this.clipIterators.delete(clip.id);
			if (!wasCancelled) {
				console.warn(
					"Streaming clip audio failed, falling back to a decoded buffer:",
					error,
				);
				this.unstreamableSources.add(clip.sourceKey);
				const orphan = this.sinks.get(clip.sourceKey);
				if (orphan) {
					void orphan.close();
					this.inputsDisposed += 1;
				}
				this.sinks.delete(clip.sourceKey);
			}

			if (wasCancelled) return;

			// The clip keeps its place in `activeClipIds`, so the scheduling pass
			// cannot start a second copy of it while this decode is in flight.
			await this.schedulePreparedClip({
				clip,
				startTime: this.getPlaybackTime(),
				sessionId,
			});
		}
	}

	private async streamClipChunks({
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
		const preRollSeconds = this.getCrossfadePreRoll({ clip });
		const iteratorStartTime = Math.max(
			startTime,
			clipStart - preRollSeconds,
			playbackTimeAfterSinkReady,
		);
		if (iteratorStartTime >= clipEnd) {
			return;
		}
		const sourceStartTime = Math.max(
			0,
			clip.trimStart +
				getSourceTimeAtClipTime({
					clipTime: iteratorStartTime - clip.startTime,
					clipDuration: clip.duration,
					retime: clip.retime,
				}),
		);

		const iterator = sink.buffers(sourceStartTime);
		this.clipIterators.set(clip.id, iterator);

		const sampleRate = audioContext.sampleRate;
		const resyncToleranceFrames =
			CURSOR_RESYNC_TOLERANCE_SECONDS * sampleRate;
		const playbackRate = clip.retime
			? clampRetimeRate({ rate: clip.retime.rate })
			: 1;
		let resampler: StreamResampler | null = null;
		let cursorFrame: number | null = null;
		let isFirstScheduledChunk = true;
		let consecutiveDroppedBufferCount = 0;

		for await (const { buffer, timestamp } of iterator) {
			if (!this.editor.playback.getIsPlaying()) return;
			if (sessionId !== this.playbackSessionId) return;
			if (buffer.length === 0) continue;

			const timelineTime =
				clip.startTime +
				getClipTimeAtSourceTime({
					sourceTime: timestamp - clip.trimStart,
					clipDuration: clip.duration,
					retime: clip.retime,
				});
			if (timelineTime >= clipEnd) break;

			resampler ??= new StreamResampler({
				sourceSampleRate: buffer.sampleRate,
				targetSampleRate: sampleRate,
				channelCount: Math.min(PLAYBACK_CHANNELS, buffer.numberOfChannels),
				rate: playbackRate,
			});
			const chunk = this.toPlaybackChunk({
				audioContext,
				resampler,
				buffer,
			});
			if (!chunk) continue;

			const base =
				this.playbackStartContextTime +
				this.playbackLatencyCompensationSeconds;
			const clipEndTimestamp = base + (clipEnd - this.playbackStartTime);
			const fade = buildClipFadeWindows({
				clipStartTimestamp: base + (clipStart - this.playbackStartTime),
				clipEndTimestamp,
				preRollSeconds,
			});

			// Packets are scheduled where the last one ended rather than at each
			// one's own rounding of its own timestamp: rounded independently they
			// land a fraction of a sample apart, and every such boundary is a
			// dropped or a doubled sample. The cursor only follows a packet's own
			// timing when that timing says the audio belongs somewhere else — a gap
			// in the stream, or the latency compensation moving under it.
			const packetFrame = Math.round(
				(base + (timelineTime - this.playbackStartTime)) * sampleRate,
			);
			if (
				cursorFrame === null ||
				Math.abs(cursorFrame - packetFrame) > resyncToleranceFrames
			) {
				cursorFrame = packetFrame;
			}
			const startFrame = cursorFrame;
			cursorFrame += chunk.frameCount;

			const chunkStartTimestamp = startFrame / sampleRate;
			const chunkDuration = chunk.frameCount / sampleRate;
			// Two reasons a packet cannot play from its front: it reaches further
			// back than the crossfade window does, or it is already due. Both are
			// skipped into rather than moved, so the rest of it still lands where
			// it belongs.
			const lateSeconds = audioContext.currentTime - chunkStartTimestamp;
			const skipSeconds = Math.max(
				0,
				Math.max(audioContext.currentTime, fade.inStart) - chunkStartTimestamp,
			);

			if (skipSeconds >= chunkDuration) {
				if (lateSeconds >= chunkDuration) {
					consecutiveDroppedBufferCount += 1;
					if (
						consecutiveDroppedBufferCount >= MAX_CONSECUTIVE_DROPPED_BUFFERS
					) {
						this.resyncClipPlayback({ clip, sessionId, lateSeconds });
						return;
					}
				}
				continue;
			}

			const skipFrames = Math.ceil(skipSeconds * sampleRate);
			const actualStartTimestamp = (startFrame + skipFrames) / sampleRate;

			const node = audioContext.createBufferSource();
			node.buffer = chunk.buffer;
			const clipGain = audioContext.createGain();
			node.connect(clipGain);
			clipGain.connect(this.masterGain ?? audioContext.destination);

			this.scheduleBoundaryFade({
				gain: clipGain.gain,
				startTimestamp: actualStartTimestamp,
				endTimestamp: (startFrame + chunk.frameCount) / sampleRate,
				fade,
				scale: clip.volume,
				declick: isFirstScheduledChunk,
			});

			node.start(actualStartTimestamp, skipFrames / sampleRate);
			// A packet does not end where the clip does, so the last one plays on
			// past the cut and sums with whatever is under it. Stopping the node on
			// the clip's edge is what makes the edit point exact; the fade above has
			// already brought it to silence by then.
			node.stop(clipEndTimestamp);
			isFirstScheduledChunk = false;
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

		const prepared = await this.getPreparedClipBuffer({ clip });
		if (!prepared) {
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
		const preRollSeconds = prepared.preRollSeconds;
		const playbackTimeAfterReady = this.getPlaybackTime();
		const effectiveStartTime = Math.max(
			startTime,
			clipStart - preRollSeconds,
			playbackTimeAfterReady,
		);
		if (effectiveStartTime >= clipEnd) {
			return;
		}

		// The clip's own volume and the fade across its edges are two different
		// things happening to the same audio, so they get a node each: one that
		// follows the volume keyframes and one that only ever carries the
		// crossfade. Multiplied together they are the envelope, and neither has to
		// know what the other is doing.
		const node = audioContext.createBufferSource();
		node.buffer = prepared.buffer;
		const volumeGain = audioContext.createGain();
		const fadeGain = audioContext.createGain();
		node.connect(volumeGain);
		volumeGain.connect(fadeGain);
		fadeGain.connect(this.masterGain ?? audioContext.destination);

		const base =
			this.playbackStartContextTime + this.playbackLatencyCompensationSeconds;
		const clipStartTimestamp = base + (clipStart - this.playbackStartTime);
		const clipEndTimestamp = base + (clipEnd - this.playbackStartTime);
		const fade = buildClipFadeWindows({
			clipStartTimestamp,
			clipEndTimestamp,
			preRollSeconds,
		});

		const startTimestamp = Math.max(
			base + (effectiveStartTime - this.playbackStartTime),
			audioContext.currentTime,
		);
		// The rendered buffer opens with its pre-roll, so the clip's own first
		// frame sits `preRollSeconds` into it.
		const bufferOffset = Math.max(
			0,
			preRollSeconds + (startTimestamp - clipStartTimestamp),
		);
		if (bufferOffset >= prepared.buffer.duration) {
			return;
		}

		node.start(startTimestamp, bufferOffset);
		node.stop(clipEndTimestamp);

		this.scheduleBoundaryFade({
			gain: fadeGain.gain,
			startTimestamp,
			endTimestamp: clipEndTimestamp,
			fade,
			scale: 1,
			declick: true,
		});
		this.scheduleClipVolumeAutomation({
			clip,
			gain: volumeGain.gain,
			clipStartTimestamp,
			startTimestamp,
		});

		this.queuedSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			volumeGain.disconnect();
			fadeGain.disconnect();
			this.queuedSources.delete(node);
		});
	}

	/**
	 * Restarts a clip's stream after it has fallen behind, first widening the
	 * allowance for how long the output takes to reach the speakers. A machine
	 * whose audio device runs further ahead than the scheduler assumed drops
	 * every packet it produces until this allowance catches up with it.
	 */
	private resyncClipPlayback({
		clip,
		sessionId,
		lateSeconds,
	}: {
		clip: AudioClipSource;
		sessionId: number;
		lateSeconds: number;
	}): void {
		const nextCompensationSeconds = Math.max(
			this.playbackLatencyCompensationSeconds,
			Math.min(MAX_LATENCY_COMPENSATION_SECONDS, lateSeconds + 0.01),
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
	}

	/**
	 * A decoded packet, at the rate and speed it will be played back at.
	 *
	 * Returns null for a packet the resampler had no whole output frame to give
	 * for — the cursor keeps the leftover and hands it back with the next one.
	 */
	private toPlaybackChunk({
		audioContext,
		resampler,
		buffer,
	}: {
		audioContext: AudioContext;
		resampler: StreamResampler;
		buffer: AudioBuffer;
	}): { buffer: AudioBuffer; frameCount: number } | null {
		if (resampler.isPassthrough) {
			return { buffer, frameCount: buffer.length };
		}

		const channelCount = Math.min(PLAYBACK_CHANNELS, buffer.numberOfChannels);
		const frames = resampler.resample({
			channels: Array.from({ length: channelCount }, (_, channel) =>
				buffer.getChannelData(channel),
			),
			frameCount: buffer.length,
		});
		if (frames.frameCount === 0) return null;

		const resampled = audioContext.createBuffer(
			frames.channels.length,
			frames.frameCount,
			audioContext.sampleRate,
		);
		for (let channel = 0; channel < frames.channels.length; channel++) {
			resampled.copyToChannel(frames.channels[channel], channel);
		}

		return { buffer: resampled, frameCount: frames.frameCount };
	}

	/**
	 * How much material a clip has before its own start, up to the length of a
	 * crossfade. A clip trimmed into its source has some — the second half of a
	 * split always does — and playing it under a rising gain is what lets the
	 * outgoing clip's fade-out and this clip's fade-in cover the same window.
	 * A clip that starts on its source's first sample has none, and fades up
	 * from its own start instead.
	 */
	private getCrossfadePreRoll({ clip }: { clip: AudioClipSource }): number {
		const sourceTime =
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: -CROSSFADE_SECONDS,
				clipDuration: clip.duration,
				retime: clip.retime,
			});
		return sourceTime >= 0 ? CROSSFADE_SECONDS : 0;
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

	/**
	 * Stops every reader, and returns once they have all let go.
	 *
	 * This is what a timeline or media change needs: the clips have moved, so
	 * the positions the iterators hold are wrong, but the *sources* they read
	 * have not changed at all. Opening a stream means asking the shell to decode
	 * the whole track to disk — seconds for an hour-long recording — so the
	 * streams stay and only their readers are wound up. Adjusting a clip during
	 * playback fires a notification per frame; this used to release every stream
	 * on each one and decode them all again from nothing on the next.
	 *
	 * The generation bump is what tells a reader that fails on the way out that
	 * its position was taken from it rather than its file being unreadable —
	 * see {@link runClipIterator}. Without it, losing that race once demoted the
	 * source to being decoded whole for the rest of the session.
	 */
	private async stopReaders(): Promise<void> {
		this.sinkGeneration += 1;

		const iterators = [...this.clipIterators.values()];
		this.clipIterators.clear();
		this.activeClipIds.clear();

		await Promise.allSettled(iterators.map((iterator) => iterator.return()));
	}

	/**
	 * Stops the readers and then releases the streams under them.
	 *
	 * Ordering matters and used to be wrong: `return()`ing an iterator is
	 * asynchronous — it settles once the read it is blocked on does — so closing
	 * the streams on the next line deleted the staged PCM a reader was still
	 * inside a `fetch` over.
	 *
	 * Only for the streams genuinely being given up: the manager shutting down,
	 * or a source that has left the project.
	 */
	private releaseSinks({ sourceKeys }: { sourceKeys?: Set<string> } = {}): void {
		// Only a release of *everything* invalidates opens in flight. A named
		// release cannot have one: `getAudioSink` hands back the stream already
		// in `sinks` rather than opening a second, so a key that is in the map —
		// which is the only kind that can be named here — has nothing on the way.
		if (!sourceKeys) {
			this.sinkReleaseGeneration += 1;
			this.sinkPromises.clear();
		}

		const released = [...this.sinks].filter(
			([sourceKey]) => !sourceKeys || sourceKeys.has(sourceKey),
		);
		for (const [sourceKey] of released) {
			this.sinks.delete(sourceKey);
		}

		void this.stopReaders().then(async () => {
			for (const [, stream] of released) {
				await stream.close();
				this.inputsDisposed += 1;
			}
		});
	}

	/**
	 * Releases the streams for sources no clip on the timeline reads any more,
	 * down to {@link MAX_OPEN_AUDIO_SINKS}.
	 *
	 * Streams are kept across edits, so without this a session that imported and
	 * removed a hundred sources would hold a hundred whole decoded tracks on
	 * disk. A source still under a clip is never given up, however many there
	 * are: it is about to be read again, and re-decoding it is the cost this
	 * whole path exists to avoid.
	 */
	private evictUnusedSinks({ clips }: { clips: AudioClipSource[] }): void {
		const inUse = new Set(clips.map((clip) => clip.sourceKey));
		const idle = [...this.sinks.keys()].filter((key) => !inUse.has(key));

		const overCap = this.sinks.size - MAX_OPEN_AUDIO_SINKS;
		if (overCap <= 0) return;

		// Insertion order is open order, so the front of `idle` is the
		// longest-unused stream.
		const evicted = new Set(idle.slice(0, overCap));
		if (evicted.size > 0) this.releaseSinks({ sourceKeys: evicted });
	}

	/**
	 * Whether a clip has to be rendered up front instead of streamed. Streaming
	 * plays decoded chunks through a buffer source, which can only hold one
	 * playback rate, so a speed curve — like animated volume or pitch
	 * preservation — needs the whole clip laid out in advance. A source that
	 * WebCodecs turned out not to decode needs it too, since the fallback decoder
	 * only works on the whole file.
	 */
	private shouldUsePreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): boolean {
		return (
			this.unstreamableSources.has(clip.sourceKey) ||
			hasRetimeCurve({ retime: clip.retime }) ||
			hasAnimatedVolume({ element: clip.timelineElement }) ||
			shouldMaintainPitch({
				rate: clip.retime?.rate ?? 1,
				maintainPitch: clip.retime?.maintainPitch,
			})
		);
	}

	/**
	 * Writes a clip's boundary fade onto one chunk of it.
	 *
	 * The fade belongs to the clip, not to the chunk, so what is scheduled here
	 * is whatever part of the clip's envelope this chunk happens to cover — a
	 * chunk in the middle of a clip carries a flat gain, and only the chunks that
	 * reach an edge carry a ramp. A ramp interpolates from the previous event, so
	 * scheduling the fade-out on a chunk that never reaches it would slope that
	 * whole chunk down towards silence instead.
	 */
	private scheduleBoundaryFade({
		gain,
		startTimestamp,
		endTimestamp,
		fade,
		scale,
		declick,
	}: {
		gain: AudioParam;
		startTimestamp: number;
		endTimestamp: number;
		fade: ClipFadeWindows;
		scale: number;
		declick: boolean;
	}): void {
		// AudioParam scheduling rejects negative times, and a chunk can be due
		// before the audio context has advanced from zero. Clamp here as a safety
		// net so a miss elsewhere cannot poison playback.
		const start = Math.max(0, startTimestamp);
		gain.cancelScheduledValues(start);

		let previousTime = start;
		const rampTo = ({ value, time }: { value: number; time: number }): void => {
			if (time <= previousTime) return;
			gain.linearRampToValueAtTime(value, time);
			previousTime = time;
		};
		const holdAt = ({ value, time }: { value: number; time: number }): void => {
			if (time <= previousTime) return;
			gain.setValueAtTime(value, time);
			previousTime = time;
		};

		// Audio starting anywhere but the clip's own edge starts on whatever
		// sample happens to be there, with no outgoing clip to cross from.
		const needsDeclick = declick && start > fade.inEnd;
		gain.setValueAtTime(
			needsDeclick ? 0 : envelopeFactorAt({ time: start, fade }) * scale,
			start,
		);
		if (needsDeclick) {
			const declickEnd = start + DECLICK_SECONDS;
			rampTo({
				value: envelopeFactorAt({ time: declickEnd, fade }) * scale,
				time: declickEnd,
			});
		}

		if (start < fade.inEnd) {
			rampTo({ value: scale, time: fade.inEnd });
		}

		if (endTimestamp > fade.outStart) {
			holdAt({ value: scale, time: fade.outStart });
			rampTo({ value: 0, time: fade.outEnd });
		}
	}

	/**
	 * Writes the clip's own volume — a level, or the curve its keyframes draw —
	 * onto a gain of its own, leaving the fade across the clip's edges to
	 * {@link scheduleBoundaryFade}. The keyframes are anchored to the clip's
	 * start rather than to wherever the node was started, so a clip entered part
	 * way through, or one playing its pre-roll, still hears its automation where
	 * it was drawn.
	 */
	private scheduleClipVolumeAutomation({
		clip,
		gain,
		clipStartTimestamp,
		startTimestamp,
	}: {
		clip: AudioClipSource;
		gain: AudioParam;
		clipStartTimestamp: number;
		startTimestamp: number;
	}): void {
		const start = Math.max(0, startTimestamp);
		gain.cancelScheduledValues(start);

		if (!hasAnimatedVolume({ element: clip.timelineElement })) {
			gain.setValueAtTime(clip.volume, start);
			return;
		}

		const points = buildAudioGainAutomation({
			element: clip.timelineElement,
			fromLocalTime: Math.max(0, start - clipStartTimestamp),
			toLocalTime: clip.duration,
		});

		if (points.length === 0) {
			gain.setValueAtTime(clip.volume, start);
			return;
		}

		gain.setValueAtTime(points[0].gain, start);
		for (let index = 1; index < points.length; index++) {
			const point = points[index];
			const pointTimestamp = clipStartTimestamp + point.localTime;
			if (pointTimestamp <= start) continue;

			gain.linearRampToValueAtTime(point.gain, pointTimestamp);
		}
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
	}): Promise<RenderedClipAudio | null> {
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
				preRoll: this.getCrossfadePreRoll({ clip }),
			});
		})().catch((error) => {
			// A rejection has to become a cached `null` rather than a cached
			// rejection: the entry is read again on every scheduling pass, and a
			// stored rejection would both go unhandled and keep the clip silent for
			// as long as the entry lived.
			console.warn("Failed to prepare clip audio:", error);
			return null;
		});

		const guarded = this.forgetIfEmpty({
			cache: this.preparedClipBuffers,
			key: cacheKey,
			promise,
		});
		rememberInCache({
			cache: this.preparedClipBuffers,
			key: cacheKey,
			value: guarded,
			limit: MAX_CACHED_PREPARED_CLIPS,
		});
		return guarded;
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
		const guarded = this.forgetIfEmpty({
			cache: this.decodedBuffers,
			key: clip.sourceKey,
			promise,
		});
		rememberInCache({
			cache: this.decodedBuffers,
			key: clip.sourceKey,
			value: guarded,
			limit: MAX_CACHED_DECODED_SOURCES,
		});
		return guarded;
	}

	/**
	 * Keeps a cached decode only if it produced something.
	 *
	 * These caches hold promises, so a decode that came back empty — or threw —
	 * is remembered exactly as firmly as one that worked, and every later ask
	 * gets the same nothing back. That is silence for the rest of the session
	 * for a clip whose cache key has not changed, which an adjustment does not
	 * change. A failure that is not kept costs a retry; a failure that is kept
	 * costs the clip.
	 */
	private forgetIfEmpty<TValue>({
		cache,
		key,
		promise,
	}: {
		cache: Map<string, Promise<TValue | null>>;
		key: string;
		promise: Promise<TValue | null>;
	}): Promise<TValue | null> {
		const guarded = promise.then(
			(value) => {
				if (value === null && cache.get(key) === guarded) cache.delete(key);
				return value;
			},
			(error: unknown) => {
				if (cache.get(key) === guarded) cache.delete(key);
				throw error;
			},
		);
		return guarded;
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

		return await decodeAudioBufferFromRef({
			ref: clip.source,
			sampleRate: audioContext.sampleRate,
			maxChannels: PLAYBACK_CHANNELS,
		});
	}

	private async getAudioSink({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<NativeAudioStream | null> {
		const existingSink = this.sinks.get(clip.sourceKey);
		if (existingSink) return existingSink;

		const pending = this.sinkPromises.get(clip.sourceKey);
		if (pending) return await pending;

		const promise = this.openAudioSink({
			clip,
			generation: this.sinkReleaseGeneration,
		});
		this.sinkPromises.set(clip.sourceKey, promise);
		try {
			return await promise;
		} finally {
			if (this.sinkPromises.get(clip.sourceKey) === promise) {
				this.sinkPromises.delete(clip.sourceKey);
			}
		}
	}

	private async openAudioSink({
		clip,
		generation,
	}: {
		clip: AudioClipSource;
		generation: number;
	}): Promise<NativeAudioStream | null> {
		try {
			const stream = await NativeAudioStream.open({
				ref: clip.source,
				createBuffer: createEmptyAudioBuffer,
			});
			this.inputsOpened += 1;

			// The streams were released while this one was opening, so nothing is
			// waiting for it any more and the release could not have covered
			// it — it was not in the map yet. Release it here or its staged PCM
			// stays on disk for the rest of the session.
			if (!stream || generation !== this.sinkReleaseGeneration) {
				await stream?.close();
				this.inputsDisposed += 1;
				return null;
			}

			this.sinks.set(clip.sourceKey, stream);
			return stream;
		} catch (error) {
			console.warn("Failed to initialize audio stream:", error);
			this.inputsDisposed += 1;
			return null;
		}
	}
}
