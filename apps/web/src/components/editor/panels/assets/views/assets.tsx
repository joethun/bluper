"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";

import { invokeAction } from "@/actions";
import { processMediaPaths } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionScope,
} from "@/selection";
import { buildElementFromMedia } from "@/timeline/element-utils";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { cn } from "@/utils/ui";
import {
	ArrowDownNarrowWideIcon,
	ArrowUpDownIcon,
	ArrowUpNarrowWideIcon,
	CheckIcon,
	ImageIcon,
	LayoutGridIcon,
	ListIcon,
	type LucideIcon,
	MusicIcon,
	UnlinkIcon,
	UploadIcon,
	VideoIcon,
} from "lucide-react";

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = useEditor((e) => e.media.getAssets());
	const activeProject = useEditor((e) => e.project.getActive());

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
	} = useAssetsPanelStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);

	const processPaths = async ({ paths }: { paths: string[] }) => {
		if (paths.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: paths.length,
				promise: async () => {
					const processedAssets = await processMediaPaths({
						paths,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error importing media:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, openFilePicker, dropRef } = useFileUpload({
		onPathsSelected: ({ paths }) => processPaths({ paths }),
	});

	const handleRemove = ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => {
		event.stopPropagation();

		invokeAction("remove-media-assets", {
			projectId: activeProject.metadata.id,
			assetIds: ids,
		});
	};

	// The key and the direction are set independently. Re-clicking the active key
	// used to reverse the order, which meant the only way to reach "Name,
	// descending" was to notice that clicking a checked item did something
	// different from clicking an unchecked one.
	const handleSortKey = ({ key }: { key: MediaSortKey }) =>
		setMediaSort({ key, order: mediaSortOrder });

	const handleSortOrder = ({ order }: { order: MediaSortOrder }) =>
		setMediaSort({ key: mediaSortBy, order });

	const filteredMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);

		filtered.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;

			switch (mediaSortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.size ?? a.file?.size ?? 0;
					valueB = b.size ?? b.file?.size ?? 0;
					break;
				default:
					return 0;
			}

			if (valueA < valueB) return mediaSortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return mediaSortOrder === "asc" ? 1 : -1;
			return 0;
		});

		return filtered;
	}, [mediaFiles, mediaSortBy, mediaSortOrder]);
	const orderedMediaIds = useMemo(() => {
		return filteredMediaItems.map((item) => item.id);
	}, [filteredMediaItems]);

	return (
		<div ref={dropRef} className="h-full">
			<PanelView
				title="Assets"
				actions={
					<MediaActions
						mediaViewMode={mediaViewMode}
						setMediaViewMode={setMediaViewMode}
						isProcessing={isProcessing}
						sortBy={mediaSortBy}
						sortOrder={mediaSortOrder}
						onSortKey={handleSortKey}
						onSortOrder={handleSortOrder}
						onImport={openFilePicker}
					/>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="h-full"
			>
				{isDragOver || filteredMediaItems.length === 0 ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
					/>
				) : (
					<SelectableSurface
						ariaLabel="Assets"
						orderedIds={orderedMediaIds}
						revealId={highlightMediaId}
						onRevealComplete={clearHighlight}
					>
						<MediaScopeRegistrar />
						<MediaItemList
							items={filteredMediaItems}
							mode={mediaViewMode}
							onRemove={handleRemove}
						/>
					</SelectableSurface>
				)}
			</PanelView>
		</div>
	);
}

function MediaScopeRegistrar() {
	useSelectionScope();
	return null;
}

