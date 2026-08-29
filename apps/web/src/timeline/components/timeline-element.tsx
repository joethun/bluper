"use client";

import { createContext, useContext } from "react";
import { useEditor } from "@/editor/use-editor";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { AudioWaveform, WAVEFORM_GAIN_SAMPLE_COUNT } from "./audio-waveform";
import { AudioVolumeLine } from "./audio-volume-line";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	useKeyframeDrag,
	type KeyframeDragState,
} from "@/timeline/hooks/element/use-keyframe-drag";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { useKeyframeBoxSelect } from "@/timeline/hooks/element/use-keyframe-box-select";
import { SelectionBox } from "@/selection/selection-box";
import { getElementKeyframes } from "@/animation";
import {
	canElementHaveAudio,
	canElementBeHidden,
	hasElementEffects,
	hasMediaId,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { getTrackHeight } from "./track-layout";
import { getTimelineElementClassName, TIMELINE_TRACK_THEME } from "./theme";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SelectionBoxBounds } from "@/selection/types";
import type {
	TimelineElement as TimelineElementType,
	TimelineTrack,
	ElementDragView,
	VideoElement,
	ImageElement,
	AudioElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { mediaSupportsAudio } from "@/media/media-utils";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
} from "@/timeline/audio-separation";
import { buildWaveformGainSamples, isElementMuted } from "@/timeline/audio-state";
import { getTimelinePixelsPerSecond } from "@/timeline";
import { canFreezeElementAtTime, isFrozenElement } from "@/freeze";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { addMediaTime, type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	getActionDefinition,
	type TAction,
	type TActionWithOptionalArgs,
	invokeAction,
} from "@/actions";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { resolveStickerId } from "@/stickers";
import { buildGraphicPreviewUrl } from "@/graphics";
import Image from "next/image";
import { ArrowRightLeftIcon, CopyIcon, DiamondIcon, EyeIcon, EyeOffIcon, ScissorsIcon, SearchIcon, SnowflakeIcon, Trash2Icon, UnlinkIcon, Volume2Icon, VolumeOffIcon, VolumeXIcon, WandSparklesIcon } from "lucide-react";
import { uppercase } from "@/utils/string";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	memo,
	useMemo,
	useRef,
	useState,
	type ComponentProps,
	type ReactNode,
} from "react";
import { useResizeObserver } from "@/hooks/use-resize-observer";
import { findScrollParent } from "@/utils/browser";
import type { SelectedKeyframeRef, ElementKeyframe } from "@/animation/types";
import { cn } from "@/utils/ui";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { getTrackTypeForElementType } from "@/timeline/placement";
import { useTimelineStore } from "@/timeline/timeline-store";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";
import {
	getExpandedRows,
	getExpansionHeight,
	type ExpandedRow,
} from "./expanded-layout";

const KEYFRAME_INDICATOR_MIN_WIDTH_PX = 40;
const ELEMENT_RING_WIDTH_PX = 1.5;

const PixelsPerSecondContext = createContext<number | null>(null);
const THUMBNAIL_ASPECT_RATIO = 16 / 9;

interface KeyframeIndicator {
	time: MediaTime;
	offsetPx: number;
	keyframes: SelectedKeyframeRef[];
}

function buildKeyframeIndicator({
	keyframe,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
}: {
	keyframe: ElementKeyframe;
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
}): {
	time: MediaTime;
	offsetPx: number;
	keyframeRef: SelectedKeyframeRef;
} {
	const keyframeRef = {
		trackId,
		elementId,
		propertyPath: keyframe.propertyPath,
		keyframeId: keyframe.id,
	};
	const keyframeLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime + keyframe.time,
		zoomLevel,
	});
	return {
		time: keyframe.time,
		offsetPx: keyframeLeft - elementLeft,
		keyframeRef,
	};
}

function getKeyframeIndicators({
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	elementWidth,
}: {
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	elementWidth: number;
}): KeyframeIndicator[] {
	if (elementWidth < KEYFRAME_INDICATOR_MIN_WIDTH_PX) {
		return [];
	}

	const keyframesByTime = new Map<MediaTime, KeyframeIndicator>();
	for (const keyframe of keyframes) {
		const indicator = buildKeyframeIndicator({
			keyframe,
			trackId,
			elementId,
			displayedStartTime,
			zoomLevel,
			elementLeft,
		});
		const existingIndicator = keyframesByTime.get(indicator.time);
		if (!existingIndicator) {
			keyframesByTime.set(indicator.time, {
				time: indicator.time,
				offsetPx: indicator.offsetPx,
				keyframes: [indicator.keyframeRef],
			});
			continue;
		}

		existingIndicator.keyframes.push(indicator.keyframeRef);
	}

	return [...keyframesByTime.values()].sort((a, b) => a.time - b.time);
}

