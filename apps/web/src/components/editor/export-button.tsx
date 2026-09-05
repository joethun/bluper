"use client";

import { useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/utils/ui";
import { toast } from "sonner";
import {
	tauriMoveFile,
	tauriRemoveFile,
	tauriRevealItemInDir,
	tauriSaveDialog,
} from "@/lib/tauri-runtime";
import {
	describeExportResolution,
	EXPORT_FORMAT,
	getExportFileExtension,
	getExportFormatSpec,
	getExportResolutionKey,
	getExportResolutionLabel,
	listProjectExportResolutions,
} from "@/export";
import {
	ArrowUpFromLineIcon,
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	FolderOpenIcon,
	RotateCcwIcon,
} from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";

/**
 * Starts an export and shows its own progress.
 *
 * The trigger itself fills in as the render advances and stays clickable to
 * reopen the popover, so closing it - clicking away, Escape - can never cancel
 * a run already underway. Only the explicit Cancel button does that.
 */
export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const { isExporting, phase, progress } = useEditor((e) =>
		e.project.getExportState(),
	);
	const hasProject = !!activeProject;
	const isPreparing = phase === "preparing";
	const progressRatio = Math.min(Math.max(progress, 0), 1);
	const progressPercent = Math.round(progressRatio * 100);

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		// Closing the popover (clicking away, Escape) must never cancel a running
		// export - it keeps running in the background and the trigger shows its
		// progress. Only cancelling explicitly stops it.
		if (!open && !isExporting) {
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<Button
					size="sm"
					disabled={!hasProject}
					className="bg-primary text-primary-foreground hover:bg-primary/90 relative h-8 gap-1.5 overflow-hidden px-3"
					aria-label={
						isPreparing
							? "Preparing export"
							: isExporting
								? `Exporting, ${progressPercent}%`
								: "Export project"
					}
					title={
						isPreparing
							? "Preparing audio"
							: isExporting
								? `Exporting - ${progressPercent}%`
								: undefined
					}
				>
					{/* Progress fills the button from the left. It sits before the label
					    in the DOM so the label paints over it without needing z-index. */}
					{isExporting && (
						<span
							aria-hidden
							className={cn(
								"bg-primary-foreground/25 absolute inset-y-0 left-0",
								isPreparing
									? "w-full animate-pulse"
									: "transition-[width] duration-200 ease-out",
							)}
							style={isPreparing ? undefined : { width: `${progressPercent}%` }}
						/>
					)}
					<ArrowUpFromLineIcon className="relative" />
					<span className="relative tabular-nums">
						{isPreparing
							? "Preparing"
							: isExporting
								? `${progressPercent}%`
								: "Export"}
					</span>
				</Button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const canvasSize = activeProject.settings.canvasSize;
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, phase, progress, result: exportResult } = exportState;
	const isPreparing = phase === "preparing";

	// Keyed off the canvas because that is what the ladder is derived from: a
	// project resized while the panel is open offers a different set of sizes.
	const resolutions = useMemo(
		() => listProjectExportResolutions({ canvas: canvasSize }),
		[canvasSize],
	);

	// The pick is held as a key rather than as the resolution itself so that a
	// canvas resize leaves it resolving to the project's own size — the first
	// entry — instead of to a size the ladder no longer offers.
	const [resolutionKey, setResolutionKey] = useState<string | null>(null);
	const resolution =
		resolutions.find(
			(candidate) =>
				getExportResolutionKey({ resolution: candidate }) === resolutionKey,
		) ?? resolutions[0];

	const handleExport = async () => {
		const result = await editor.project.export({
			options: { resolution, fps: activeProject.settings.fps },
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.artifact) {
			const filename = `${activeProject.metadata.name}${getExportFileExtension({ format: EXPORT_FORMAT })}`;

			// The render already wrote a finished file. All that's left is asking
			// where it should live and moving it there — no bytes pass through
			// the page, whatever the export weighs.
			const scratchPath = result.artifact.path;
			try {
				const spec = getExportFormatSpec({ format: EXPORT_FORMAT });
				const destination = await tauriSaveDialog({
					title: "Export project",
					defaultPath: filename,
					filters: [{ name: `${spec.label} video`, extensions: [spec.extension] }],
				});

				if (!destination) {
					await tauriRemoveFile({ path: scratchPath }).catch(() => {
						// Leaving a scratch file behind is not worth an error
						// toast; the cache directory is the OS's to reclaim.
					});
				} else {
					await tauriMoveFile({ from: scratchPath, to: destination });
					showSavedToast({ destination });
				}
			} catch (error) {
				console.error("Failed to save export:", error);
				toast.error(
					error instanceof Error ? error.message : "Could not save the export",
				);
				await tauriRemoveFile({ path: scratchPath }).catch(() => {});
				editor.project.clearExportState();
				return;
			}

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "Unknown error occurred"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between border-b p-3">
						<h3 className="text-sm font-medium">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					{!isExporting && (
						<>
							<div className="flex flex-col gap-2 px-3 pt-3">
								<Label htmlFor="export-quality">Quality</Label>
								<Select
									value={getExportResolutionKey({ resolution })}
									onValueChange={(value) => setResolutionKey(value)}
								>
									<SelectTrigger id="export-quality" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{resolutions.map((option) => (
											<SelectItem
												key={getExportResolutionKey({ resolution: option })}
												value={getExportResolutionKey({ resolution: option })}
											>
												<span className="flex items-baseline gap-2">
													<span>
														{getExportResolutionLabel({ resolution: option })}
													</span>
													<span className="text-muted-foreground text-xs tabular-nums">
														{describeExportResolution({ resolution: option })}
													</span>
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div className="p-3">
								<Button onClick={handleExport} className="w-full gap-2">
									<DownloadIcon className="size-4" />
									Export
								</Button>
							</div>
						</>
					)}

					{isExporting && (
						<div className="space-y-4 p-3">
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between text-center">
									<p className="text-muted-foreground text-sm">
										{isPreparing
											? "Preparing audio"
											: `${Math.round(progress * 100)}%`}
									</p>
									{!isPreparing && (
										<p className="text-muted-foreground text-sm">100%</p>
									)}
								</div>
								{isPreparing ? (
									<div className="bg-accent relative h-2 w-full overflow-hidden rounded-full">
										<div className="bg-primary/60 size-full animate-pulse" />
									</div>
								) : (
									<Progress value={progress * 100} className="w-full" />
								)}
							</div>

							<Button
								variant="outline"
								className="w-full rounded-md"
								onClick={handleCancel}
							>
								Cancel
							</Button>
						</div>
					)}
				</>
			)}
		</PopoverContent>
	);
}

/**
 * Confirms the save and offers to open the containing folder.
 *
 * The action is a rendered element rather than sonner's `{ label, onClick }`
 * pair on purpose: sonner styles that shape with
 * `[data-sonner-toast][data-styled='true'] [data-button]`, whose specificity
 * outranks anything `toastOptions.classNames.actionButton` can pass it, so the
 * button always paints as sonner's own black pill. An element is rendered
 * as-is, which lets the editor's `Button` look like every other button here.
 */
function showSavedToast({ destination }: { destination: string }) {
	const id = toast.success(`Saved to ${destination}`, {
		action: (
			<Button
				variant="outline"
				size="sm"
				className="ml-auto shrink-0"
				onClick={() => {
					toast.dismiss(id);
					tauriRevealItemInDir(destination).catch((error) => {
						console.error("Failed to reveal export:", error);
						toast.error("Could not open the folder");
					});
				}}
			>
				<FolderOpenIcon />
				Show
			</Button>
		),
	});
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <CheckIcon className="text-constructive" /> : <CopyIcon />}
					Copy Error
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcwIcon />
					Retry
				</Button>
			</div>
		</div>
	);
}
