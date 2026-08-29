"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { buildDefaultParamValues } from "@/params/registry";
import { drawTransitionShape } from "@/transitions";
import type {
	TransitionDefinition,
	TransitionSideState,
} from "@/transitions/types";
import type { TransitionPreviewFrames } from "./preview-frames";

/**
 * Where the tile sits when nothing is pointing at it. Far enough in that the
 * seam is visibly doing whatever this transition does, but before the halfway
 * mark — a flash is at full white by then, and a white square says nothing.
 */
const RESTING_PROGRESS = 0.32;

/**
 * One pass, on hover, at a fixed length rather than the transition's own default
 * duration: half a second across 84 pixels is over before the eye has found it,
 * and a tile that ran at each transition's real speed would make Blur look like
 * a different kind of thing from Fade rather than a slower one.
 */
const PLAYBACK_MS = 900;

/** Blur is authored against a full-size frame, so it scales down with the tile. */
const BLUR_REFERENCE_WIDTH = 1920;

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Which of the two stand-in clips is being painted. */
type Tone = "outgoing" | "incoming";

interface Palette {
	ground: string;
	ink: string;
}

/**
 * A live thumbnail for one transition, driven by the transition's own `resolve`
 * rather than by a drawing of what it is supposed to look like. Two stills out
 * of the project's own footage are put through the frame the definition returns,
 * so a wipe's softness, a slide's easing and a spin's overshoot are the ones
 * that will land on the timeline, over the pictures they will land on.
 *
 * `frames` arrives after a decode and may never arrive at all — in the browser
 * build, or in a project with no video in it — so the tile paints two drawn
 * stand-ins until and unless it does.
 *
 * `isPlaying` runs it once, from the start of the window to the end, and leaves
 * it on the last frame. Looping it would put twenty tiles' worth of motion in
 * peripheral vision the moment the pointer crossed the panel.
 */
export function TransitionPreview({
	definition,
	frames,
	isPlaying,
}: {
	definition: TransitionDefinition;
	frames: TransitionPreviewFrames | null;
	isPlaying: boolean;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const surfaceRef = useRef<PreviewSurface | null>(null);
	// Read at paint time rather than closed over, so stills that land mid-pass
	// join the pass already running instead of restarting it.
	const framesRef = useRef<TransitionPreviewFrames | null>(frames);
	// A theme flip swaps the tokens the tile is painted from without React ever
	// re-rendering it, so the resting frame has to be told to repaint itself.
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const surface = createPreviewSurface({ canvas, framesRef });
		if (!surface) return;
		surfaceRef.current = surface;

		const redraw = () => {
			surface.measure();
			surface.draw({ definition, progress: RESTING_PROGRESS });
		};
		redraw();

		const observer = new ResizeObserver(redraw);
		observer.observe(canvas);

		return () => {
			observer.disconnect();
			surfaceRef.current = null;
		};
	}, [definition, resolvedTheme]);

	useEffect(() => {
		const surface = surfaceRef.current;
		if (!surface || !isPlaying) return;

		let frameId = 0;
		let startedAt: number | null = null;

		const step = (now: number) => {
			startedAt ??= now;
			const progress = Math.min(1, (now - startedAt) / PLAYBACK_MS);
			surface.draw({ definition, progress });
			// No re-arm at progress 1: the pass holds on its closing frame until the
			// pointer leaves, which is what makes it a preview rather than a loop.
			if (progress < 1) {
				frameId = requestAnimationFrame(step);
			}
		};

		frameId = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frameId);
	}, [definition, isPlaying]);

	// Owns the resting frame: it is what the tile shows before a pass, after one,
	// and the moment the stills finish decoding. Declared after the pass so that
	// on hover-out the cancel above has already happened.
	useEffect(() => {
		framesRef.current = frames;
		if (isPlaying) return;
		surfaceRef.current?.draw({ definition, progress: RESTING_PROGRESS });
	}, [definition, frames, isPlaying]);

	return (
		<canvas
			ref={canvasRef}
			// Decorative: the tile's name is already the accessible label of the
			// draggable it sits inside.
			aria-hidden
			className="size-full"
		/>
	);
}

interface PreviewSurface {
	measure: () => void;
	draw: (args: {
		definition: TransitionDefinition;
		progress: number;
	}) => void;
}

/**
 * The three surfaces a frame needs: the tile itself, a scratch layer each clip
 * is built on before it is composited down, and a mask the reveal shapes are
 * rasterised into.
 *
 * The mask cannot be drawn straight onto the scratch layer under
 * `destination-in`: an inverted iris paints a full rectangle and punches the
 * disc back out of it, which under that mode would erase the clip instead of
 * cutting it.
 */
