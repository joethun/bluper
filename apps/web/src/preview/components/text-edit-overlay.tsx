"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import type { TextElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import {
	getElementLocalTime,
} from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import { resolveTextLayout } from "@/wasm/text-layout";
import {
	buildTextBackgroundFromElement,
	buildTextLayoutParamsFromElement,
} from "@/text/measure-element";

export function TextEditOverlay({
	trackId,
	elementId,
	element,
	onCommit,
}: {
	trackId: string;
	elementId: string;
	element: TextElement;
	onCommit: () => void;
}) {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const divRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const div = divRef.current;
		if (!div) return;
		div.focus();
		const range = document.createRange();
		range.selectNodeContents(div);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}, []);

	useEffect(() => {
		// The edit lives in the shared preview overlay until it is committed, and
		// any other gesture that starts is entitled to discard that overlay — a
		// timeline resize does exactly that, and its handler also preventDefaults
		// the mousedown, so the field never blurs and never gets to bank the text
		// on its own. Capturing pointerdown gets us in ahead of all of it.
		const handlePointerDownOutside = (event: PointerEvent) => {
			const div = divRef.current;
			if (!div) return;
			if (event.target instanceof Node && div.contains(event.target)) return;
			onCommit();
		};

		document.addEventListener("pointerdown", handlePointerDownOutside, true);
		return () =>
			document.removeEventListener(
				"pointerdown",
				handlePointerDownOutside,
				true,
			);
	}, [onCommit]);

	const handleInput = useCallback(() => {
		const div = divRef.current;
		if (!div) return;
		const text = div.innerText;
		editor.timeline.previewElements({
			updates: [{ trackId, elementId, updates: { params: { content: text } } }],
		});
	}, [editor.timeline, trackId, elementId]);

	const handleKeyDown = useCallback(
		({ event }: { event: React.KeyboardEvent }) => {
			const { key } = event;
			if (key === "Escape") {
				event.preventDefault();
				onCommit();
				return;
			}
		},
		[onCommit],
	);

	const canvasSize = editor.project.getActive().settings.canvasSize;

	if (!canvasSize) return null;

	const currentTime = editor.playback.getCurrentTime();
	const localTime = getElementLocalTime({
		timelineTime: currentTime,
		elementStartTime: element.startTime,
		elementDuration: element.duration,
	});
	const transform = resolveTransformAtTime({
		baseTransform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		localTime,
	});

	const { x: posX, y: posY } = viewport.positionToOverlay({
		positionX: transform.position.x,
		positionY: transform.position.y,
	});

	const { x: displayScaleX } = viewport.getDisplayScale();
	const textParams = buildTextLayoutParamsFromElement({ element, localTime });
	const resolvedTextLayout = resolveTextLayout({
		text: textParams,
		canvasHeight: canvasSize.height,
	});

	const lineHeight = textParams.lineHeight ?? DEFAULTS.text.lineHeight;
	const canvasLetterSpacing = textParams.letterSpacing ?? 0;
	const lineHeightPx = resolvedTextLayout.lineHeightPx;

	const bg = buildTextBackgroundFromElement({ element });
	const shouldShowBackground =
		bg.enabled && bg.color && bg.color !== "transparent";
	const fontSizeRatio = resolvedTextLayout.fontSizeRatio;
	const canvasPaddingX = shouldShowBackground
		? (bg.paddingX ?? DEFAULTS.text.background.paddingX) * fontSizeRatio
		: 0;
	const canvasPaddingY = shouldShowBackground
		? (bg.paddingY ?? DEFAULTS.text.background.paddingY) * fontSizeRatio
		: 0;

	return (
		<div
			className="absolute"
			style={{
				left: posX,
				top: posY,
				transform: `translate(-50%, -50%) scale(${transform.scaleX * displayScaleX}, ${transform.scaleY * displayScaleX}) rotate(${transform.rotate}deg)`,
				transformOrigin: "center center",
			}}
		>
			<div
				ref={divRef}
				contentEditable
				suppressContentEditableWarning
				tabIndex={0}
				role="textbox"
				aria-label="Edit text"
				className="cursor-text select-text outline-none whitespace-pre"
				style={{
					fontSize: resolvedTextLayout.scaledFontSize,
					fontFamily: textParams.fontFamily,
					fontWeight: textParams.fontWeight === "bold" ? "bold" : "normal",
					fontStyle: textParams.fontStyle === "italic" ? "italic" : "normal",
					textAlign: textParams.textAlign,
					letterSpacing: `${canvasLetterSpacing}px`,
					lineHeight,
					color: "transparent",
					caretColor:
						typeof element.params.color === "string"
							? element.params.color
							: "#ffffff",
					backgroundColor: shouldShowBackground ? bg.color : "transparent",
					minHeight: lineHeightPx,
					textDecoration: textParams.textDecoration ?? "none",
					padding: shouldShowBackground
						? `${canvasPaddingY}px ${canvasPaddingX}px`
						: 0,
					minWidth: 1,
				}}
				onInput={handleInput}
				onBlur={onCommit}
				onKeyDown={(event) => handleKeyDown({ event })}
			>
				{textParams.content}
			</div>
		</div>
	);
}
