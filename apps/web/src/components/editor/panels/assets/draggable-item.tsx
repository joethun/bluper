"use client";

import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import type { TimelineDragData } from "@/timeline/drag";
import { cn } from "@/utils/ui";
import type { MediaTime } from "@/wasm";

const TRANSPARENT_PIXEL =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";

let emptyDragImage: HTMLImageElement | undefined;

/**
 * The drag ghost is rendered in a portal that follows the cursor, so the browser
 * is handed a transparent pixel in place of its own. One image is shared by every
 * tile: a fresh one is still loading when `dragstart` fires, and `setDragImage`
 * quietly falls back to the default ghost in that case.
 */
function getEmptyDragImage() {
	if (typeof window === "undefined") return undefined;

	if (!emptyDragImage) {
		emptyDragImage = new window.Image();
		emptyDragImage.src = TRANSPARENT_PIXEL;
	}

	return emptyDragImage;
}

export interface DraggableItemProps {
	name: string;
	preview: ReactNode;
	/** Right-hand slot on the `compact` row — the duration, for a media asset. */
	trailing?: ReactNode;
	dragData: TimelineDragData;
	onDragStart?: ({ e }: { e: React.DragEvent }) => void;
	onAddToTimeline?: ({ currentTime }: { currentTime: MediaTime }) => void;
	aspectRatio?: number;
	className?: string;
	containerClassName?: string;
	/**
	 * Merged onto the `card` variant's thumbnail box, for a panel whose tiles are
	 * cut differently from the asset grid's.
	 */
	previewClassName?: string;
	shouldShowPlusOnDrag?: boolean;
	shouldShowLabel?: boolean;
	isRounded?: boolean;
	variant?: "card" | "compact";
	isDraggable?: boolean;
}

export function DraggableItem({
	name,
	preview,
	trailing,
	dragData,
	onDragStart,
	onAddToTimeline,
	aspectRatio = 16 / 9,
	className = "",
	containerClassName,
	previewClassName,
	shouldShowPlusOnDrag = true,
	shouldShowLabel = true,
	isRounded = true,
	variant = "card",
	isDraggable = true,
}: DraggableItemProps) {
	const [isDragging, setIsDragging] = useState(false);
	const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
	const dragRef = useRef<HTMLDivElement>(null);
	const editor = useEditor();

	const handleAddToTimeline = () => {
		onAddToTimeline?.({ currentTime: editor.playback.getCurrentTime() });
	};

	// Warm the placeholder before the first drag: `setDragImage` ignores an image
	// that is still decoding, which would let the native ghost through.
	useEffect(() => {
		getEmptyDragImage();
	}, []);

	useEffect(() => {
		if (!isDragging) return;

		const handleDragOver = (e: DragEvent) => {
			setDragPosition({ x: e.clientX, y: e.clientY });
		};

		document.addEventListener("dragover", handleDragOver);

		return () => {
			document.removeEventListener("dragover", handleDragOver);
		};
	}, [isDragging]);

	const handleDragStart = (event: React.DragEvent) => {
		const emptyImg = getEmptyDragImage();
		if (emptyImg) {
			event.dataTransfer.setDragImage(emptyImg, 0, 0);
		}

		editor.timeline.dragSource.begin({
			dataTransfer: event.dataTransfer,
			dragData,
		});

		setDragPosition({ x: event.clientX, y: event.clientY });
		setIsDragging(true);

		onDragStart?.({ e: event });
	};

	const handleDragEnd = () => {
		setIsDragging(false);
		editor.timeline.dragSource.end();
	};

	return (
		<>
			{variant === "card" ? (
				<div
					ref={dragRef}
					className={cn("group relative", containerClassName ?? "w-28")}
				>
					<div
						className={cn(
							"relative flex h-auto w-full cursor-default flex-col gap-1.5",
							className,
						)}
					>
						<AspectRatio
							ratio={aspectRatio}
							className={cn(
								"bg-accent relative overflow-hidden ring-1 ring-transparent transition-shadow group-hover:ring-border",
								isRounded && "rounded-sm",
								isDraggable && "[&::-webkit-drag-ghost]:opacity-0",
								previewClassName,
							)}
							draggable={isDraggable}
							onDragStart={isDraggable ? handleDragStart : undefined}
							onDragEnd={isDraggable ? handleDragEnd : undefined}
						>
							{preview}
							{!isDragging && (
								<PlusButton
									className="opacity-0 group-hover:opacity-100"
									onClick={handleAddToTimeline}
								/>
							)}
						</AspectRatio>
						{shouldShowLabel && (
							// Overflow is handled by `truncate` (CSS ellipsis) so the full
							// name stays in the DOM for screen readers and the tooltip.
							<span
								className="text-muted-foreground w-full truncate text-left text-xs"
								title={name}
							>
								{name}
							</span>
						)}
					</div>
				</div>
			) : (
				<div
					ref={dragRef}
					className={cn("group relative w-full", containerClassName)}
				>
					{/* The same lit-panel hover the icon buttons use, so a row in the
					    list answers the pointer instead of sitting inert until clicked. */}
					<button
						type="button"
						className={cn(
							"hover:bg-accent flex h-8 w-full cursor-default items-center gap-2.5 rounded-sm px-1.5 outline-none transition-colors duration-150",
							isDraggable && "[&::-webkit-drag-ghost]:opacity-0",
							className,
						)}
						draggable={isDraggable}
						onDragStart={isDraggable ? handleDragStart : undefined}
						onDragEnd={isDraggable ? handleDragEnd : undefined}
					>
						<div className="size-6 shrink-0 overflow-hidden rounded-sm">
							{preview}
						</div>
						<span className="min-w-0 flex-1 truncate text-left text-sm">
							{name}
						</span>
						{trailing ? (
							<span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
								{trailing}
							</span>
						) : null}
					</button>
				</div>
			)}

			{isDraggable &&
				isDragging &&
				typeof document !== "undefined" &&
				createPortal(
					// `panel` so the tokens below resolve against the panel palette: the
					// ghost is portalled to <body>, outside the panel it was dragged out
					// of, and `bg-background` there would be the app's darker ground.
					<div
						className="panel pointer-events-none fixed z-9999"
						style={{
							left: dragPosition.x - 40,
							top: dragPosition.y - 40,
						}}
					>
						<div className="w-[80px]">
							{/* An opaque ground of its own. Previews that are placeholders
							    rather than images — audio especially — painted nothing but
							    their icon, so the ghost dragged as a transparent square with
							    the timeline showing straight through it. */}
							<AspectRatio
								ratio={1}
								className="bg-background ring-primary relative overflow-hidden rounded-md shadow-2xl ring-3"
							>
								<div className="size-full [&_img]:size-full [&_img]:rounded-none [&_img]:object-cover">
									{preview}
								</div>
								{shouldShowPlusOnDrag && (
									<PlusButton
										onClick={handleAddToTimeline}
										tooltipText="Add to timeline or drag to position"
									/>
								)}
							</AspectRatio>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

function PlusButton({
	className,
	onClick,
	tooltipText,
}: {
	className?: string;
	onClick?: () => void;
	tooltipText?: string;
}) {
	const button = (
		<Button
			size="icon"
			className={cn(
				"bg-background hover:bg-background text-foreground absolute right-2 bottom-2 size-5",
				className,
			)}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick?.();
			}}
			title={tooltipText}
		>
			<PlusIcon />
		</Button>
	);

	if (tooltipText) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{button}</TooltipTrigger>
				<TooltipContent>
					<p>{tooltipText}</p>
				</TooltipContent>
			</Tooltip>
		);
	}

	return button;
}