function createPreviewSurface({
	canvas,
	framesRef,
}: {
	canvas: HTMLCanvasElement;
	framesRef: { current: TransitionPreviewFrames | null };
}): PreviewSurface | null {
	const context = canvas.getContext("2d");
	if (!context) return null;

	const layer = document.createElement("canvas");
	const layerContext = layer.getContext("2d");
	const mask = document.createElement("canvas");
	const maskContext = mask.getContext("2d");
	if (!layerContext || !maskContext) return null;

	let width = 0;
	let height = 0;
	let palette: Palette = { ground: "#111111", ink: "#eeeeee" };

	const measure = () => {
		const dpr = window.devicePixelRatio || 1;
		const rect = canvas.getBoundingClientRect();
		width = Math.max(1, Math.round(rect.width));
		height = Math.max(1, Math.round(rect.height));

		for (const surface of [canvas, layer, mask]) {
			surface.width = Math.round(width * dpr);
			surface.height = Math.round(height * dpr);
		}
		for (const ctx of [context, layerContext, maskContext]) {
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		palette = readPalette({ element: canvas });
	};

	const paintSide = ({
		side,
		tone,
	}: {
		side: TransitionSideState;
		tone: Tone;
	}) => {
		if (side.opacity <= 0.001) return;

		layerContext.save();
		layerContext.clearRect(0, 0, width, height);
		layerContext.translate(width / 2 + side.offsetX, height / 2 + side.offsetY);
		layerContext.rotate(side.rotateDegrees * DEGREES_TO_RADIANS);
		layerContext.scale(side.scale, side.scale);
		layerContext.translate(-width / 2, -height / 2);
		paintClip({
			ctx: layerContext,
			width,
			height,
			palette,
			tone,
			frames: framesRef.current,
		});
		layerContext.restore();

		if (side.shape) {
			maskContext.clearRect(0, 0, width, height);
			drawTransitionShape({ ctx: maskContext, shape: side.shape, width, height });
			layerContext.save();
			layerContext.globalCompositeOperation = "destination-in";
			layerContext.drawImage(mask, 0, 0, width, height);
			layerContext.restore();
		}

		context.save();
		context.globalAlpha = Math.min(1, Math.max(0, side.opacity));
		const blur = (side.blurSigma * width) / BLUR_REFERENCE_WIDTH;
		if (blur > 0.1) {
			context.filter = `blur(${blur.toFixed(2)}px)`;
		}
		context.drawImage(layer, 0, 0, width, height);
		context.restore();
	};

	const draw = ({
		definition,
		progress,
	}: {
		definition: TransitionDefinition;
		progress: number;
	}) => {
		context.clearRect(0, 0, width, height);

		const frame = definition.resolve({
			progress,
			params: buildDefaultParamValues({ params: definition.params }),
			width,
			height,
		});

		paintSide({ side: frame.outgoing, tone: "outgoing" });
		paintSide({ side: frame.incoming, tone: "incoming" });

		if (frame.overlay && frame.overlay.opacity > 0) {
			context.save();
			context.globalAlpha = Math.min(1, Math.max(0, frame.overlay.opacity));
			context.fillStyle = frame.overlay.color;
			context.fillRect(0, 0, width, height);
			context.restore();
		}
	};

	return { measure, draw };
}

/**
 * The panel's own tokens, so the tile sits in whichever theme is on rather than
 * carrying two hard-coded greys around with it.
 */
function readPalette({ element }: { element: HTMLElement }): Palette {
	const style = getComputedStyle(element);
	return {
		ground: style.getPropertyValue("--background").trim() || "#111111",
		ink: style.getPropertyValue("--foreground").trim() || "#eeeeee",
	};
}

/**
 * One of the two clips the transition runs between: a real still where the shell
 * could decode one, and a drawn stand-in where it could not.
 *
 * The ground is painted first either way. The sides composite over each other,
 * and a see-through clip would let a slide read as a cross-fade — it also fills
 * the letterbox when a landscape frame is fitted into a square tile.
 */
function paintClip({
	ctx,
	width,
	height,
	palette,
	tone,
	frames,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	palette: Palette;
	tone: Tone;
	frames: TransitionPreviewFrames | null;
}) {
	ctx.fillStyle = palette.ground;
	ctx.fillRect(0, 0, width, height);

	const still = tone === "outgoing" ? frames?.outgoing : frames?.incoming;
	if (still && drawCover({ ctx, image: still, width, height })) {
		return;
	}

	paintStandInClip({ ctx, width, height, palette, tone });
}

/** Fills the box with the image, cropping the overhang rather than squashing it. */
function drawCover({
	ctx,
	image,
	width,
	height,
}: {
	ctx: CanvasRenderingContext2D;
	image: HTMLImageElement;
	width: number;
	height: number;
}): boolean {
	const sourceWidth = image.naturalWidth;
	const sourceHeight = image.naturalHeight;
	if (sourceWidth <= 0 || sourceHeight <= 0) {
		return false;
	}

	const scale = Math.max(width / sourceWidth, height / sourceHeight);
	const drawWidth = sourceWidth * scale;
	const drawHeight = sourceHeight * scale;
	ctx.drawImage(
		image,
		(width - drawWidth) / 2,
		(height - drawHeight) / 2,
		drawWidth,
		drawHeight,
	);
	return true;
}

/**
 * The fallback picture, for a project the shell has no frames to give. The two
 * sides differ in brightness and in what is drawn on them: a wipe between two
 * flat tones reads the same in either direction, whereas a disc moving out from
 * under a pair of bars does not.
 */
function paintStandInClip({
	ctx,
	width,
	height,
	palette,
	tone,
}: {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	palette: Palette;
	tone: Tone;
}) {
	const isOutgoing = tone === "outgoing";
	const shortSide = Math.min(width, height);

	ctx.fillStyle = palette.ink;
	ctx.globalAlpha = isOutgoing ? 0.1 : 0.32;
	ctx.fillRect(0, 0, width, height);

	ctx.globalAlpha = isOutgoing ? 0.28 : 0.6;
	if (isOutgoing) {
		ctx.beginPath();
		ctx.arc(width * 0.34, height * 0.36, shortSide * 0.15, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillRect(0, height * 0.72, width, Math.max(1, shortSide * 0.055));
	} else {
		const barHeight = Math.max(1, shortSide * 0.075);
		ctx.fillRect(width * 0.18, height * 0.4, width * 0.64, barHeight);
		ctx.fillRect(width * 0.18, height * 0.58, width * 0.38, barHeight);
	}
	ctx.globalAlpha = 1;
}
