"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/utils/ui";

const STRIP_WIDTH = 320;
const STRIP_HEIGHT = 200;

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
	const channel = (value: number) =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * A picture to click a colour out of.
 *
 * Shared by every colour control that offers an eyedropper, so the gesture is
 * the same wherever it appears: the still is drawn to a fixed-size canvas and
 * the pixel under the pointer is read straight back out of it. Reading from our
 * own canvas rather than from the screen means the value picked is the source
 * pixel, untouched by whatever the control being edited is already doing to the
 * picture.
 */
export function ColorSampleStrip({
	imageUrl,
	label,
	onSample,
	className,
}: {
	/** The still to draw. Anything an `Image` can load, including a data URL. */
	imageUrl: string;
	/** Names the surface for screen readers, e.g. "key color". */
	label: string;
	/** Called with a six-digit `#rrggbb` for the pixel that was clicked. */
	onSample: (color: string) => void;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		let isCurrent = true;
		const image = new Image();
		image.onload = () => {
			const canvas = canvasRef.current;
			if (!isCurrent || !canvas) return;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return;
			// Cover, so a portrait still is not squashed into the strip and the
			// colours read where they actually sit in the frame.
			const scale = Math.max(
				STRIP_WIDTH / image.naturalWidth,
				STRIP_HEIGHT / image.naturalHeight,
			);
			const width = image.naturalWidth * scale;
			const height = image.naturalHeight * scale;
			ctx.clearRect(0, 0, STRIP_WIDTH, STRIP_HEIGHT);
			ctx.drawImage(
				image,
				(STRIP_WIDTH - width) / 2,
				(STRIP_HEIGHT - height) / 2,
				width,
				height,
			);
		};
		image.src = imageUrl;
		return () => {
			isCurrent = false;
		};
	}, [imageUrl]);

	const sampleAt = (event: React.MouseEvent<HTMLCanvasElement>) => {
		const canvas = event.currentTarget;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		const rect = canvas.getBoundingClientRect();
		const x = Math.floor(((event.clientX - rect.left) / rect.width) * STRIP_WIDTH);
		const y = Math.floor(((event.clientY - rect.top) / rect.height) * STRIP_HEIGHT);
		const [r, g, b, a] = ctx.getImageData(
			Math.max(0, Math.min(STRIP_WIDTH - 1, x)),
			Math.max(0, Math.min(STRIP_HEIGHT - 1, y)),
			1,
			1,
		).data;
		// A transparent pixel means the still has not drawn yet; committing black
		// would silently pick a colour the user never clicked on.
		if (a === 0) return;
		onSample(toHex({ r, g, b }));
	};

	return (
		<canvas
			ref={canvasRef}
			width={STRIP_WIDTH}
			height={STRIP_HEIGHT}
			aria-label={`Click to sample the ${label}`}
			className={cn("w-full cursor-crosshair rounded-sm border", className)}
			onClick={sampleAt}
		/>
	);
}