function getDisplayShortcut({ action }: { action: TAction }) {
	const defaultShortcuts = getActionDefinition({ action }).defaultShortcuts;
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

interface TimelineElementProps {
	element: TimelineElementType;
	track: TimelineTrack;
	zoomLevel: number;
	isSelected: boolean;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	dragView: ElementDragView;
	isDropTarget?: boolean;
}

/**
 * Memoised because the timeline re-renders on scroll, on zoom and on every
 * mousemove of a drag, and a clip's own appearance depends on almost none of
 * that. Its callbacks are hoisted to be stable per track (see
 * `timeline-track.tsx`), so a parent pass with unchanged clip data stops here
 * instead of walking each clip's hooks and rebuilding its context menu.
 */
export const TimelineElement = memo(function TimelineElement({
	element,
	track,
	zoomLevel,
	isSelected,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	dragView,
	isDropTarget = false,
}: TimelineElementProps) {
	const editor = useEditor();
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const { renderElement } = useElementPreview({
		trackId: track.id,
		elementId: element.id,
		fallback: element,
	});

	let mediaAsset: MediaAsset | null = null;

	if (hasMediaId(element)) {
		mediaAsset =
			mediaAssets.find((asset) => asset.id === element.mediaId) ?? null;
	}

	const hasAudio = mediaSupportsAudio({ media: mediaAsset });

	const isCurrentElementSelected = selectedElements.some(
		(selected) =>
			selected.elementId === element.id && selected.trackId === track.id,
	);

	const isDragging = dragView.kind === "dragging";
	const dragTimeOffset = isDragging
		? dragView.memberTimeOffsets.get(element.id)
		: undefined;
	const isBeingDragged = dragTimeOffset !== undefined;
	const dragOffsetY =
		isDragging && isBeingDragged
			? dragView.currentMouseY - dragView.startMouseY
			: 0;
	const elementStartTime =
		isDragging && isBeingDragged
			? addMediaTime({ a: dragView.currentTime, b: dragTimeOffset })
			: renderElement.startTime;
	const displayedStartTime = elementStartTime;
	const displayedDuration = renderElement.duration;
	const elementWidth = timelineTimeToPixels({
		time: displayedDuration,
		zoomLevel,
	});
	const timelinePixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const elementLeft =
		isDragging && isBeingDragged
			? dragView.anchorLeftPx +
				(dragView.memberPixelOffsets.get(element.id) ?? 0)
			: timelineTimeToSnappedPixels({
					time: displayedStartTime,
					zoomLevel,
				});
	const keyframeIndicators = isSelected
		? getKeyframeIndicators({
				keyframes: getElementKeyframes({ animations: element.animations }),
				trackId: track.id,
				elementId: element.id,
				displayedStartTime,
				zoomLevel,
				elementLeft,
				elementWidth,
			})
		: [];

	const {
		keyframeDragState,
		handleKeyframeMouseDown,
		handleKeyframeClick,
		getVisualOffsetPx,
	} = useKeyframeDrag({ zoomLevel, element, displayedStartTime });

	const elementKeyframes = getElementKeyframes({
		animations: element.animations,
	});

	const isExpanded = useTimelineStore((s) =>
		s.expandedElementIds.has(element.id),
	);
	const toggleElementExpanded = useTimelineStore(
		(s) => s.toggleElementExpanded,
	);
	const expandedRows = useMemo(
		() =>
			isExpanded ? getExpandedRows({ animations: element.animations }) : [],
		[isExpanded, element.animations],
	);

	const {
		containerRef: expandedLanesRef,
		selectionBox: keyframeSelectionBox,
		isBoxSelecting: isKeyframeBoxSelecting,
		handleExpandedAreaMouseDown,
		handleExpandedAreaClick,
	} = useKeyframeBoxSelect({
		trackId: track.id,
		elementId: element.id,
		rows: expandedRows,
		keyframes: elementKeyframes,
		displayedStartTime,
		zoomLevel,
		elementLeft,
	});

	const handleRevealInMedia = ({ event }: { event: React.MouseEvent }) => {
		event.stopPropagation();
		if (hasMediaId(element)) {
			requestRevealMedia(element.mediaId);
		}
	};

	// Read on open rather than subscribed. As a `useEditor` selector this ran
	// `canFreezeElementAtTime` for every rendered clip on every playback tick,
	// and all it decides is whether one item appears in a menu that is shut.
	const canFreezeAtPlayhead =
		isMenuOpen &&
		canFreezeElementAtTime({
			element,
			time: editor.playback.getCurrentTime(),
		});

	const isMuted = canElementHaveAudio(element) && isElementMuted({ element });
	const canToggleCurrentSourceAudio =
		selectedElements.length === 1 &&
		isCurrentElementSelected &&
		canToggleSourceAudio(element, mediaAsset);
	const sourceAudioLabel =
		element.type === "video"
			? getSourceAudioActionLabel({ element })
			: "Extract audio";
	const hasKeyframes = elementKeyframes.length > 0;
	const expansionHeight = getExpansionHeight({ rows: expandedRows });
	const baseTrackHeight = getTrackHeight({ type: track.type });

	const expandedContent =
		isExpanded && expandedRows.length > 0 ? (
			<ExpandedKeyframeLanes
				rows={expandedRows}
				keyframes={elementKeyframes}
				trackId={track.id}
				elementId={element.id}
				displayedStartTime={displayedStartTime}
				zoomLevel={zoomLevel}
				elementLeft={elementLeft}
				keyframeDragState={keyframeDragState}
				onKeyframeMouseDown={handleKeyframeMouseDown}
				onKeyframeClick={handleKeyframeClick}
				getVisualOffsetPx={getVisualOffsetPx}
				containerRef={expandedLanesRef}
				onLaneMouseDown={handleExpandedAreaMouseDown}
				onLaneClick={handleExpandedAreaClick}
				selectionBox={keyframeSelectionBox}
				isBoxSelecting={isKeyframeBoxSelecting}
			/>
		) : null;

	return (
		<PixelsPerSecondContext.Provider value={timelinePixelsPerSecond}>
			<ContextMenu onOpenChange={setIsMenuOpen}>
				<ContextMenuTrigger asChild>
					<div
						className="absolute top-0 select-none"
						style={{
							left: `${elementLeft}px`,
							width: `${elementWidth}px`,
							height:
								expandedRows.length > 0
									? `${baseTrackHeight + expansionHeight}px`
									: "100%",
							transform:
								isDragging && isBeingDragged
									? `translate3d(0, ${dragOffsetY}px, 0)`
									: undefined,
						}}
					>
						<ElementInner
							element={element}
							displayElement={renderElement}
							track={track}
							isSelected={isSelected}
							isExpanded={expandedRows.length > 0}
							baseTrackHeight={baseTrackHeight}
							expandedContent={expandedContent}
							onElementClick={onElementClick}
							onElementMouseDown={onElementMouseDown}
							onResizeStart={onResizeStart}
							isDropTarget={isDropTarget}
						/>
						{isSelected && (
							<div
								className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
								style={{ height: `${baseTrackHeight}px` }}
							>
								<KeyframeIndicators
									indicators={keyframeIndicators}
									dragState={keyframeDragState}
									displayedStartTime={displayedStartTime}
									elementLeft={elementLeft}
									onKeyframeMouseDown={handleKeyframeMouseDown}
									onKeyframeClick={handleKeyframeClick}
									getVisualOffsetPx={getVisualOffsetPx}
								/>
							</div>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-64">
					<ActionMenuItem
						action="split"
						icon={<ScissorsIcon />}
					>
						Split
					</ActionMenuItem>
					{canFreezeAtPlayhead && (
						<ContextMenuItem
							icon={<SnowflakeIcon />}
							textRight={getDisplayShortcut({ action: "freeze-frame" })}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								// Freeze the clip that was right-clicked, not whatever the
								// playhead-and-selection heuristic would have picked.
								void editor.timeline.freezeFrame({
									trackId: track.id,
									elementId: element.id,
									freezeTime: editor.playback.getCurrentTime(),
								});
							}}
						>
							Freeze frame
						</ContextMenuItem>
					)}
					<CopyMenuItem />
					{selectedElements.length === 1 && (
						<ActionMenuItem
							action="duplicate-selected"
							icon={<CopyIcon />}
						>
							Duplicate
						</ActionMenuItem>
					)}
					{canElementHaveAudio(element) && hasAudio && (
						<MuteMenuItem
							isMultipleSelected={selectedElements.length > 1}
							isCurrentElementSelected={isCurrentElementSelected}
							isMuted={isMuted}
						/>
					)}
					{canToggleCurrentSourceAudio && (
						<ContextMenuItem
							icon={<ScissorsIcon />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								invokeAction("toggle-source-audio");
							}}
						>
							{sourceAudioLabel}
						</ContextMenuItem>
					)}
					{canElementBeHidden(element) && (
						<VisibilityMenuItem
							element={element}
							isMultipleSelected={selectedElements.length > 1}
							isCurrentElementSelected={isCurrentElementSelected}
						/>
					)}
					{hasKeyframes && (
						<ContextMenuItem
							icon={<DiamondIcon />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								toggleElementExpanded(element.id);
							}}
						>
							{isExpanded ? "Collapse keyframes" : "Expand keyframes"}
						</ContextMenuItem>
					)}
					{selectedElements.length === 1 && hasMediaId(element) && (
						<>
							<ContextMenuItem
								icon={<SearchIcon />}
								onClick={(event: React.MouseEvent) =>
									handleRevealInMedia({ event })
								}
							>
								Reveal media
							</ContextMenuItem>
							<ContextMenuItem
								icon={<ArrowRightLeftIcon />}
								disabled
							>
								Replace media
							</ContextMenuItem>
						</>
					)}
					<ContextMenuSeparator />
					<DeleteMenuItem
						isMultipleSelected={selectedElements.length > 1}
						isCurrentElementSelected={isCurrentElementSelected}
						elementType={element.type}
						selectedCount={selectedElements.length}
					/>
				</ContextMenuContent>
			</ContextMenu>
		</PixelsPerSecondContext.Provider>
	);
});

