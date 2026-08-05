"use client";

import { useEffect, useRef, useState } from "react";
import { PipetteIcon } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { extractColorFromText } from "@/utils/color";
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
 * Picks a colour by taking one out of a picture, rather than by mixing one on a
 * hue/saturation gradient.
 *
 * This is the control a chroma key wants: the useful green is whatever green the
 * footage was shot against, so the gesture is "click that green". The frame is
 * sampled from the clip's own still rather than from the screen, which means the
 * pixels read are the untouched source ones, not ones the key has already partly
 * removed. A hex field sits alongside for pasting a known value, and is the whole
 * control for a layer that has no frame to sample.
 */
export function ColorSampler({
	value,
	onChange,
	onChangeEnd,
	label = "color",
	sampleImageUrl,
	className,
}: {
	/** A CSS hex colour, with the leading `#`. */
	value: string;
	onChange?: (color: string) => void;
	onChangeEnd?: (color: string) => void;
	/** Named in the sampling button's label, e.g. "key color". */
	label?: string;
	/** The still to sample from. Without one, only the hex field is offered. */
	sampleImageUrl?: string;
	className?: string;
}) {
	// `null` means the field is not being edited, so it mirrors the committed
	// value. Holding the draft only while focused is what lets a sampled colour
	// show up in the field without an effect to sync it.
	const [draft, setDraft] = useState<string | null>(null);
	const [isSampling, setIsSampling] = useState(false);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const text = (draft ?? value).replace(/^#/, "");
	const canSample = Boolean(sampleImageUrl);

	useEffect(() => {
		if (!isSampling || !sampleImageUrl) {
			return;
		}
		let isCurrent = true;
		const image = new Image();
		image.onload = () => {
			const canvas = canvasRef.current;
			if (!isCurrent || !canvas) return;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			if (!ctx) return;
			// Cover, so a portrait still is not squashed into the strip and the colours
			// read where they actually sit in the frame.
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
		image.src = sampleImageUrl;
		return () => {
			isCurrent = false;
		};
	}, [isSampling, sampleImageUrl]);

	const commit = ({ color }: { color: string }) => {
		onChange?.(color);
		onChangeEnd?.(color);
	};

	const commitDraft = ({ raw }: { raw: string }) => {
		// Normalises anything typed or pasted (bare hex, `#abc`, `rgb(...)`, a colour
		// name) to a six-digit hex. Alpha is dropped: a key colour is a hue to match,
		// so a translucent one would mean nothing.
		const parsed = extractColorFromText({ text: raw });
		if (parsed) {
			commit({ color: `#${parsed.slice(0, 6)}` });
		}
		// Unparseable, so nothing is committed. Dropping the draft puts the value the
		// key is actually using back in the field.
	};

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
		// would silently key out the shadows.
		if (a === 0) return;
		commit({ color: toHex({ r, g, b }) });
		setIsSampling(false);
	};

	return (
		<div className={cn("flex flex-col gap-2", className)}>
			<div className="bg-accent flex h-7 items-center gap-2 rounded-md border pr-1 pl-[0.45rem]">
				<span
					className="size-4.5 shrink-0 rounded-sm border"
					style={{ backgroundColor: value }}
				/>
				<Input
					className="border-0! bg-transparent p-0 uppercase ring-0! ring-offset-0!"
					size="sm"
					containerClassName="w-full"
					aria-label={label}
					value={text}
					onFocus={() => setDraft(value)}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => {
						commitDraft({ raw: draft ?? value });
						setDraft(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.currentTarget.blur();
						}
					}}
				/>
				{canSample && (
					<Button
						variant={isSampling ? "secondary" : "ghost"}
						size="icon"
						className="size-5"
						aria-label={`Sample ${label} from the clip`}
						aria-pressed={isSampling}
						title={`Sample ${label} from the clip`}
						onClick={() => setIsSampling((wasSampling) => !wasSampling)}
					>
						<PipetteIcon />
					</Button>
				)}
			</div>

			{isSampling && canSample && (
				<div className="flex flex-col gap-1">
					<canvas
						ref={canvasRef}
						width={STRIP_WIDTH}
						height={STRIP_HEIGHT}
						aria-label={`Click to sample the ${label}`}
						className="w-full cursor-crosshair rounded-sm border"
						onClick={sampleAt}
					/>
					<p className="text-muted-foreground text-xs">
						Click the colour you want to key out.
					</p>
				</div>
			)}
		</div>
	);
}
