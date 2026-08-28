/**
 * A decoded frame with the time it belongs at.
 *
 * The editor used to pass mediabunny's `VideoSample` around, and this replaces
 * it with the small part of that surface anything here actually touched: when
 * the frame is, how big it is, a `VideoFrame` to draw, and a way to let it go.
 *
 * The frame is owned. A sample holds exactly one `VideoFrame` and closing the
 * sample closes it, which is what keeps a long scrub from filling memory with
 * frames nothing is drawing.
 *
 * ## Why `toVideoFrame` clones
 *
 * On WebKitGTK a `VideoFrame` that has been explicitly closed is not a
 * detached object that throws — it is freed memory, and drawing it is a
 * SIGSEGV that takes the whole webview down with no JavaScript error to catch.
 * Handing the same frame to two consumers means whichever finishes first
 * decides when the other one's pixels stop existing. So every caller gets its
 * own clone and closes it when it is done, and the sample's own frame outlives
 * all of them.
 */
export type SampleRotation = 0 | 90 | 180 | 270;

export class VideoSample {
	private frame: VideoFrame | null;
	/**
	 * The rotated picture, drawn on the first request and cloned from after
	 * that. A sample is shown for as many render passes as it is current for —
	 * two of them per frame of a 30fps source in a 60Hz preview, and more while
	 * the playhead is parked — and rotating means an `OffscreenCanvas`, a
	 * `drawImage` and a fresh `VideoFrame` every single time. The pixels cannot
	 * change between passes, so this is drawn once and lives as long as the
	 * sample does.
	 */
	private rotated: VideoFrame | null = null;
	/** Seconds on the source's own timeline. */
	readonly timestamp: number;
	/** Seconds. Rarely exact — a container may not say — but never zero. */
	readonly duration: number;
	/**
	 * What the container says to turn the picture by before showing it. A
	 * phone shot in portrait stores landscape pixels and a 90° rotation.
	 */
	readonly rotation: SampleRotation;

	constructor({
		frame,
		timestamp,
		duration,
		rotation = 0,
	}: {
		frame: VideoFrame;
		timestamp: number;
		duration: number;
		rotation?: SampleRotation;
	}) {
		this.frame = frame;
		this.timestamp = timestamp;
		this.duration = duration;
		this.rotation = rotation;
	}

	/** The width *after* rotation, which is what a viewer sees. */
	get displayWidth(): number {
		const quarterTurned = this.rotation === 90 || this.rotation === 270;
		const width = this.frame?.displayWidth ?? 0;
		const height = this.frame?.displayHeight ?? 0;
		return quarterTurned ? height : width;
	}

	get displayHeight(): number {
		const quarterTurned = this.rotation === 90 || this.rotation === 270;
		const width = this.frame?.displayWidth ?? 0;
		const height = this.frame?.displayHeight ?? 0;
		return quarterTurned ? width : height;
	}

	/**
	 * An independent frame the caller owns and must close, turned the right way
	 * up. See the note above on why this is never the sample's own frame.
	 *
	 * An unrotated source — nearly all of them — takes the cheap path: a clone
	 * costs a refcount, not a copy. A rotated one has to be drawn through a
	 * canvas, because a `VideoFrame` carries no rotation of its own and the
	 * compositor downstream would otherwise show the picture on its side. That
	 * drawing is done once per sample; see {@link rotated}.
	 */
	toVideoFrame(): VideoFrame {
		if (!this.frame) {
			throw new Error("This video sample has already been closed");
		}
		if (this.rotation === 0) return this.frame.clone();
		this.rotated ??= this.rotate({ frame: this.frame });
		return this.rotated.clone();
	}

	private rotate({ frame }: { frame: VideoFrame }): VideoFrame {
		const canvas = new OffscreenCanvas(
			this.displayWidth,
			this.displayHeight,
		);
		const context = canvas.getContext("2d");
		if (!context) {
			// Nothing useful to fall back to: an unrotated frame here would be
			// a sideways picture presented as if it were right.
			throw new Error("Could not open a 2D context to rotate a frame");
		}
		context.translate(canvas.width / 2, canvas.height / 2);
		context.rotate((this.rotation * Math.PI) / 180);
		context.drawImage(
			frame,
			-frame.displayWidth / 2,
			-frame.displayHeight / 2,
		);
		return new VideoFrame(canvas, {
			// Microseconds, which is what `VideoFrame` counts in — the
			// sample's own timestamp is in seconds.
			timestamp: Math.round(this.timestamp * 1e6),
			duration: Math.round(this.duration * 1e6),
		});
	}

	/**
	 * The same clone, for the `drawImage` family. Named for what the call site
	 * is doing rather than for what comes back, because `CanvasImageSource` is
	 * what `drawImage` accepts and a `VideoFrame` is one.
	 */
	toCanvasImageSource(): CanvasImageSource {
		return this.toVideoFrame();
	}

	/** Releases the frame. Idempotent. */
	close(): void {
		this.frame?.close();
		this.frame = null;
		this.rotated?.close();
		this.rotated = null;
	}
}
