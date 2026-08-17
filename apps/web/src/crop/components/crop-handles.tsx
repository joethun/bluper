"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { registerCanceller } from "@/editor/cancel-interaction";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { getUncroppedMediaBounds } from "@/preview/element-bounds";
import { getElementLocalTime } from "@/animation";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import type { TimelineElement } from "@/timeline";
import { readCropFromParams, setCropEdge, type CropInsets } from "@/crop";
import { useCropModeStore } from "@/crop/crop-mode-store";
import { cn } from "@/utils/ui";

/**
 * The eight grips round the kept region. Each names the source edges it moves,
 * before any mirroring: a corner moves one horizontal and one vertical edge, a
 * side moves only its own.
 */
const GRIPS: ReadonlyArray<{
	id: string;
	horizontal: "left" | "right" | null;
	vertical: "top" | "bottom" | null;
	cursor: string;
}> = [
	{ id: "top-left", horizontal: "left", vertical: "top", cursor: "nwse-resize" },
	{ id: "top", horizontal: null, vertical: "top", cursor: "ns-resize" },
	{ id: "top-right", horizontal: "right", vertical: "top", cursor: "nesw-resize" },
	{ id: "right", horizontal: "right", vertical: null, cursor: "ew-resize" },
	{
		id: "bottom-right",
		horizontal: "right",
		vertical: "bottom",
		cursor: "nwse-resize",
	},
	{ id: "bottom", horizontal: null, vertical: "bottom", cursor: "ns-resize" },
	{
		id: "bottom-left",
		horizontal: "left",
		vertical: "bottom",
		cursor: "nesw-resize",
	},
	{ id: "left", horizontal: "left", vertical: null, cursor: "ew-resize" },
];

interface DragSession {
	pointerId: number;
	startCanvasX: number;
	startCanvasY: number;
	startCrop: CropInsets;
	horizontal: "left" | "right" | null;
	vertical: "top" | "bottom" | null;
}

/**
 * Direct-manipulation cropping, in the manner of a slide editor: the clip is
 * drawn whole, the part being trimmed away is dimmed rather than removed, and
 * the eight grips push the kept region's edges around. Giving material back is
 * the same gesture as taking it, which is the reason the trimmed edges stay on
 * screen at all.
 */
export function CropHandles() {
	const croppingElement = useCropModeStore((s) => s.croppingElement);
	const exitCropMode = useCropModeStore((s) => s.exitCropMode);
	const committedElement = useEditor((e) =>
		croppingElement
			? (e.timeline
					.getTrackById({ trackId: croppingElement.trackId })
					?.elements.find(
						(candidate) => candidate.id === croppingElement.elementId,
					) ?? null)
			: null,
	);

	useEffect(() => {
		if (!croppingElement) return;
		return registerCanceller({ fn: () => exitCropMode() });
	}, [croppingElement, exitCropMode]);

	// A clip that has been deleted, hidden, or scrubbed away from is not on
	// screen to crop, and leaving the mode on would strand the grips over
	// whatever the playhead moved to.
	const isOnScreen = useEditor((e) => {
		if (!committedElement) return false;
		const time = e.playback.getCurrentTime();
		return (
			time >= committedElement.startTime &&
			time < committedElement.startTime + committedElement.duration
		);
	});

	useEffect(() => {
		if (croppingElement && !isOnScreen) {
			exitCropMode();
		}
	}, [croppingElement, isOnScreen, exitCropMode]);

	if (!croppingElement || !committedElement || !isOnScreen) return null;

	return (
		<CropSurface
			trackId={croppingElement.trackId}
			elementId={croppingElement.elementId}
			committedElement={committedElement}
		/>
	);
}