function MediaAssetDraggable({
	item,
	preview,
	trailing,
	variant,
	isRounded,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	trailing?: React.ReactNode;
	variant: "card" | "compact";
	isRounded?: boolean;
}) {
	const editor = useEditor();

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: MediaTime;
	}) => {
		const duration =
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={item.name}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			trailing={trailing}
			isRounded={isRounded}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const { isSelected, selectedIds } = useSelection();
	const idsToDelete = isSelected(item.id) ? selectedIds : [item.id];
	const deleteLabel =
		idsToDelete.length > 1 ? `Delete ${idsToDelete.length} items` : "Delete";

	// Offered for anything referenced, not only what is currently offline: a
	// file that has been re-rendered in place is still found, and pointing the
	// asset at its replacement is the same operation.
	const canRelink = Boolean(item.sourcePath);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>Export clips</ContextMenuItem>
				{canRelink ? (
					<ContextMenuItem
						onClick={() => {
							if (!activeProject) return;
							void editor.media.promptRelinkMediaAsset({
								projectId: activeProject.metadata.id,
								id: item.id,
							});
						}}
					>
						{item.missing ? "Relink media…" : "Relink to another file…"}
					</ContextMenuItem>
				) : null}
				<ContextMenuItem
					variant="destructive"
					onClick={(event: React.MouseEvent<HTMLDivElement>) =>
						onRemove({ event, ids: idsToDelete })
					}
				>
					{deleteLabel}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaItemList({
	items,
	mode,
	onRemove,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const isGrid = mode === "grid";

	return (
		<div
			className={cn(isGrid ? "grid gap-4" : "flex flex-col gap-0.5")}
			style={
				isGrid ? { gridTemplateColumns: "repeat(auto-fill, 7rem)" } : undefined
			}
		>
			{items.map((item) => (
				<MediaItemWithContextMenu item={item} onRemove={onRemove} key={item.id}>
					<SelectableItem className={cn(!isGrid && "w-full")} id={item.id}>
						<MediaAssetDraggable
							item={item}
							preview={
								<MediaPreview
									item={item}
									variant={isGrid ? "grid" : "compact"}
								/>
							}
							// A list row is 24px tall, so the duration goes at the end of
							// the row rather than inside the thumbnail, where "Audio 5:20"
							// was being asked to fit into a square the size of its own icon.
							trailing={
								!isGrid && item.duration
									? formatDuration({ duration: item.duration })
									: undefined
							}
							variant={isGrid ? "card" : "compact"}
							isRounded={isGrid ? false : undefined}
						/>
					</SelectableItem>
				</MediaItemWithContextMenu>
			))}
		</div>
	);
}

function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

/**
 * Stands in for an asset with no picture of its own — audio always, video and
 * stills until their thumbnail has been made.
 *
 * The compact tile is 24px square, which is an icon and nothing else. It used to
 * carry the type word and the duration as well, both of which overflowed it; the
 * row already names the file and now carries the duration at its far end.
 */
function MediaTypePlaceholder({
	icon: Icon,
	label,
	variant,
}: {
	icon: LucideIcon;
	label: string;
	variant: "grid" | "compact";
}) {
	if (variant === "compact") {
		return (
			<div className="bg-muted/40 text-muted-foreground flex size-full items-center justify-center">
				<Icon className="size-3.5" aria-label={label} />
			</div>
		);
	}

	return (
		<div className="bg-muted/30 text-muted-foreground flex size-full flex-col items-center justify-center gap-1 rounded">
			<Icon className="size-6" />
			<span className="text-xs">{label}</span>
		</div>
	);
}

/**
 * Marks an asset whose file wasn't where the project left it.
 *
 * Everything under it is what was recorded at import — the thumbnail, the
 * duration — so the tile still reads as the footage it stands for. The point
 * is to say that the pixels are gone, not that the clip is.
 */
function MediaOfflineBadge() {
	return (
		<div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/70 text-center backdrop-blur-[1px]">
			<UnlinkIcon className="size-4 text-muted-foreground" />
			<span className="px-1 text-[10px] leading-tight text-muted-foreground">
				Offline
			</span>
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	return (
		<div className="relative size-full">
			<MediaPreviewContent item={item} variant={variant} />
			{item.missing ? <MediaOfflineBadge /> : null}
		</div>
	);
}

function MediaPreviewContent({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const shouldShowDurationBadge = variant === "grid";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center bg-muted">
				<Image
					src={item.url ?? item.thumbnailUrl ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
					// An image is draggable in its own right, so without this it becomes
					// the drag source instead of the tile and the browser paints its own
					// ghost alongside the one `DraggableItem` renders.
					draggable={false}
				/>
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
						draggable={false}
					/>
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}

		return <MediaTypePlaceholder icon={VideoIcon} label="Video" variant={variant} />;
	}

	if (item.type === "audio") {
		return (
			<div className="relative size-full">
				<MediaTypePlaceholder icon={MusicIcon} label="Audio" variant={variant} />
				{shouldShowDurationBadge ? (
					<MediaDurationBadge duration={item.duration} />
				) : null}
			</div>
		);
	}

	return <MediaTypePlaceholder icon={ImageIcon} label="File" variant={variant} />;
}

const SORT_KEYS: ReadonlyArray<{ key: MediaSortKey; label: string }> = [
	{ key: "name", label: "Name" },
	{ key: "type", label: "Type" },
	{ key: "duration", label: "Duration" },
	{ key: "size", label: "File size" },
];

const SORT_ORDERS: ReadonlyArray<{
	order: MediaSortOrder;
	label: string;
	icon: LucideIcon;
}> = [
	{ order: "asc", label: "Ascending", icon: ArrowUpNarrowWideIcon },
	{ order: "desc", label: "Descending", icon: ArrowDownNarrowWideIcon },
];

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSortKey,
	onSortOrder,
	onImport,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSortKey: ({ key }: { key: MediaSortKey }) => void;
	onSortOrder: ({ order }: { order: MediaSortOrder }) => void;
	onImport: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						onClick={() =>
							setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
						}
						disabled={isProcessing}
					>
						{mediaViewMode === "grid" ? <ListIcon /> : <LayoutGridIcon />}
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{mediaViewMode === "grid"
						? "Switch to list view"
						: "Switch to grid view"}
				</TooltipContent>
			</Tooltip>
			{/*
			 * Both halves of the sort are on the menu, each ticked where it stands,
			 * so what is in force is readable without opening anything twice and
			 * changeable in one click either way. The tooltip no longer has to
			 * narrate the state, and no click means something different from the
			 * click above it.
			 */}
			<Tooltip>
				<DropdownMenu>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button size="icon" variant="ghost" disabled={isProcessing}>
								<ArrowUpDownIcon />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<DropdownMenuContent align="end" className="min-w-40">
						<DropdownMenuLabel>Sort by</DropdownMenuLabel>
						{SORT_KEYS.map(({ key, label }) => (
							<SortMenuItem
								key={key}
								label={label}
								isActive={sortBy === key}
								onSelect={() => onSortKey({ key })}
							/>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Order</DropdownMenuLabel>
						{SORT_ORDERS.map(({ order, label, icon: Icon }) => (
							<SortMenuItem
								key={order}
								label={label}
								leading={<Icon className="text-muted-foreground" />}
								isActive={sortOrder === order}
								onSelect={() => onSortOrder({ order })}
							/>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<TooltipContent>Sort</TooltipContent>
			</Tooltip>
			{/* Wears the zoom select's chrome — `bg-accent` inside `border-border` —
			    rather than a ground of its own. `size="sm"` is the same 28px tall on
			    the same 10px gutters, so the two read as one kind of control. */}
			<Button
				variant="outline"
				onClick={onImport}
				disabled={isProcessing}
				size="sm"
				className="bg-accent hover:bg-foreground/10 gap-1.5"
			>
				<UploadIcon />
				Import
			</Button>
		</div>
	);
}

/**
 * A menu row that reports whether it is the one in force. The tick keeps its
 * space when it is not, so the labels do not shuffle sideways as the choice
 * moves down the list.
 */
function SortMenuItem({
	label,
	leading,
	isActive,
	onSelect,
}: {
	label: string;
	leading?: React.ReactNode;
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem onClick={onSelect}>
			<CheckIcon className={cn(!isActive && "opacity-0")} />
			{leading}
			<span className="flex-1">{label}</span>
		</DropdownMenuItem>
	);
}
