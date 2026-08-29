"use client";

import Image from "next/image";
import Link from "next/link";
import { editorHref } from "@/project/editor-route";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	ArrowDownIcon,
	CheckIcon,
	ChevronDownIcon,
	CommandIcon,
	CopyIcon,
	EllipsisIcon,
	InfoIcon,
	LayoutGridIcon,
	ListIcon,
	MoonIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	SunIcon,
	Trash2Icon,
	VideoIcon,
	XIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { formatTimecode, mediaTimeToSeconds } from "bluper-wasm";
import type { EditorCore } from "@/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ShortcutsDialog } from "@/actions/components/shortcuts-dialog";
import { NoMediaThumbnail } from "@/components/no-media-thumbnail";
import { useEditor } from "@/editor/use-editor";
import { DeleteProjectDialog } from "@/project/components/delete-project-dialog";
import { ProjectInfoDialog } from "@/project/components/project-info-dialog";
import { RenameProjectDialog } from "@/project/components/rename-project-dialog";
import { useProjectsStore } from "@/project/store";
import type {
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TSortOrder,
} from "@/project/types";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { formatDateTime, formatRelativeDate } from "@/utils/date";
import { cn } from "@/utils/ui";

/**
 * Every horizontal edge on the page — header, toolbar, grid, table — aligns to
 * this one gutter. Nesting a second padded container inside it reintroduces the
 * stepped left edges this replaced. Deliberately uncapped: the page runs the
 * full viewport width rather than a centered column.
 *
 * `px-3` is not arbitrary — it is the editor's gutter (`editor-header.tsx` and
 * the panel group and timeline in `editor/[project_id]/page.tsx` all use it), so
 * content sits at the same left edge on both pages. Keep them in step.
 */
const PAGE_GUTTER = "w-full px-3";

/**
 * Column counts are tuned so a card's thumbnail stays large — four across even
 * on a wide monitor — and a fifth column only appears past ~2240px, where four
 * would otherwise stretch each card out of proportion.
 */
const GRID_COLUMNS =
	"grid grid-cols-1 gap-x-6 gap-y-8 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 min-[140rem]:grid-cols-5";

/**
 * The table's column widths live here, not on the cells, so the header row and
 * every project row resolve to the same tracks. Cells are hidden per breakpoint
 * (see `TABLE_CELL_*`), and a hidden cell leaves the grid flow entirely — so
 * each breakpoint declares exactly as many tracks as it has visible cells:
 * select · name · [duration] · [modified] · menu.
 */
const TABLE_COLUMNS = cn(
	"grid items-center gap-3 sm:gap-4",
	"grid-cols-[1rem_minmax(0,1fr)_1.75rem]",
	"xs:grid-cols-[1rem_minmax(0,1fr)_7rem_1.75rem]",
	"sm:grid-cols-[1rem_minmax(0,1fr)_4.5rem_8.5rem_1.75rem]",
);
/**
 * Cells and their headers hide at the same breakpoints but need different
 * display values, so the pairs are spelled out rather than shared — mixing
 * `hidden` with an unprefixed `flex`/`block` on one element leaves which
 * `display` wins up to stylesheet order.
 */
const TABLE_CELL_DURATION = "hidden text-right sm:block";
const TABLE_CELL_MODIFIED = "hidden text-right xs:block";
const TABLE_HEAD_DURATION = "hidden justify-end sm:flex";
const TABLE_HEAD_MODIFIED = "hidden justify-end xs:flex";

const VIEW_MODE_OPTIONS = [
	{ mode: "grid" as const, icon: LayoutGridIcon, label: "Grid view" },
	{ mode: "list" as const, icon: ListIcon, label: "List view" },
];

const SORT_OPTIONS: {
	key: TProjectSortKey;
	label: string;
	defaultOrder: TSortOrder;
}[] = [
	{ key: "updatedAt", label: "Modified", defaultOrder: "desc" },
	{ key: "createdAt", label: "Created", defaultOrder: "desc" },
	{ key: "name", label: "Name", defaultOrder: "asc" },
	{ key: "duration", label: "Duration", defaultOrder: "desc" },
];

const getSortLabel = ({ sortKey }: { sortKey: TProjectSortKey }): string =>
	SORT_OPTIONS.find((option) => option.key === sortKey)?.label ?? "Modified";

