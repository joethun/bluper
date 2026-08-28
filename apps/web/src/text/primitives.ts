import type { TextCanvasContext, TextBlockMeasurement } from "@/text/layout";
import { clamp } from "@/utils/math";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "./background";
import {
	drawTextDecoration,
	getTextBackgroundRect,
	measureTextBlock,
	setCanvasLetterSpacing,
} from "./layout";
import {
	resolveTextLayout,
	type TextAlign,
	type TextDecoration,
	type TextFontStyle,
	type TextFontWeight,
	type TextResolvedLayout,
} from "@/wasm/text-layout";

export interface TextLayoutParams {
	content: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
}

export interface MeasuredTextLayout extends TextResolvedLayout {
	lines: string[];
	lineMetrics: TextMetrics[];
	block: TextBlockMeasurement;
}

export interface ResolvedTextBackgroundLike {
	enabled: boolean;
	color: string;
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

/**
 * Cache for `measureTextLayout`. `ctx.measureText()` is one of the few places
 * in the render path that hits a real per-call CPU cost on the main thread
 * (font shaping + metric walk), and the function is called by both the
 * per-frame text-element resolver and per-frame text-mask compositing —
 * identical inputs across frames would otherwise re-measure on every export
 * frame.
 *
 * Bounded, because the key is built from *resolved* values and so is not a
 * fixed-size corpus: every keystroke while editing a caption mints a new key,
 * and a keyframed `fontSize` mints one per distinct playhead time. Each entry
 * retains a `TextMetrics` per line, so an unbounded map would grow without
 * limit across a session. Insertion-ordered eviction — the oldest key goes
 * first, which for scrubbing and typing is also the least likely to recur.
 */
const MEASURE_TEXT_LAYOUT_CACHE_LIMIT = 512;
const measureTextLayoutCache = new Map<string, MeasuredTextLayout>();

export function measureTextLayout({
	text,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextCanvasContext;
}): MeasuredTextLayout {
	const cacheKey = [
		text.content,
		text.fontSize,
		text.fontFamily,
		text.fontWeight,
		text.fontStyle,
		text.textAlign,
		text.textDecoration ?? "none",
		text.letterSpacing,
		text.lineHeight,
		canvasHeight,
	].join("\u0000");
	const cached = measureTextLayoutCache.get(cacheKey);
	if (cached) return cached;

	const resolvedLayout = resolveTextLayout({
		// `content` is deliberately not in the Rust payload: resolution never
		// reads it, and a caption changes on every keystroke.
		text: {
			fontSize: text.fontSize,
			fontFamily: text.fontFamily,
			fontWeight: text.fontWeight,
			fontStyle: text.fontStyle,
			textAlign: text.textAlign,
			textDecoration: text.textDecoration,
			letterSpacing: text.letterSpacing,
			lineHeight: text.lineHeight,
		},
		canvasHeight,
	});
	const lines = text.content.split("\n");

	ctx.save();
	ctx.font = resolvedLayout.fontString;
	ctx.textBaseline = "middle";
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: resolvedLayout.letterSpacing,
	});
	const lineMetrics = lines.map((line) => ctx.measureText(line));
	ctx.restore();

	const block = measureTextBlock({
		lineMetrics,
		lineHeightPx: resolvedLayout.lineHeightPx,
	});

	const result: MeasuredTextLayout = {
		...resolvedLayout,
		lines,
		lineMetrics,
		block,
	};
	if (measureTextLayoutCache.size >= MEASURE_TEXT_LAYOUT_CACHE_LIMIT) {
		const oldestKey = measureTextLayoutCache.keys().next().value;
		if (oldestKey !== undefined) measureTextLayoutCache.delete(oldestKey);
	}
	measureTextLayoutCache.set(cacheKey, result);
	return result;
}

export function drawMeasuredTextLayout({
	ctx,
	layout,
	textColor,
	background,
	backgroundColor,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	background?: ResolvedTextBackgroundLike | null;
	backgroundColor?: string;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.fillStyle = textColor;
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	if (
		background?.enabled &&
		backgroundColor &&
		backgroundColor !== "transparent" &&
		layout.lines.length > 0
	) {
		const backgroundRect = getTextBackgroundRect({
			textAlign: layout.textAlign,
			block: layout.block,
			background: {
				...background,
				color: backgroundColor,
			},
			fontSizeRatio: layout.fontSizeRatio,
		});
		if (backgroundRect) {
			const p =
				clamp({
					value: background.cornerRadius,
					min: CORNER_RADIUS_MIN,
					max: CORNER_RADIUS_MAX,
				}) / 100;
			const radius =
				(Math.min(backgroundRect.width, backgroundRect.height) / 2) * p;
			ctx.fillStyle = backgroundColor;
			ctx.beginPath();
			ctx.roundRect(
				backgroundRect.left,
				backgroundRect.top,
				backgroundRect.width,
				backgroundRect.height,
				radius,
			);
			ctx.fill();
			ctx.fillStyle = textColor;
		}
	}

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.fillText(layout.lines[index], 0, lineY);
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[index].width,
			lineY,
			metrics: layout.lineMetrics[index],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	}
}

export function strokeMeasuredTextLayout({
	ctx,
	layout,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	strokeColor: string;
	strokeWidth: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = strokeWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.strokeText(layout.lines[index], 0, lineY);
	}
}
