"use client";

import {
	useState,
	useMemo,
	useRef,
	useEffect,
	useCallback,
	type CSSProperties,
} from "react";
import { List, type RowComponentProps } from "react-window";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { loadFullFont } from "@/fonts/google-fonts";
import { CUSTOM_FONT_ACCEPT, type CustomFont } from "@/fonts/custom-fonts";
import { useCustomFonts } from "@/fonts/use-custom-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import type { FontAtlas, FontAtlasEntry } from "@/fonts/types";
import { useFontAtlas } from "@/fonts/use-font-atlas";
import { cn } from "@/utils/ui";
import {
	CheckIcon,
	ChevronDownIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
} from "lucide-react";

// Must match ROW_HEIGHT in scripts/generate-font-sprites.ts. The sprite sheet
// packs each family into a 40px band and we address it by pixel offset, so a
// shorter row crops the descenders off every Google preview.
const ROW_HEIGHT = 40;
const PREVIEW_SCALE = 0.8;
const MAX_LIST_HEIGHT = 280;
const OVERSCAN = 15;

interface FontPickerProps {
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	className?: string;
}

export function FontPicker({
	defaultValue,
	onValueChange,
	className,
}: FontPickerProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const uploadInputRef = useRef<HTMLInputElement>(null);
	const { atlas, status, fontNames, retry: handleRetry } = useFontAtlas({ open });
	const {
		fonts: customFonts,
		upload,
		remove,
		error: uploadError,
		dismissError,
		isUploading,
	} = useCustomFonts();

	const customFamilies = useMemo(
		() => customFonts.map((font) => font.family),
		[customFonts],
	);

	// Uploaded fonts lead the list so they stay reachable without searching —
	// they'd otherwise be buried alphabetically among ~1,900 Google families.
	const allFontNames = useMemo(
		() => [...customFamilies, ...fontNames],
		[customFamilies, fontNames],
	);

	const filteredFonts = useMemo(() => {
		if (!search) return allFontNames;
		const query = search.toLowerCase();
		return allFontNames.filter((name) => name.toLowerCase().includes(query));
	}, [allFontNames, search]);

	const listHeight = Math.min(
		MAX_LIST_HEIGHT,
		filteredFonts.length * ROW_HEIGHT,
	);

	const handleSelect = useCallback(
		async ({ family }: { family: string }) => {
			const isCustom = customFamilies.includes(family);
			if (!isCustom && !SYSTEM_FONTS.has(family)) {
				try {
					await loadFullFont({ family });
				} catch {
					// ignore load failure, font will fall back to system default
				}
			}
			onValueChange?.(family);
			setOpen(false);
		},
		[customFamilies, onValueChange],
	);

	const handleUploadClick = useCallback(() => {
		uploadInputRef.current?.click();
	}, []);

	const handleFilesSelected = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);
			event.target.value = "";
			if (files.length === 0) return;
			await upload({ files });
		},
		[upload],
	);

	useEffect(() => {
		if (!open) {
			setSearch("");
			dismissError();
		}
	}, [open, dismissError]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				className={cn(
					"border-border bg-accent flex h-7 w-full cursor-pointer items-center justify-between gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap focus-visible:border-primary focus-visible:ring-0 focus:outline-hidden",
					className,
				)}
			>
				<span className="truncate" style={{ fontFamily: defaultValue }}>
					{defaultValue ?? "Select a font"}
				</span>
				<ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
			</PopoverTrigger>
			{/*
			 * Chrome matches ColorPicker, the sibling popover field in this panel:
			 * same width, px-0 with per-section padding, py-2 rather than the
			 * default p-4 so the search field isn't floating in dead space.
			 */}
			<PopoverContent
				className="flex w-64 flex-col gap-2 overflow-hidden px-0 py-2"
				align="start"
				side="left"
				sideOffset={8}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					searchInputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<input
					ref={uploadInputRef}
					type="file"
					accept={CUSTOM_FONT_ACCEPT}
					multiple
					className="hidden"
					onChange={handleFilesSelected}
				/>

				<div className="flex items-center gap-1 border-b px-3 pb-2">
					<div className="relative flex-1">
						<SearchIcon className="text-muted-foreground pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2" />
						<Input
							ref={searchInputRef}
							placeholder="Search fonts..."
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							size="xs"
							className="h-6 w-full border-none! bg-transparent px-0 pl-5 shadow-none!"
						/>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="size-6 shrink-0"
						disabled={isUploading}
						title="Add a font from your computer"
						aria-label="Add a font from your computer"
						onClick={handleUploadClick}
					>
						<PlusIcon />
					</Button>
				</div>

				{uploadError && (
					<p className="text-destructive px-3 text-xs">{uploadError}</p>
				)}

				{status === "loading" && (
					<p className="text-muted-foreground py-8 text-center text-sm">
						Loading fonts...
					</p>
				)}

				{status === "error" && (
					<div className="flex flex-col items-center gap-3 px-3 py-8">
						<p className="text-muted-foreground text-center text-sm">
							Failed to load font previews.
						</p>
						<Button variant="outline" size="sm" onClick={handleRetry}>
							Retry
						</Button>
					</div>
				)}

				{status === "idle" && filteredFonts.length === 0 && (
					<p className="text-muted-foreground py-6 text-center text-sm">
						No fonts found.
					</p>
				)}

				{status === "idle" && filteredFonts.length > 0 && (
					<List
						rowCount={filteredFonts.length}
						rowHeight={ROW_HEIGHT}
						overscanCount={OVERSCAN}
						rowComponent={FontRow}
						rowProps={{
							fonts: filteredFonts,
							atlas,
							customFonts,
							selectedFont: defaultValue,
							onFontSelect: handleSelect,
							onFontRemove: remove,
						}}
						style={{ height: listHeight, width: "100%" }}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

function FontSpritePreview({ entry }: { entry: FontAtlasEntry }) {
	return (
		<div
			className="shrink-0"
			style={{
				width: entry.w,
				height: ROW_HEIGHT,
				backgroundColor: "currentColor",
				WebkitMaskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				WebkitMaskPosition: `-${entry.x}px -${entry.y}px`,
				WebkitMaskRepeat: "no-repeat",
				maskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				maskPosition: `-${entry.x}px -${entry.y}px`,
				maskRepeat: "no-repeat",
				transform: `scale(${PREVIEW_SCALE})`,
				transformOrigin: "left center",
			}}
		/>
	);
}

type FontRowProps = {
	fonts: string[];
	atlas: FontAtlas | null;
	customFonts: CustomFont[];
	selectedFont: string | undefined;
	onFontSelect: (params: { family: string }) => void;
	onFontRemove: (params: { id: string }) => void;
};

function FontRow({
	index,
	style,
	fonts,
	atlas,
	customFonts,
	selectedFont,
	onFontSelect,
	onFontRemove,
}: RowComponentProps<FontRowProps>) {
	const fontName = fonts[index];
	const customFont = customFonts.find((font) => font.family === fontName);
	const entry = atlas?.fonts[fontName];
	const isSelected = fontName === selectedFont;
	// System and custom faces are installed in the document, so they render as
	// live text. Google families fall back to the prebuilt sprite until loaded.
	const canRenderLive = Boolean(customFont) || SYSTEM_FONTS.has(fontName);

	return (
		<div
			style={style as CSSProperties}
			className={cn(
				"group hover:bg-popover-hover flex items-center gap-2 px-3",
				isSelected && "bg-popover-hover",
			)}
		>
			<button
				type="button"
				className="flex min-w-0 flex-1 cursor-pointer items-center overflow-hidden text-left outline-hidden"
				onClick={() => onFontSelect({ family: fontName })}
				aria-label={fontName}
			>
				{canRenderLive || !entry ? (
					<span
						className="text-foreground/85 truncate text-xl"
						style={{ fontFamily: fontName }}
					>
						{fontName}
					</span>
				) : (
					<FontSpritePreview entry={entry} />
				)}
			</button>
			{customFont && (
				<button
					type="button"
					className="text-muted-foreground hover:text-destructive shrink-0 cursor-pointer opacity-0 outline-hidden group-hover:opacity-100 focus-visible:opacity-100"
					onClick={(event) => {
						event.stopPropagation();
						onFontRemove({ id: customFont.id });
					}}
					aria-label={`Remove ${fontName}`}
				>
					<Trash2Icon className="size-3.5" />
				</button>
			)}
			{isSelected && <CheckIcon className="text-foreground size-4 shrink-0" />}
		</div>
	);
}