const formatProjectDuration = ({
	duration,
}: {
	duration: number | undefined;
}): string | null => {
	if (duration === undefined) {
		return null;
	}

	const durationSeconds = mediaTimeToSeconds({ time: duration });
	const format = durationSeconds >= 3600 ? "HH:MM:SS" : "MM:SS";
	return formatTimecode({ time: duration, format }) ?? "";
};

/**
 * The date on a card follows the active sort key, so the value being sorted on
 * is the value on screen.
 */
const getProjectDate = ({
	project,
	sortKey,
}: {
	project: TProjectMetadata;
	sortKey: TProjectSortKey;
}): { label: string; title: string } => {
	const isCreated = sortKey === "createdAt";
	const date = isCreated ? project.createdAt : project.updatedAt;

	return {
		label: formatRelativeDate({ date }),
		title: `${isCreated ? "Created" : "Modified"} ${formatDateTime({ date })}`,
	};
};

async function createProject({
	editor,
	router,
}: {
	editor: EditorCore;
	router: ReturnType<typeof useRouter>;
}) {
	try {
		const projectId = await editor.project.createNewProject({
			name: editor.project.getNextDefaultProjectName(),
		});
		router.push(editorHref({ projectId }));
	} catch (error) {
		toast.error("Failed to create project", {
			description: error instanceof Error ? error.message : "Please try again",
		});
	}
}

async function deleteProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.deleteProjects({ ids });
}

async function duplicateProjects({
	editor,
	ids,
}: {
	editor: EditorCore;
	ids: string[];
}) {
	await editor.project.duplicateProjects({ ids });
}

async function renameProject({
	editor,
	id,
	name,
}: {
	editor: EditorCore;
	id: string;
	name: string;
}) {
	await editor.project.renameProject({ id, name });
}

export function Projects() {
	const { searchQuery, sortKey, sortOrder, viewMode, isHydrated } =
		useProjectsStore();
	const editor = useEditor();
	const sortOption: TProjectSortOption = `${sortKey}-${sortOrder}`;

	const isLoading = useEditor((e) => e.project.getIsLoading());
	const isInitialized = useEditor((e) => e.project.getIsInitialized());
	const projectsToDisplay = useEditor((e) =>
		e.project.getFilteredAndSortedProjects({ searchQuery, sortOption }),
	);

	useEffect(() => {
		if (!editor.project.getIsInitialized()) {
			editor.project.loadAllProjects();
		}
	}, [editor.project]);

	const isPending = isLoading || !isInitialized;
	const projectIds = projectsToDisplay.map((project) => project.id);
	// Before hydration the persisted view mode is still the default, so render
	// the grid skeleton rather than flashing a table the user didn't choose.
	const isGridView = !isHydrated || viewMode === "grid";

	return (
		<div className="bg-background flex min-h-screen flex-col">

			<ProjectsHeader
				projectIds={projectIds}
				projectCount={isPending ? null : projectsToDisplay.length}
			/>

			{/* Top padding matches the gutter so content sits in an even frame; the
			    bottom gets more so the last row clears the viewport edge on scroll. */}
			<main className={cn(PAGE_GUTTER, "flex-1 pt-3 pb-6")}>
				{isPending ? (
					<ProjectsSkeleton isGridView={isGridView} />
				) : projectsToDisplay.length === 0 ? (
					<EmptyState />
				) : isGridView ? (
					<div className={GRID_COLUMNS}>
						{projectsToDisplay.map((project) => (
							<ProjectItem
								key={project.id}
								project={project}
								allProjectIds={projectIds}
								isGridView
							/>
						))}
					</div>
				) : (
					<div className="border-border/70 divide-border/60 divide-y overflow-hidden rounded-xl border">
						<ProjectsTableHeader />
						{projectsToDisplay.map((project) => (
							<ProjectItem
								key={project.id}
								project={project}
								allProjectIds={projectIds}
								isGridView={false}
							/>
						))}
					</div>
				)}
			</main>
		</div>
	);
}

