import { PitchShifter } from "soundtouchjs";
import {
	clampCurveRate,
	clampRetimeRate,
	shouldMaintainPitch,
} from "@/retime/rate";
import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime } from "./resolve";
import { hasRetimeCurve } from "./curve";

const RATE_EPSILON = 1e-6;

/** How often the stretcher is retuned while following a curve. */
const TEMPO_UPDATE_INTERVAL_SECONDS = 0.1;

/** Offline rendering can only be paused on a render quantum boundary. */
const RENDER_QUANTUM_FRAMES = 128;

/**
 * Cap on retunings for one clip, so a long clip does not queue thousands of
 * suspensions. Each window is fed the average speed over exactly that window,
 * so a coarser step softens where a speed change lands inside the window but
 * never lets the clip drift away from its own length.
 */
const MAX_TEMPO_UPDATES = 512;

/**
 * How long the pitch-preserved curve render is given, relative to the clip it is
 * rendering, before the plain resampler is used instead. Generous: it is there to
 * catch a render that has stopped making progress, not to police a slow machine.
 */
const PITCH_RENDER_DEADLINE_MULTIPLE = 4;
const MIN_PITCH_RENDER_DEADLINE_SECONDS = 5;

function withDeadline<T>({
	work,
	seconds,
}: {
	work: Promise<T>;
	seconds: number;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Render exceeded ${seconds}s`)),
				seconds * 1000,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function sampleLinear({
	channelData,
	position,
}: {
	channelData: Float32Array;
	position: number;
}): number {
	if (position <= 0) {
		return channelData[0] ?? 0;
	}
	const lower = Math.floor(position);
	const upper = Math.min(channelData.length - 1, lower + 1);
	if (lower >= channelData.length) {
		return 0;
	}
	const fraction = position - lower;
	return channelData[lower] * (1 - fraction) + channelData[upper] * fraction;
}

function buildResampledBuffer({
	audioContext,
	sourceBuffer,
	trimStart,
	clipDuration,
	targetSampleRate,
	retime,
}: {
	audioContext: BaseAudioContext;
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	targetSampleRate: number;
	retime?: RetimeConfig;
}): AudioBuffer {
	const outputLength = Math.max(1, Math.ceil(clipDuration * targetSampleRate));
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));
	const outputBuffer = audioContext.createBuffer(
		numChannels,
		outputLength,
		targetSampleRate,
	);

	for (let channel = 0; channel < numChannels; channel++) {
		const sourceData = sourceBuffer.getChannelData(
			Math.min(channel, sourceBuffer.numberOfChannels - 1),
		);
		const outputData = outputBuffer.getChannelData(channel);

		for (let i = 0; i < outputLength; i++) {
			const clipTime = i / targetSampleRate;
			const sourceTime =
				trimStart +
				getSourceTimeAtClipTime({ clipTime, clipDuration, retime });
			outputData[i] = sampleLinear({
				channelData: sourceData,
				position: sourceTime * sourceBuffer.sampleRate,
			});
		}
	}

	return outputBuffer;
}

/**
 * The stretch of source a clip plays, resampled to the output rate.
 * soundtouchjs reads raw channel data and ignores the buffer's own sample rate,
 * so it has to be handed audio already at the rate it will be played back at.
 */
async function buildSourceSpanBuffer({
	sourceBuffer,
	trimStart,
	sourceDuration,
	targetSampleRate,
}: {
	sourceBuffer: AudioBuffer;
	trimStart: number;
	sourceDuration: number;
	targetSampleRate: number;
}): Promise<AudioBuffer> {
	const nativeSampleRate = sourceBuffer.sampleRate;
	const startSample = Math.max(0, Math.floor(trimStart * nativeSampleRate));
	const numSourceSamples = Math.max(
		1,
		Math.ceil(sourceDuration * nativeSampleRate),
	);
	const available = Math.max(0, sourceBuffer.length - startSample);
	const actualSamples = Math.max(1, Math.min(numSourceSamples, available));
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));

	const resampledLength = Math.max(
		1,
		Math.ceil(sourceDuration * targetSampleRate),
	);
	const resampleCtx = new OfflineAudioContext(
		numChannels,
		resampledLength,
		targetSampleRate,
	);
	const nativeBuffer = resampleCtx.createBuffer(
		numChannels,
		actualSamples,
		nativeSampleRate,
	);

	for (let ch = 0; ch < numChannels; ch++) {
		const src = sourceBuffer.getChannelData(
			Math.min(ch, sourceBuffer.numberOfChannels - 1),
		);
		nativeBuffer.copyToChannel(
			src.subarray(startSample, startSample + actualSamples),
			ch,
		);
	}

	const resampleSourceNode = resampleCtx.createBufferSource();
	resampleSourceNode.buffer = nativeBuffer;
	resampleSourceNode.connect(resampleCtx.destination);
	resampleSourceNode.start(0);
	return resampleCtx.startRendering();
}

async function buildPitchPreservedBuffer({
	sourceBuffer,
	trimStart,
	clipDuration,
	rate,
	targetSampleRate,
}: {
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	rate: number;
	targetSampleRate: number;
}): Promise<AudioBuffer> {
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));
	const resampledBuffer = await buildSourceSpanBuffer({
		sourceBuffer,
		trimStart,
		sourceDuration: clipDuration * rate,
		targetSampleRate,
	});

	const outputSamples = Math.max(
		1,
		Math.ceil(clipDuration * targetSampleRate),
	);
	const stretchCtx = new OfflineAudioContext(
		numChannels,
		outputSamples,
		targetSampleRate,
	);
	const shifter = new PitchShifter(stretchCtx, resampledBuffer, 4096);
	shifter.tempo = rate;
	shifter.pitch = 1;
	shifter.connect(stretchCtx.destination);
	return stretchCtx.startRendering();
}

/**
 * Pitch-preserved audio for a clip whose speed changes as it plays.
 *
 * Offline rendering is paused on a render quantum boundary every so often and
 * the stretcher retuned before it resumes, so one continuous stretch follows the
 * curve — no segments to cross-fade and no phase seams where the speed changes.
 *
 * Each window is given the average speed over exactly that window, taken from
 * the curve's own time mapping, so the source it consumes is right to the sample
 * and the error cannot pile up: a clip still ends where the curve says it ends.
 */
async function buildPitchPreservedCurveBuffer({
	sourceBuffer,
	trimStart,
	clipDuration,
	retime,
	targetSampleRate,
}: {
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	retime: RetimeConfig;
	targetSampleRate: number;
}): Promise<AudioBuffer> {
	const numChannels = Math.max(1, Math.min(2, sourceBuffer.numberOfChannels));
	const sourceAt = (clipTime: number) =>
		getSourceTimeAtClipTime({
			clipTime: Math.min(clipDuration, Math.max(0, clipTime)),
			clipDuration,
			retime,
		});

	const resampledBuffer = await buildSourceSpanBuffer({
		sourceBuffer,
		trimStart,
		sourceDuration: sourceAt(clipDuration),
		targetSampleRate,
	});

	const outputSamples = Math.max(
		1,
		Math.ceil(clipDuration * targetSampleRate),
	);
	const stretchCtx = new OfflineAudioContext(
		numChannels,
		outputSamples,
		targetSampleRate,
	);

	const quantumSeconds = RENDER_QUANTUM_FRAMES / targetSampleRate;
	const quantaPerWindow = Math.max(
		1,
		Math.round(TEMPO_UPDATE_INTERVAL_SECONDS / quantumSeconds),
	);
	const windowCount = Math.min(
		MAX_TEMPO_UPDATES,
		Math.max(1, Math.floor(clipDuration / (quantaPerWindow * quantumSeconds))),
	);
	const windowSeconds = clipDuration / windowCount;
	const averageRateOverWindow = ({ index }: { index: number }) => {
		const from = index * windowSeconds;
		const to = Math.min(clipDuration, from + windowSeconds);
		const span = to - from;
		return span > 0
			? clampCurveRate({ rate: (sourceAt(to) - sourceAt(from)) / span })
			: clampCurveRate({ rate: 1 });
	};

	const shifter = new PitchShifter(stretchCtx, resampledBuffer, 4096);
	shifter.tempo = averageRateOverWindow({ index: 0 });
	shifter.pitch = 1;
	shifter.connect(stretchCtx.destination);

	for (let index = 1; index < windowCount; index++) {
		// Suspension times must land on a quantum boundary, so they are counted in
		// quanta rather than derived from the window length.
		const suspendQuantum = Math.round((index * windowSeconds) / quantumSeconds);
		void stretchCtx
			.suspend(suspendQuantum * quantumSeconds)
			.then(() => {
				shifter.tempo = averageRateOverWindow({ index });
				return stretchCtx.resume();
			})
			// A suspension that cannot be honoured just leaves the previous window's
			// speed running a little longer; failing to resume would stall the
			// render, so nothing here is allowed to reject.
			.catch(() => stretchCtx.resume().catch(() => undefined));
	}

	return stretchCtx.startRendering();
}

export async function renderRetimedBuffer({
	audioContext,
	sourceBuffer,
	trimStart,
	clipDuration,
	retime,
	maintainPitch = false,
}: {
	audioContext: BaseAudioContext;
	sourceBuffer: AudioBuffer;
	trimStart: number;
	clipDuration: number;
	retime?: RetimeConfig;
	maintainPitch?: boolean;
}): Promise<AudioBuffer> {
	const targetSampleRate = audioContext.sampleRate;
	const rate = clampRetimeRate({ rate: retime?.rate ?? 1 });

	if (retime && hasRetimeCurve({ retime }) && maintainPitch) {
		try {
			return await withDeadline({
				work: buildPitchPreservedCurveBuffer({
					sourceBuffer,
					trimStart,
					clipDuration,
					retime,
					targetSampleRate,
				}),
				seconds: Math.max(
					MIN_PITCH_RENDER_DEADLINE_SECONDS,
					clipDuration * PITCH_RENDER_DEADLINE_MULTIPLE,
				),
			});
		} catch (error) {
			// Retuning a stretcher mid-render means pausing and resuming the render
			// itself, which not every browser will do with a stretcher in the graph.
			// Whether it refused outright or simply never came back, the clip still
			// has to make a sound: fall through to plain resampling and let the pitch
			// move with the speed. Being audible beats being in tune.
			console.warn("Pitch-preserved speed curve unavailable:", error);
		}
	} else if (
		shouldMaintainPitch({ rate, maintainPitch }) &&
		Math.abs(rate - 1) > RATE_EPSILON
	) {
		return buildPitchPreservedBuffer({
			sourceBuffer,
			trimStart,
			clipDuration,
			rate,
			targetSampleRate,
		});
	}

	return buildResampledBuffer({
		audioContext,
		sourceBuffer,
		trimStart,
		clipDuration,
		targetSampleRate,
		retime,
	});
}
