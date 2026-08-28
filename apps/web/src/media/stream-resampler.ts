/**
 * One continuous read cursor over a stream of decoded packets, resampling them
 * to the rate they are played back at.
 *
 * A decoded packet carries its source file's sample rate, which is not
 * necessarily the rate the output device runs at, and a clip may be playing at
 * a speed other than 1. Handing each packet to its own `AudioBufferSourceNode`
 * and letting the browser reconcile both resamples every packet in isolation:
 * a packet's length in output frames comes out fractional, so consecutive
 * packets land a fraction of a sample apart and every boundary between them
 * either drops a sample or plays one twice. At a packet every 20ms or so that
 * is tens of impulses a second — which is what crackling is.
 *
 * Reading through one cursor instead carries the fractional position, and the
 * previous packet's last frame, across the boundary: the interpolation runs
 * straight through it, and each packet comes out a whole number of output
 * frames that can be scheduled end to end.
 */
export interface ResampledFrames {
	channels: Float32Array<ArrayBuffer>[];
	frameCount: number;
}

export class StreamResampler {
	/** Source frames consumed per output frame. */
	private readonly step: number;
	private readonly sourceSampleRate: number;
	private readonly targetSampleRate: number;
	private readonly channelCount: number;
	/**
	 * Where the next output frame reads from, in the current packet's index
	 * space: `-1` is {@link tail}, `0` the packet's first frame. Always greater
	 * than -1, so one frame of history is all that is ever needed.
	 */
	private position = 0;
	/** Last frame of the previous packet, per channel. */
	private readonly tail: Float32Array;

	constructor({
		sourceSampleRate,
		targetSampleRate,
		channelCount,
		rate = 1,
	}: {
		sourceSampleRate: number;
		targetSampleRate: number;
		channelCount: number;
		rate?: number;
	}) {
		this.sourceSampleRate = sourceSampleRate;
		this.targetSampleRate = targetSampleRate;
		this.step = (sourceSampleRate / targetSampleRate) * rate;
		this.channelCount = Math.max(1, channelCount);
		this.tail = new Float32Array(this.channelCount);
	}

	/**
	 * Whether the source already arrives frame for frame at the playback rate, in
	 * which case a packet can be scheduled as it came rather than copied through
	 * an interpolation that would only ever return it unchanged.
	 */
	get isPassthrough(): boolean {
		return this.sourceSampleRate === this.targetSampleRate && this.step === 1;
	}

	resample({ channels, frameCount }: ResampledFrames): ResampledFrames {
		if (frameCount <= 0 || channels.length === 0) {
			return { channels: [], frameCount: 0 };
		}

		const lastIndex = frameCount - 1;
		const outputCount =
			this.position > lastIndex
				? 0
				: Math.floor((lastIndex - this.position) / this.step) + 1;

		const output = Array.from(
			{ length: this.channelCount },
			() => new Float32Array(outputCount),
		);

		for (let channel = 0; channel < this.channelCount; channel++) {
			const source = channels[Math.min(channel, channels.length - 1)];
			const target = output[channel];
			const tail = this.tail[channel];
			let position = this.position;

			for (let index = 0; index < outputCount; index++) {
				const lower = Math.floor(position);
				const fraction = position - lower;
				// `lower` only ever reaches -1, and only until the first packet has
				// been read; past the packet's end cannot happen, because the loop
				// stops before `position` passes its last frame.
				const before = lower < 0 ? tail : source[lower];
				const after = lower + 1 <= lastIndex ? source[lower + 1] : before;
				target[index] = before + (after - before) * fraction;
				position += this.step;
			}
		}

		for (let channel = 0; channel < this.channelCount; channel++) {
			const source = channels[Math.min(channel, channels.length - 1)];
			this.tail[channel] = source[lastIndex];
		}
		// The next packet's index space begins where this one ended, so the cursor
		// moves back by exactly the frames just consumed rather than being reset.
		this.position += outputCount * this.step - frameCount;

		return { channels: output, frameCount: outputCount };
	}
}