function ProjectsHeader({
	projectIds,
	projectCount,
}: {
	projectIds: string[];
	projectCount: number | null;
}) {
	const { selectedProjectIds, clearSelectedProjects } = useProjectsStore();
	const hasSelection = selectedProjectIds.length > 0;
	const { theme, setTheme } = useTheme();
	const [shortcutsOpen, setShortcutsOpen] = useState(false);

	// Escape is the way out of a selection: the action bar is the only thing
	// standing between a stray shift-click and a destructive button.
	useEffect(() => {
		if (!hasSelection) {
			return;
		}

		const handleKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				clearSelectedProjects();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [hasSelection, clearSelectedProjects]);

	const isDark = theme === "dark";

	return (
		<header className="bg-background/80 border-border/70 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-20 border-b backdrop-blur-md">
			{/* Height and top nudge match the editor header, so the logo and title
			    land on the same baseline when moving between the two pages. */}
			<div
				className={cn(
					PAGE_GUTTER,
					"flex h-[3.4rem] items-center justify-between gap-4 pt-0.5",
				)}
			>
				<div className="flex items-center gap-1">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="p-1 rounded-sm size-10"
							>
								<Image
									src={DEFAULT_LOGO_URL}
									alt="Bluper"
									width={135}
									height={125}
									className="size-8"
									priority
								/>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="z-100 w-44">
							<DropdownMenuItem
								onClick={() => setShortcutsOpen(true)}
								icon={<CommandIcon />}
							>
								Shortcuts
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => setTheme(isDark ? "light" : "dark")}
								icon={isDark ? <SunIcon /> : <MoonIcon />}
							>
								{isDark ? "Light mode" : "Dark mode"}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{/*
					 * Same metrics as the editor's project-name field — `text-base` at
					 * normal weight in an `h-8 px-2` box — so the title reads as the same
					 * element in the same place, not a heavier page heading. No hover
					 * state: that one is a rename affordance, this is just a label.
					 */}
					<h1 className="flex h-8 items-center px-2 text-base">Projects</h1>
					{projectCount !== null && projectCount > 0 && (
						<span className="bg-muted/60 text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
							{projectCount}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2 sm:gap-3">
					<SearchBar className="hidden w-52 lg:block xl:w-72" />
					<ViewModeToggle className="hidden sm:flex" />
					<NewProjectButton />
				</div>
			</div>

			<div className="border-border/60 border-t">
				<div className={cn(PAGE_GUTTER, "flex h-12 items-center gap-2")}>
					<SelectAllCheckbox projectIds={projectIds} />

					{hasSelection ? (
						<SelectionActions />
					) : (
						<>
							<div className="bg-border/70 mx-1 h-4 w-px" />
							<SortControl />
							<div className="flex-1" />
							<SearchBar className="w-36 min-w-0 xs:w-48 lg:hidden" />
							<ViewModeToggle className="flex sm:hidden" />
						</>
					)}
				</div>
			</div>

			<ShortcutsDialog
				isOpen={shortcutsOpen}
				onOpenChange={setShortcutsOpen}
			/>
		</header>
	);
}

function ViewModeToggle({ className }: { className?: string }) {
	const { viewMode, isHydrated, setViewMode } = useProjectsStore();

	return (
		<div
			className={cn(
				"border-border/70 bg-muted/25 flex h-9 items-center gap-0.5 rounded-md border p-0.5",
				className,
			)}
		>
			{VIEW_MODE_OPTIONS.map(({ mode, icon: Icon, label }) => {
				const isActive = isHydrated && viewMode === mode;

				return (
					<Button
						key={mode}
						variant="ghost"
						size="icon"
						className={cn(
							"size-8 rounded-sm",
							isActive
								? "bg-background text-foreground shadow-xs"
								: "text-muted-foreground hover:bg-background/60 hover:text-foreground",
						)}
						onClick={() => setViewMode({ viewMode: mode })}
						aria-label={label}
						aria-pressed={isActive}
					>
						<Icon className="size-4" />
					</Button>
				);
			})}
		</div>
	);
}

function SearchBar({ className }: { className?: string }) {
	const { searchQuery, setSearchQuery } = useProjectsStore();

	return (
		<div className={cn("relative", className)}>
			<SearchIcon
				className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
				aria-hidden="true"
			/>
			<Input
				placeholder="Search projects"
				value={searchQuery}
				onChange={(event) => setSearchQuery({ query: event.target.value })}
				onClear={() => setSearchQuery({ query: "" })}
				showClearIcon
				aria-label="Search projects"
				className="pl-9"
			/>
		</div>
	);
}

function SortControl() {
	const { sortKey, sortOrder, setSortKey, setSortOrder } = useProjectsStore();

	return (
		<div className="flex items-center">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						className="text-muted-foreground hover:text-foreground h-8 gap-1.5 px-2"
					>
						<span className="text-muted-foreground/70 hidden sm:inline">
							Sort by
						</span>
						<span className="text-foreground font-medium">
							{getSortLabel({ sortKey })}
						</span>
						<ChevronDownIcon className="size-3.5 opacity-60" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-44" align="start">
					{SORT_OPTIONS.map((option) => (
						<DropdownMenuItem
							key={option.key}
							onClick={() => {
								setSortKey({ sortKey: option.key });
								setSortOrder({ sortOrder: option.defaultOrder });
							}}
						>
							<CheckIcon
								className={cn(
									"size-4",
									sortKey === option.key ? "opacity-100" : "opacity-0",
								)}
							/>
							{option.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>

			<Button
				variant="ghost"
				size="icon"
				className="text-muted-foreground hover:text-foreground size-8"
				onClick={() =>
					setSortOrder({ sortOrder: sortOrder === "asc" ? "desc" : "asc" })
				}
				aria-label={
					sortOrder === "asc" ? "Sort descending" : "Sort ascending"
				}
			>
				<ArrowDownIcon
					className={cn(
						"size-4 transition-transform duration-200",
						sortOrder === "asc" && "rotate-180",
					)}
				/>
			</Button>
		</div>
	);
}

function SelectAllCheckbox({ projectIds }: { projectIds: string[] }) {
	const {
		selectedProjectIds,
		setSelectedProjects,
		clearSelectedProjects,
	} = useProjectsStore();

	const selectedProjectCount = selectedProjectIds.length;
	const isAllSelected =
		projectIds.length > 0 && selectedProjectCount === projectIds.length;
	const hasSomeSelected =
		selectedProjectCount > 0 && selectedProjectCount < projectIds.length;

	return (
		<Checkbox
			id="select-all-projects"
			className="ml-1"
			disabled={projectIds.length === 0}
			checked={isAllSelected ? true : hasSomeSelected ? "indeterminate" : false}
			onCheckedChange={(checked) => {
				if (checked === true) {
					setSelectedProjects({ projectIds });
					return;
				}
				clearSelectedProjects();
			}}
			aria-label={isAllSelected ? "Clear selection" : "Select all projects"}
		/>
	);
}

function SelectionActions() {
	const editor = useEditor();
	const { selectedProjectIds, clearSelectedProjects } = useProjectsStore();
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

	const selectedProjectNames = editor.project
		.getSavedProjects()
		.filter((project) => selectedProjectIds.includes(project.id))
		.map((project) => project.name);

	const handleDuplicate = async () => {
		await duplicateProjects({ editor, ids: selectedProjectIds });
		clearSelectedProjects();
	};

	const handleDeleteConfirm = async () => {
		await deleteProjects({ editor, ids: selectedProjectIds });
		clearSelectedProjects();
		setIsDeleteDialogOpen(false);
	};

	return (
		<>
			<div className="flex flex-1 items-center gap-2">
				<span className="text-foreground ml-2 text-sm font-medium tabular-nums">
					{selectedProjectIds.length} selected
				</span>

				<div className="bg-border/70 mx-1 h-4 w-px" />

				<Button variant="outline" size="sm" onClick={handleDuplicate}>
					<CopyIcon />
					<span className="hidden xs:inline">Duplicate</span>
				</Button>
				<Button
					variant="destructive-foreground"
					size="sm"
					onClick={() => setIsDeleteDialogOpen(true)}
				>
					<Trash2Icon />
					<span className="hidden xs:inline">Delete</span>
				</Button>

				<div className="flex-1" />

				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-foreground"
					onClick={clearSelectedProjects}
				>
					<XIcon />
					<span className="hidden sm:inline">Clear</span>
				</Button>
			</div>

			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={selectedProjectNames}
				onConfirm={handleDeleteConfirm}
			/>
		</>
	);
}

function NewProjectButton() {
	const editor = useEditor();
	const router = useRouter();

	return (
		<Button
			className="h-9 gap-1.5 px-3 sm:px-4"
			onClick={() => createProject({ editor, router })}
		>
			<PlusIcon />
			<span className="hidden font-medium sm:inline">New project</span>
			<span className="font-medium sm:hidden">New</span>
		</Button>
	);
}

function ProjectsTableHeader() {
	return (
		<div
			className={cn(
				TABLE_COLUMNS,
				"text-muted-foreground bg-muted/30 h-10 px-4 text-xs font-medium",
			)}
		>
			<span />
			<SortableColumnHeader sortKey="name" label="Name" className="flex" />
			<SortableColumnHeader
				sortKey="duration"
				label="Duration"
				className={TABLE_HEAD_DURATION}
			/>
			<SortableColumnHeader
				sortKey="updatedAt"
				label="Modified"
				className={TABLE_HEAD_MODIFIED}
			/>
			<span />
		</div>
	);
}

function SortableColumnHeader({
	sortKey: columnKey,
	label,
	className,
}: {
	sortKey: TProjectSortKey;
	label: string;
	className?: string;
}) {
	const { sortKey, sortOrder, setSortKey, setSortOrder, toggleSortOrder } =
		useProjectsStore();
	const isActive = sortKey === columnKey;

	const handleClick = () => {
		if (isActive) {
			toggleSortOrder();
			return;
		}

		setSortKey({ sortKey: columnKey });
		setSortOrder({
			sortOrder:
				SORT_OPTIONS.find((option) => option.key === columnKey)?.defaultOrder ??
				"desc",
		});
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			className={cn(
				"hover:text-foreground cursor-pointer items-center gap-1 truncate transition-colors",
				isActive && "text-foreground",
				className,
			)}
			aria-label={
				isActive
					? `Sorted by ${label}, ${sortOrder === "asc" ? "ascending" : "descending"}. Reverse order`
					: `Sort by ${label}`
			}
		>
			{label}
			<ArrowDownIcon
				className={cn(
					"size-3 transition-all duration-200",
					isActive ? "opacity-100" : "opacity-0",
					isActive && sortOrder === "asc" && "rotate-180",
				)}
			/>
		</button>
	);
}

function ProjectThumbnail({
	project,
	className,
	iconClassName,
}: {
	project: TProjectMetadata;
	className?: string;
	iconClassName?: string;
}) {
	return (
		<div className={cn("bg-muted/70 relative overflow-hidden", className)}>
			{project.thumbnail ? (
				<Image
					src={project.thumbnail}
					alt=""
					fill
					sizes="(max-width: 30rem) 100vw, (max-width: 48rem) 50vw, (max-width: 80rem) 33vw, (max-width: 140rem) 25vw, 20vw"
					className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
				/>
			) : (
				<NoMediaThumbnail iconClassName={iconClassName} />
			)}
		</div>
	);
}

function ProjectItem({
	project,
	allProjectIds,
	isGridView,
}: {
	project: TProjectMetadata;
	allProjectIds: string[];
	isGridView: boolean;
}) {
	const {
		selectedProjectIds,
		sortKey,
		setProjectSelected,
		selectProjectRange,
	} = useProjectsStore();
	const editor = useEditor();

	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isInfoDialogOpen, setIsInfoDialogOpen] = useState(false);

	const isSelected = selectedProjectIds.includes(project.id);
	const isMultiSelect = selectedProjectIds.length > 1;
	const durationLabel = formatProjectDuration({ duration: project.duration });
	const projectDate = getProjectDate({ project, sortKey });

	const actions = {
		onRename: () => setIsRenameDialogOpen(true),
		onDuplicate: () => duplicateProjects({ editor, ids: [project.id] }),
		onInfo: () => setIsInfoDialogOpen(true),
		onDelete: () => setIsDeleteDialogOpen(true),
	};

	const selectionCheckbox = (
		<Checkbox
			checked={isSelected}
			onMouseDown={(event) => event.preventDefault()}
			onClick={(event) => {
				if (event.shiftKey && !isSelected) {
					selectProjectRange({ projectId: project.id, allProjectIds });
					return;
				}
				setProjectSelected({ projectId: project.id, isSelected: !isSelected });
			}}
			onCheckedChange={() => {}}
			aria-label={`Select ${project.name}`}
		/>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					{isGridView ? (
						<div className="group relative">
							<Link
								href={editorHref({ projectId: project.id })}
								className="focus-visible:ring-ring block rounded-xl focus-visible:ring-2 focus-visible:outline-hidden"
							>
								<div
									className={cn(
										"ring-border/70 relative aspect-video overflow-hidden rounded-xl ring-1 transition-all duration-200",
										"group-hover:-translate-y-0.5 group-hover:shadow-lg",
										isSelected
											? "ring-primary ring-offset-background ring-2 ring-offset-2"
											: "group-hover:ring-foreground/20",
									)}
								>
									<ProjectThumbnail
										project={project}
										className="size-full"
										iconClassName="size-10"
									/>

									{/* Keeps the checkbox and menu legible over bright thumbnails. */}
									<div
										className={cn(
											"pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/45 to-transparent transition-opacity duration-200",
											isSelected || isMenuOpen
												? "opacity-100"
												: "opacity-0 group-hover:opacity-100",
										)}
									/>

									{durationLabel && (
										<span className="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums backdrop-blur-sm">
											{durationLabel}
										</span>
									)}
								</div>

								<div className="flex flex-col gap-1 px-0.5 pt-3">
									<h3
										className="truncate text-sm font-medium"
										title={project.name}
									>
										{project.name}
									</h3>
									<span
										className="text-muted-foreground text-xs"
										title={projectDate.title}
									>
										{projectDate.label}
									</span>
								</div>
							</Link>

							<div
								className={cn(
									"absolute top-2.5 left-2.5 transition-opacity duration-200",
									isSelected || isMenuOpen
										? "opacity-100"
										: "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
								)}
							>
								{selectionCheckbox}
							</div>

							{!isMultiSelect && (
								<ProjectMenu
									isOpen={isMenuOpen}
									onOpenChange={setIsMenuOpen}
									className={cn(
										"absolute top-2 right-2 text-white hover:bg-white/20",
										isMenuOpen
											? "opacity-100"
											: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
									)}
									{...actions}
								/>
							)}
						</div>
					) : (
						<div
							className={cn(
								TABLE_COLUMNS,
								"group h-14 px-4 transition-colors",
								isSelected ? "bg-primary/5" : "hover:bg-accent/50",
							)}
						>
							{selectionCheckbox}

							<Link
								href={editorHref({ projectId: project.id })}
								className="focus-visible:ring-ring flex min-w-0 items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:outline-hidden"
							>
								<ProjectThumbnail
									project={project}
									className="ring-border/60 h-9 w-16 shrink-0 rounded-md ring-1"
									iconClassName="size-4"
								/>
								<span className="truncate text-sm font-medium" title={project.name}>
									{project.name}
								</span>
							</Link>

							<span
								className={cn(
									TABLE_CELL_DURATION,
									"text-muted-foreground text-sm tabular-nums",
								)}
							>
								{durationLabel ?? "—"}
							</span>

							<span
								className={cn(
									TABLE_CELL_MODIFIED,
									"text-muted-foreground truncate text-sm",
								)}
								title={projectDate.title}
							>
								{projectDate.label}
							</span>

							{isMultiSelect ? (
								<span />
							) : (
								<ProjectMenu
									isOpen={isMenuOpen}
									onOpenChange={setIsMenuOpen}
									className={cn(
										"text-muted-foreground hover:text-foreground",
										isMenuOpen
											? "opacity-100"
											: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
									)}
									{...actions}
								/>
							)}
						</div>
					)}
				</ContextMenuTrigger>

				<ContextMenuContent className="w-44">
					<ContextMenuItem icon={<PencilIcon />} onClick={actions.onRename}>
						Rename
					</ContextMenuItem>
					<ContextMenuItem icon={<CopyIcon />} onClick={actions.onDuplicate}>
						Duplicate
					</ContextMenuItem>
					<ContextMenuItem icon={<InfoIcon />} onClick={actions.onInfo}>
						Info
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						variant="destructive"
						icon={<Trash2Icon />}
						onClick={actions.onDelete}
					>
						Delete
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>

			<RenameProjectDialog
				isOpen={isRenameDialogOpen}
				onOpenChange={setIsRenameDialogOpen}
				projectName={project.name}
				onConfirm={async (newName) => {
					await renameProject({ editor, id: project.id, name: newName });
					setIsRenameDialogOpen(false);
				}}
			/>

			<DeleteProjectDialog
				isOpen={isDeleteDialogOpen}
				onOpenChange={setIsDeleteDialogOpen}
				projectNames={[project.name]}
				onConfirm={async () => {
					await deleteProjects({ editor, ids: [project.id] });
					setIsDeleteDialogOpen(false);
				}}
			/>

			<ProjectInfoDialog
				isOpen={isInfoDialogOpen}
				onOpenChange={setIsInfoDialogOpen}
				project={project}
			/>
		</>
	);
}

function ProjectMenu({
	isOpen,
	onOpenChange,
	className,
	onRename,
	onDuplicate,
	onInfo,
	onDelete,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	className?: string;
	onRename: () => void;
	onDuplicate: () => void;
	onInfo: () => void;
	onDelete: () => void;
}) {
	// The trigger sits inside (grid) or beside (table) a link, so both pointer
	// and keyboard activation have to stop short of navigating.
	const stopActivation = ({
		event,
	}: {
		event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>;
	}) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const runAction = ({ action }: { action: () => void }) => {
		action();
		onOpenChange(false);
	};

	return (
		<DropdownMenu open={isOpen} onOpenChange={onOpenChange}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className={cn("transition-opacity duration-200", className)}
					aria-label="Project menu"
					onClick={(event) => stopActivation({ event })}
					onMouseDown={(event) => event.stopPropagation()}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							stopActivation({ event });
						}
					}}
				>
					<EllipsisIcon aria-hidden="true" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-44" align="end">
				<DropdownMenuItem onClick={() => runAction({ action: onRename })}>
					<PencilIcon />
					Rename
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => runAction({ action: onDuplicate })}>
					<CopyIcon />
					Duplicate
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => runAction({ action: onInfo })}>
					<InfoIcon />
					Info
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					onClick={() => runAction({ action: onDelete })}
				>
					<Trash2Icon />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ProjectsSkeleton({ isGridView }: { isGridView: boolean }) {
	const skeletonIds = Array.from(
		{ length: isGridView ? 10 : 8 },
		(_, index) => `skeleton-${index}`,
	);

	if (!isGridView) {
		return (
			<div className="border-border/70 divide-border/60 divide-y overflow-hidden rounded-xl border">
				<div className="bg-muted/30 h-10" />
				{skeletonIds.map((skeletonId) => (
					<div key={skeletonId} className={cn(TABLE_COLUMNS, "h-14 px-4")}>
						<Skeleton className="bg-muted/50 size-4 rounded-sm" />
						<div className="flex min-w-0 items-center gap-3">
							<Skeleton className="bg-muted/50 h-9 w-16 rounded-md" />
							<Skeleton className="bg-muted/50 h-3.5 w-40 max-w-full" />
						</div>
						<Skeleton
							className={cn(TABLE_CELL_DURATION, "bg-muted/50 ml-auto h-3.5 w-10")}
						/>
						<Skeleton
							className={cn(TABLE_CELL_MODIFIED, "bg-muted/50 ml-auto h-3.5 w-20")}
						/>
						<span />
					</div>
				))}
			</div>
		);
	}

	return (
		<div className={GRID_COLUMNS}>
			{skeletonIds.map((skeletonId) => (
				<div key={skeletonId} className="flex flex-col gap-3">
					<Skeleton className="bg-muted/50 aspect-video w-full rounded-xl" />
					<div className="flex flex-col gap-2 px-0.5">
						<Skeleton className="bg-muted/50 h-3.5 w-3/5" />
						<Skeleton className="bg-muted/50 h-3 w-2/5" />
					</div>
				</div>
			))}
		</div>
	);
}

function EmptyState() {
	const { searchQuery, setSearchQuery } = useProjectsStore();
	const router = useRouter();
	const editor = useEditor();
	const hasSavedProjects = editor.project.getSavedProjects().length > 0;

	const isSearchEmptyState = hasSavedProjects;
	const Icon = isSearchEmptyState ? SearchIcon : VideoIcon;

	return (
		<div className="flex flex-col items-center justify-center gap-6 px-4 py-24 text-center">
			<div className="border-border/70 bg-muted/25 flex size-14 items-center justify-center rounded-2xl border">
				<Icon className="text-muted-foreground size-6" aria-hidden="true" />
			</div>

			<div className="flex max-w-md flex-col gap-2">
				<h2 className="text-base font-semibold">
					{isSearchEmptyState ? "No matching projects" : "No projects yet"}
				</h2>
				<p className="text-muted-foreground text-sm">
					{isSearchEmptyState
						? `Nothing matched “${searchQuery}”. Try a different name or clear the search.`
						: "Create your first project to import media, edit, and export"}
				</p>
			</div>

			{isSearchEmptyState ? (
				<Button variant="outline" onClick={() => setSearchQuery({ query: "" })}>
					Clear search
				</Button>
			) : (
				<Button onClick={() => createProject({ editor, router })}>
					<PlusIcon />
					Create your first project
				</Button>
			)}
		</div>
	);
}