function ElementInner({
	element,
	displayElement,
	track,
	isSelected,
	isExpanded,
	baseTrackHeight,
	expandedContent,
	onElementClick,
	onElementMouseDown,
	onResizeStart,
	isDropTarget = false,
}: {
	element: TimelineElementType;
	displayElement?: TimelineElementType;
	track: TimelineTrack;
	isSelected: boolean;
	isExpanded: boolean;
	baseTrackHeight: number;
	expandedContent: React.ReactNode;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
	}) => void;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
}) {
	const visibleElement = displayElement ?? element;
	const isReducedOpacity =
		(canElementBeHidden(visibleElement) && visibleElement.hidden) ||
		isDropTarget;
	return (
		<div
			className="absolute top-0 bottom-0"
			style={{
				left: `${ELEMENT_RING_WIDTH_PX}px`,
				right: `${ELEMENT_RING_WIDTH_PX}px`,
			}}
		>
			<div
				className="absolute inset-0 rounded-sm"
				style={
					isSelected
						? {
								boxShadow: `0 0 0 ${ELEMENT_RING_WIDTH_PX}px var(--primary)`,
							}
						: undefined
				}
			>
				<div
					className={cn(
						"absolute inset-0 overflow-hidden rounded-sm",
						isExpanded && "bg-background",
					)}
				>
					{/*
					 * `focus-visible:outline-hidden` because this is a mouse-only
					 * surface (`tabIndex={-1}` keeps it out of the tab order), so its
					 * focus ring only ever reads as a second, competing selection
					 * outline. Clicking a clip focuses this button silently; the next
					 * keypress flips it to `:focus-visible` and paints the ring. Split
					 * is where that shows: the left half keeps the original element id,
					 * so React reuses this DOM node and its focus survives, while the
					 * selection moves to the newly-minted right half — leaving an
					 * outline on a clip the user no longer has selected.
					 */}
					<button
						type="button"
						tabIndex={-1}
						className="absolute inset-0 size-full flex flex-col focus-visible:outline-hidden"
						onClick={(event) => onElementClick({ event, element })}
						onMouseDown={(event) => onElementMouseDown({ event, element })}
					>
						<div
							className={cn(
								"flex shrink-0 items-center overflow-hidden",
								getTimelineElementClassName({
									type: getTrackTypeForElementType({
										elementType: element.type,
									}),
								}),
								isReducedOpacity && "opacity-50",
							)}
							style={{ height: `${baseTrackHeight}px` }}
						>
							<div className="flex flex-1 min-h-0 h-full items-center overflow-hidden">
								<ElementContent element={visibleElement} track={track} />
							</div>
						</div>
						{expandedContent}
					</button>
				</div>
			</div>

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						element={element}
						track={track}
						onResizeStart={onResizeStart}
					/>
					<ResizeHandle
						side="right"
						element={element}
						track={track}
						onResizeStart={onResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function ResizeHandle({
	side,
	element,
	track,
	onResizeStart,
}: {
	side: "left" | "right";
	element: TimelineElementType;
	track: TimelineTrack;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
}) {
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={cn(
				"absolute top-0 bottom-0 w-2",
				isLeft ? "-left-1 cursor-w-resize" : "-right-1 cursor-e-resize",
			)}
			onMouseDown={(event) => onResizeStart({ event, element, track, side })}
			onClick={(event) => event.stopPropagation()}
			aria-label={`${isLeft ? "Left" : "Right"} resize handle`}
		></button>
	);
}

function KeyframeIndicators({
	indicators,
	dragState,
	displayedStartTime,
	elementLeft,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	indicators: KeyframeIndicator[];
	dragState: KeyframeDragState;
	displayedStartTime: MediaTime;
	elementLeft: number;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();
	const orderedKeyframes = indicators.flatMap(
		(indicator) => indicator.keyframes,
	);

	return indicators.map((indicator) => {
		const isIndicatorSelected = indicator.keyframes.some((keyframe) =>
			isKeyframeSelected({ keyframe }),
		);
		const isBeingDragged = indicator.keyframes.some((keyframe) =>
			dragState.draggingKeyframeIds.has(keyframe.keyframeId),
		);
		const visualOffsetPx = getVisualOffsetPx({
			indicatorTime: indicator.time,
			indicatorOffsetPx: indicator.offsetPx,
			isBeingDragged,
			displayedStartTime,
			elementLeft,
		});

		return (
			<button
				key={indicator.time}
				type="button"
				className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab mr-0.5"
				style={{ left: visualOffsetPx }}
				onMouseDown={(event) =>
					onKeyframeMouseDown({ event, keyframes: indicator.keyframes })
				}
				onClick={(event) =>
					onKeyframeClick({
						event,
						keyframes: indicator.keyframes,
						orderedKeyframes,
						indicatorTime: indicator.time,
					})
				}
				aria-label="Select keyframe"
			>
				<DiamondIcon
					className={cn(
						"size-3.5 text-black",
						isIndicatorSelected ? "fill-primary" : "fill-white",
					)}
				/>
			</button>
		);
	});
}

function ExpandedKeyframeLanes({
	rows,
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	keyframeDragState,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
	containerRef,
	onLaneMouseDown,
	onLaneClick,
	selectionBox,
	isBoxSelecting,
}: {
	rows: ExpandedRow[];
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	keyframeDragState: KeyframeDragState;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onLaneMouseDown: (event: React.MouseEvent) => void;
	onLaneClick: (event: React.MouseEvent) => void;
	selectionBox: {
		bounds: SelectionBoxBounds;
	} | null;
	isBoxSelecting: boolean;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();

	const orderedKeyframes = useMemo(
		() =>
			[...keyframes]
				.sort(
					(a, b) =>
						a.time - b.time || a.propertyPath.localeCompare(b.propertyPath),
				)
				.map((kf) => ({
					trackId,
					elementId,
					propertyPath: kf.propertyPath,
					keyframeId: kf.id,
				})),
		[keyframes, trackId, elementId],
	);

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (keyframe lanes); keyboard control over keyframes is via global timeline shortcuts, not per-element focus.
		<div
			ref={containerRef}
			className="relative flex flex-col"
			onMouseDown={onLaneMouseDown}
			onClick={onLaneClick}
		>
			{rows.map((row) => {
				const laneKeyframes = keyframes.filter(
					(kf) => kf.propertyPath === row.propertyPath,
				);
				return (
					<div
						key={row.propertyPath}
						className={cn("relative flex items-center bg-muted/50")}
						style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
					>
						{laneKeyframes.map((kf) => {
							const keyframeRef: SelectedKeyframeRef = {
								trackId,
								elementId,
								propertyPath: row.propertyPath,
								keyframeId: kf.id,
							};
							const isBeingDragged = keyframeDragState.draggingKeyframeIds.has(
								kf.id,
							);
							const kfLeft = timelineTimeToSnappedPixels({
								time: displayedStartTime + kf.time,
								zoomLevel,
							});
							const offsetPx = kfLeft - elementLeft;
							const visualOffset = getVisualOffsetPx({
								indicatorTime: kf.time,
								indicatorOffsetPx: offsetPx,
								isBeingDragged,
								displayedStartTime,
								elementLeft,
							});
							const isSelected = isKeyframeSelected({
								keyframe: keyframeRef,
							});

							return (
								<button
									key={kf.id}
									type="button"
									className={cn(
										"pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab",
										isBoxSelecting && "pointer-events-none",
									)}
									style={{ left: visualOffset }}
									onMouseDown={(event) => {
										event.stopPropagation();
										onKeyframeMouseDown({
											event,
											keyframes: [keyframeRef],
										});
									}}
									onClick={(event) => {
										event.stopPropagation();
										onKeyframeClick({
											event,
											keyframes: [keyframeRef],
											orderedKeyframes,
											indicatorTime: kf.time,
										});
									}}
									aria-label="Select keyframe"
								>
									<DiamondIcon
										className={cn(
											"size-3.5 text-black mr-1",
											isSelected ? "fill-primary" : "fill-white",
										)}
									/>
								</button>
							);
						})}
					</div>
				);
			})}
			{selectionBox && <SelectionBox bounds={selectionBox.bounds} />}
		</div>
	);
}

interface ElementContentProps {
	element: TimelineElementType;
	track: TimelineTrack;
}

function TextElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "text" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start pl-2">
			<span className="truncate text-xs text-white">
				{typeof element.params.content === "string" ? element.params.content : ""}
			</span>
		</div>
	);
}

function EffectElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "effect" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start gap-1 pl-2">
			<WandSparklesIcon
				className="size-4 shrink-0 text-white"
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function StickerElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "sticker" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={resolveStickerId({
					stickerId: element.stickerId,
					options: { width: 20, height: 20 },
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function GraphicElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "graphic" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={buildGraphicPreviewUrl({
					definitionId: element.definitionId,
					params: element.params,
					size: 20,
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function AudioElementContent({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}) {
	const pixelsPerSecond = useContext(PixelsPerSecondContext);
	if (pixelsPerSecond === null) {
		throw new Error(
			"AudioElementContent must be rendered inside PixelsPerSecondContext.Provider",
		);
	}
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const mediaAsset =
		element.sourceType === "upload"
			? (mediaAssets.find((asset) => asset.id === element.mediaId) ?? null)
			: null;

	const audioUrl =
		element.sourceType === "library" ? element.sourceUrl : mediaAsset?.url;
	// Only present until the app is restarted: an asset reloaded from the media
	// store has no `File`, and its waveform is decoded from `audioUrl` instead,
	// which streams off disk.
	const sourceFile =
		element.sourceType === "upload" ? mediaAsset?.file : undefined;
	const sourceKey =
		element.sourceType === "upload"
			? buildWaveformSourceKey({ kind: "media", id: element.mediaId })
			: buildWaveformSourceKey({ kind: "library", id: element.sourceUrl });
	const mediaLabel = mediaAsset?.name ?? element.name;
	const gainSamples = useMemo(
		() =>
			buildWaveformGainSamples({
				element,
				count: WAVEFORM_GAIN_SAMPLE_COUNT,
			}),
		[element],
	);
	if (audioUrl || sourceFile) {
		return (
			<div className="group/audio relative size-full">
				<MediaElementHeader
					name={mediaLabel}
					leading={mediaAsset?.missing ? <OfflineMediaMarker /> : null}
					hasFade={false}
				/>
				<div className="absolute inset-x-0 top-5 bottom-0 overflow-hidden">
					<AudioWaveform
						sourceKey={sourceKey}
						sourceFile={sourceFile}
						audioUrl={audioUrl}
						gainSamples={gainSamples}
						pixelsPerSecond={pixelsPerSecond}
						clipDurationSec={element.duration / TICKS_PER_SECOND}
						retime={element.retime}
						sourceStartSec={element.trimStart / TICKS_PER_SECOND}
						color={TIMELINE_TRACK_THEME.audio.waveformColor}
					/>
					<AudioVolumeLine element={element} trackId={trackId} />
				</div>
			</div>
		);
	}

	return (
		<div className="group/audio relative size-full">
			<div className="flex size-full items-center pl-2">
				<span className="text-foreground/80 truncate text-xs">
					{element.name}
				</span>
			</div>
			<AudioVolumeLine element={element} trackId={trackId} />
		</div>
	);
}

function EffectsButton({
	element,
	track,
}: {
	element: VideoElement | ImageElement;
	track: TimelineTrack;
}) {
	const editor = useEditor();
	const setActiveTab = usePropertiesStore((s) => s.setActiveTab);

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		editor.selection.setSelectedElements({
			elements: [{ trackId: track.id, elementId: element.id }],
		});
		setActiveTab({ elementType: element.type, tabId: "effects" });
	};

	return (
		<button
			type="button"
			className="flex shrink-0 justify-center text-white cursor-pointer"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={handleClick}
		>
			<WandSparklesIcon className="size-3" />
		</button>
	);
}

function TiledMediaContent({
	element,
	track,
}: {
	element: VideoElement | ImageElement;
	track: TimelineTrack;
}) {
	const mediaAssets = useEditor((e) => e.media.getAssets());

	const mediaAsset = mediaAssets.find((asset) => asset.id === element.mediaId);
	const imageUrl =
		element.type === "video"
			? mediaAsset?.thumbnailUrl
			: (mediaAsset?.thumbnailUrl ?? mediaAsset?.url);

	if (!imageUrl) {
		return (
			<span className="text-foreground/80 flex items-center gap-1 truncate text-xs">
				{mediaAsset?.missing && <OfflineMediaMarker />}
				{element.name}
			</span>
		);
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const tileWidth = trackHeight * THUMBNAIL_ASPECT_RATIO;
	// A still is otherwise indistinguishable from the clip it was cut out of —
	// same filmstrip, same media name.
	const isFrozen = isFrozenElement({ element });
	const hasEffects = hasElementEffects({ element });
	return (
		<>
			<TiledFilmstrip
				imageUrl={imageUrl}
				tileWidth={tileWidth}
				trackHeight={trackHeight}
			/>
			<MediaElementHeader
				name={mediaAsset?.name}
				leading={
					isFrozen || hasEffects || mediaAsset?.missing ? (
						<div className="flex items-center gap-1">
							{mediaAsset?.missing && <OfflineMediaMarker />}
							{isFrozen && (
								<SnowflakeIcon className="size-3 shrink-0 text-white/75" />
							)}
							{hasEffects && <EffectsButton element={element} track={track} />}
						</div>
					) : null
				}
				hasFade={true}
			/>
		</>
	);
}

/**
 * Paints the repeating thumbnail strip across only the on-screen slice of the
 * clip instead of its full width.
 *
 * A 40-minute clip is ~1M px wide at 75% zoom and ~4.6M at 90%, and an
 * image-tile fill is the priciest kind of paint on the timeline. Filling the
 * whole clip means the browser carries a fill that large and re-rasters it
 * every time zoom changes the width — which is every frame of a zoom gesture.
 *
 * Renders identically to filling the whole element: the tiling is periodic, so
 * offsetting `background-position` by the slice start lands every tile in the
 * same place. Updates imperatively off scroll/resize — going through React
 * state here would re-render every clip on the timeline on every scroll frame.
 */
function TiledFilmstrip({
	imageUrl,
	tileWidth,
	trackHeight,
}: {
	imageUrl: string;
	tileWidth: number;
	trackHeight: number;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const stripRef = useRef<HTMLDivElement>(null);
	const scrollParentRef = useRef<HTMLElement | null>(null);
	const frameRef = useRef<number | null>(null);

	// Hands the clip back to the stylesheet: `inset-x-0` with no width fills the
	// whole element. This is where the strip starts and what every measurement
	// that cannot be trusted falls back to. Overdraw is the cost this component
	// already accepts to stay correct; a strip narrowed to nothing is not, since
	// what shows through is the bare gray container.
	const fillWholeClip = useCallback(() => {
		const strip = stripRef.current;
		if (!strip) return;
		strip.style.left = "";
		strip.style.right = "";
		strip.style.width = "";
		strip.style.backgroundPosition = "left center";
	}, []);

	const applySlice = useCallback(() => {
		const container = containerRef.current;
		const strip = stripRef.current;
		if (!container || !strip) return;

		const rect = container.getBoundingClientRect();
		if (rect.width <= 0) {
			fillWholeClip();
			return;
		}

		// Resolved here rather than in the listener effect so the very first
		// measurement — which runs from a layout effect, before effects — already
		// uses the real viewport instead of falling back to the window.
		scrollParentRef.current ??= findScrollParent({ element: container });
		const scrollParent = scrollParentRef.current;
		const viewport = scrollParent?.getBoundingClientRect();
		const viewportLeft = viewport?.left ?? 0;
		const viewportRight = viewport?.right ?? window.innerWidth;
		const viewportWidth = Math.max(0, viewportRight - viewportLeft);

		// A viewport that measures as nothing is a layout that has not happened
		// yet, not a clip with nothing to show. Opening a project mounts the
		// panels, the timeline and every clip in one commit, and a child's layout
		// effect runs before the ancestor layout effect that gives the panels
		// their size — so this first measurement can read a scroll parent that is
		// still zero-wide. Slicing against it puts the strip nowhere, and nothing
		// afterwards is guaranteed to measure again: the recovery paths all wait
		// on a *change* — a re-render, a scroll, a resize — and a layout that
		// settled before anyone was watching raises none of them. That is the
		// clip still gray a couple of seconds later, until some unrelated
		// re-render happens by. Fill, and let the next measurement narrow it.
		if (viewportWidth <= 0) {
			fillWholeClip();
			return;
		}

		// Paint a margin on each side. The slice is imperative geometry, so
		// anything that moves the clip without raising scroll or resize — a
		// neighbour re-laying out, a restored scroll position, a zoom that
		// repositions this clip without changing its width — leaves it stale.
		// With no margin a stale slice is bare gray container, which only a
		// scroll would clear; with one it degrades to harmless overdraw.
		//
		// The margin is a window width rather than the measured viewport so that
		// a viewport caught mid-layout — panels sized, but not yet the ones they
		// settle on — can only ever make the slice too wide. The timeline is
		// never wider than the window, so the painted area is still bounded at
		// ~3 windows instead of the clip's full width, which is the point.
		const overscan = Math.max(viewportWidth, window.innerWidth);
		const paintBudget = viewportWidth + overscan * 2;

		// Below that budget, slicing buys nothing — the slice would be the whole
		// clip — and it still costs the risk of going stale. So fill outright:
		// the strip stops depending on where the clip sits, which is the only
		// way a missed scroll, resize or reflow cannot leave gray showing. Above
		// it, slice as before; that is the case slicing exists for.
		if (rect.width <= paintBudget) {
			fillWholeClip();
			return;
		}

		const sliceLeft = Math.max(0, viewportLeft - overscan - rect.left);
		const sliceRight = Math.min(
			rect.width,
			viewportRight + overscan - rect.left,
		);
		const sliceWidth = Math.max(0, sliceRight - sliceLeft);

		// `right` comes from `inset-x-0`, which is the fill case. Slicing drives
		// the box off `left` and `width` instead, so it has to be released.
		strip.style.right = "auto";
		strip.style.left = `${sliceLeft}px`;
		strip.style.width = `${sliceWidth}px`;
		// Keep tiles phase-aligned with the clip's true origin.
		strip.style.backgroundPosition = `${-(sliceLeft % tileWidth)}px center`;
	}, [fillWholeClip, tileWidth]);

	const scheduleApply = useCallback(() => {
		if (frameRef.current !== null) return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = null;
			applySlice();
		});
	}, [applySlice]);

	useLayoutEffect(() => {
		applySlice();
	}, [applySlice, trackHeight]);

	// Re-sync after every render: a clip drag, trim, or zoom moves this element
	// through React state without raising scroll or resize on anything we
	// observe. rAF-coalesced, so a burst of renders costs one measurement.
	useEffect(scheduleApply);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		scrollParentRef.current ??= findScrollParent({ element: container });
		const scrollParent = scrollParentRef.current;
		if (!scrollParent) return;

		// The slice is measured against the scroll parent's rect, so it goes
		// stale whenever that rect moves without a scroll — dragging the editor's
		// panel splitter or collapsing a side panel resizes the scroll parent
		// with no scroll and no window resize event, leaving the strip cut off
		// and the gray container showing past where it stopped. Observing the
		// scroll parent itself catches every one of those; rAF-throttled so it
		// stays cheap with many clips on screen.
		scrollParent.addEventListener("scroll", scheduleApply, { passive: true });
		const observer = new ResizeObserver(scheduleApply);
		observer.observe(scrollParent);
		return () => {
			scrollParent.removeEventListener("scroll", scheduleApply);
			observer.disconnect();
		};
	}, [scheduleApply]);

	useResizeObserver({ ref: containerRef, onResize: scheduleApply });

	useEffect(
		() => () => {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
		},
		[],
	);

	return (
		// Pinned to the track-height band rather than stretched over the whole
		// clip box. A clip with its keyframes expanded is taller than the track
		// — the lanes hang below it — and the tiles are sized `trackHeight` tall
		// with `repeat-x`, so over a taller box they paint one centred row with
		// bare container above and below it. Since a video clip's own class is
		// `transparent`, that container is all there is to see: the filmstrip
		// grew gray margins the moment a clip was expanded.
		<div
			ref={containerRef}
			className="absolute inset-x-0 top-0"
			style={{
				height: `${trackHeight}px`,
				backgroundColor: "var(--muted)",
				pointerEvents: "none",
			}}
		>
			{/*
			 * `inset-x-0` is the filmstrip's resting state: with no width set it
			 * covers the whole clip, so the strip paints before anything has
			 * measured it and keeps painting through any measurement that comes
			 * back untrustworthy. Slicing narrows it from there — never the other
			 * way round, which would mean starting every clip as bare container.
			 */}
			<div
				ref={stripRef}
				className="absolute inset-x-0 top-0 bottom-0"
				style={{
					backgroundImage: `url(${imageUrl})`,
					backgroundRepeat: "repeat-x",
					backgroundSize: `${tileWidth}px ${trackHeight}px`,
					backgroundPosition: "left center",
					pointerEvents: "none",
				}}
			/>
		</div>
	);
}

/**
 * Marks a clip whose media is offline. Sits in the header rather than over the
 * clip so that a timeline of them still reads as a timeline — the cut points
 * and durations are all still true, and only the pixels are missing.
 */
function OfflineMediaMarker() {
	return (
		<UnlinkIcon
			className="size-3 shrink-0 text-amber-400"
			aria-label="Media offline"
		/>
	);
}

function MediaElementHeader({
	name,
	leading,
	trailing,
	hasFade,
}: {
	name?: string | null;
	leading?: ReactNode;
	trailing?: ReactNode;
	hasFade?: boolean;
}) {
	if (!name && !leading && !trailing) {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-0 left-0 flex h-5 w-full bg-linear-to-b pt-1",
				hasFade && "from-black/30 to-transparent",
			)}
		>
			{leading && <div className="shrink-0 pl-1">{leading}</div>}
			{name && (
				<span className="truncate px-1.5 text-[0.6rem] leading-tight text-white/75">
					{name}
				</span>
			)}
			{trailing && <div className="ml-auto shrink-0 pr-1">{trailing}</div>}
		</div>
	);
}

function ElementContent({ element, track }: ElementContentProps) {
	switch (element.type) {
		case "text":
			return <TextElementContent element={element} />;
		case "effect":
			return <EffectElementContent element={element} />;
		case "sticker":
			return <StickerElementContent element={element} />;
		case "graphic":
			return <GraphicElementContent element={element} />;
		case "audio":
			return <AudioElementContent element={element} trackId={track.id} />;
		case "video":
		case "image":
			return <TiledMediaContent element={element} track={track} />;
	}
}

function CopyMenuItem() {
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<CopyIcon />}
		>
			Copy
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	isMuted: boolean;
}) {
	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <VolumeXIcon />;
		}
		return isMuted ? (
			<VolumeOffIcon />
		) : (
			<Volume2Icon />
		);
	};

	return (
		<ActionMenuItem action="toggle-elements-muted-selected" icon={getIcon()}>
			{isMuted ? "Unmute" : "Mute"}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	element,
	isMultipleSelected,
	isCurrentElementSelected,
}: {
	element: TimelineElementType;
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
}) {
	const isHidden = canElementBeHidden(element) && element.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <EyeOffIcon />;
		}
		return isHidden ? (
			<EyeIcon />
		) : (
			<EyeOffIcon />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-elements-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? "Show" : "Hide"}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	elementType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	elementType: TimelineElementType["type"];
	selectedCount: number;
}) {
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<Trash2Icon />}
		>
			{isMultipleSelected && isCurrentElementSelected
				? `Delete ${selectedCount} elements`
				: `Delete ${elementType === "text" ? "text" : "clip"}`}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onClick" | "textRight"> & {
	action: TActionWithOptionalArgs;
	children: ReactNode;
}) {
	return (
		<ContextMenuItem
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut({ action })}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