function CropSurface({
	trackId,
	elementId,
	committedElement,
}: {
	trackId: string;
	elementId: string;
	committedElement: TimelineElement;
}) {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	// Pointer capture keeps every move and the release on the grip that started
	// the drag, and React has re-rendered by the time the next move arrives, so
	// the session can live in state rather than in a ref.
	const [drag, setDrag] = useState<DragSession | null>(null);

	const mediaAssets = useEditor((e) => e.media.getAssets());
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());

	// The preview overlay carries the in-flight drag, so the dimmed region tracks
	// the pointer instead of snapping only once the drag is committed.
	const { renderElement, previewUpdates, commit } =
		useElementPreview<TimelineElement>({
			trackId,
			elementId,
			fallback: committedElement,
		});

	if (!canvasSize) return null;

	const element = renderElement;
	const mediaAsset =
		element.type === "video" || element.type === "image"
			? mediaAssets.find((asset) => asset.id === element.mediaId)
			: undefined;
	const geometry = getUncroppedMediaBounds({
		element,
		canvasSize,
		mediaAsset,
		localTime: getElementLocalTime({
			timelineTime: currentTime,
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
	if (!geometry) return null;

	const { bounds } = geometry;
	const crop = readCropFromParams({ params: element.params });
	const displayScale = viewport.getDisplayScale();
	const boxWidthCanvas = Math.abs(bounds.width);
	const boxHeightCanvas = Math.abs(bounds.height);
	const boxWidth = boxWidthCanvas * displayScale.x;
	const boxHeight = boxHeightCanvas * displayScale.y;
	const center = viewport.canvasToOverlay({
		canvasX: bounds.cx,
		canvasY: bounds.cy,
	});

	// The box is mirrored when the clip is, so the grip on the visual left is
	// sitting on the source's right edge and has to write that inset instead.
	const isMirroredX = bounds.width < 0;
	const isMirroredY = bounds.height < 0;
	const sourceHorizontal = ({ edge }: { edge: "left" | "right" }) =>
		isMirroredX ? (edge === "left" ? "right" : "left") : edge;
	const sourceVertical = ({ edge }: { edge: "top" | "bottom" }) =>
		isMirroredY ? (edge === "top" ? "bottom" : "top") : edge;

	// Percentages of the *box*, which is what the grips and the dimmed strips are
	// positioned with — the same numbers the insets already are.
	const visualLeft = isMirroredX ? crop.right : crop.left;
	const visualRight = isMirroredX ? crop.left : crop.right;
	const visualTop = isMirroredY ? crop.bottom : crop.top;
	const visualBottom = isMirroredY ? crop.top : crop.bottom;

	const applyDrag = ({
		session,
		clientX,
		clientY,
	}: {
		session: DragSession;
		clientX: number;
		clientY: number;
	}) => {
		const canvasPoint = viewport.screenToCanvas({ clientX, clientY });
		if (!canvasPoint) return;

		// Into the box's own axes, so a rotated clip crops along its own edges
		// rather than along the screen's.
		const rotationRadians = (bounds.rotation * Math.PI) / 180;
		const cos = Math.cos(rotationRadians);
		const sin = Math.sin(rotationRadians);
		const deltaX = canvasPoint.x - session.startCanvasX;
		const deltaY = canvasPoint.y - session.startCanvasY;
		const localDeltaX = deltaX * cos + deltaY * sin;
		const localDeltaY = -deltaX * sin + deltaY * cos;

		const fractionX = boxWidthCanvas > 0 ? localDeltaX / boxWidthCanvas : 0;
		const fractionY = boxHeightCanvas > 0 ? localDeltaY / boxHeightCanvas : 0;

		let next = session.startCrop;

		if (session.horizontal !== null) {
			// A grip on the visual left grows its inset as it moves right; one on
			// the visual right grows its inset as it moves left.
			const towardsCentre =
				session.horizontal === "left" ? fractionX : -fractionX;
			const edge = sourceHorizontal({ edge: session.horizontal });
			next = setCropEdge({
				crop: next,
				edge,
				value: session.startCrop[edge] + towardsCentre,
			});
		}
		if (session.vertical !== null) {
			const towardsCentre =
				session.vertical === "top" ? fractionY : -fractionY;
			const edge = sourceVertical({ edge: session.vertical });
			next = setCropEdge({
				crop: next,
				edge,
				value: session.startCrop[edge] + towardsCentre,
			});
		}

		previewUpdates({
			params: {
				"crop.left": next.left,
				"crop.right": next.right,
				"crop.top": next.top,
				"crop.bottom": next.bottom,
			},
		});
	};

	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden">
			<div
				className="absolute"
				style={{
					left: center.x - boxWidth / 2,
					top: center.y - boxHeight / 2,
					width: boxWidth,
					height: boxHeight,
					transform: `rotate(${bounds.rotation}deg)`,
				}}
			>
				{/* The trimmed-away edges, dimmed rather than hidden, so what is being
				    given up stays readable and can be dragged back. */}
				<Shade style={{ left: 0, right: 0, top: 0, height: `${visualTop * 100}%` }} />
				<Shade
					style={{ left: 0, right: 0, bottom: 0, height: `${visualBottom * 100}%` }}
				/>
				<Shade
					style={{
						left: 0,
						width: `${visualLeft * 100}%`,
						top: `${visualTop * 100}%`,
						bottom: `${visualBottom * 100}%`,
					}}
				/>
				<Shade
					style={{
						right: 0,
						width: `${visualRight * 100}%`,
						top: `${visualTop * 100}%`,
						bottom: `${visualBottom * 100}%`,
					}}
				/>

				<div
					className="border-primary pointer-events-none absolute border"
					style={{
						left: `${visualLeft * 100}%`,
						right: `${visualRight * 100}%`,
						top: `${visualTop * 100}%`,
						bottom: `${visualBottom * 100}%`,
					}}
				/>

				{GRIPS.map((grip) => {
					const isLeft = grip.horizontal === "left";
					const isRight = grip.horizontal === "right";
					const isTop = grip.vertical === "top";
					const isBottom = grip.vertical === "bottom";
					const left = isLeft
						? visualLeft
						: isRight
							? 1 - visualRight
							: (visualLeft + (1 - visualRight)) / 2;
					const top = isTop
						? visualTop
						: isBottom
							? 1 - visualBottom
							: (visualTop + (1 - visualBottom)) / 2;

					return (
						<button
							key={grip.id}
							type="button"
							aria-label={`Crop ${grip.id.replace("-", " ")}`}
							className={cn(
								"border-primary bg-background pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 p-0",
								drag && "cursor-grabbing",
							)}
							style={{
								left: `${left * 100}%`,
								top: `${top * 100}%`,
								cursor: drag ? undefined : grip.cursor,
							}}
							onPointerDown={(event) => {
								event.stopPropagation();
								event.preventDefault();
								const canvasPoint = viewport.screenToCanvas({
									clientX: event.clientX,
									clientY: event.clientY,
								});
								if (!canvasPoint) return;
								event.currentTarget.setPointerCapture(event.pointerId);
								setDrag({
									pointerId: event.pointerId,
									startCanvasX: canvasPoint.x,
									startCanvasY: canvasPoint.y,
									startCrop: crop,
									horizontal: grip.horizontal,
									vertical: grip.vertical,
								});
							}}
							onPointerMove={(event) => {
								const session = drag;
								if (!session || session.pointerId !== event.pointerId) return;
								event.stopPropagation();
								applyDrag({
									session,
									clientX: event.clientX,
									clientY: event.clientY,
								});
							}}
							onPointerUp={(event) => {
								const session = drag;
								if (!session || session.pointerId !== event.pointerId) return;
								event.stopPropagation();
								event.currentTarget.releasePointerCapture(event.pointerId);
								setDrag(null);
								commit();
							}}
							onPointerCancel={() => {
								if (!drag) return;
								setDrag(null);
								editor.timeline.discardPreview();
							}}
						/>
					);
				})}
			</div>
		</div>
	);
}

function Shade({ style }: { style: React.CSSProperties }) {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute bg-black/55"
			style={style}
		/>
	);
}
