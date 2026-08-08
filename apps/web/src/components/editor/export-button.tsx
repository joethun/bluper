"use client";

import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import { toast } from "sonner";
import { downloadBlob } from "@/utils/browser";
import { triggerOPFSDownload } from "@/services/export/export-sw-bridge";
import { getExportMimeType, getExportFileExtension } from "@/export";
import { ArrowUpFromLineIcon, CheckIcon, CopyIcon, DownloadIcon, RotateCcwIcon } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	type ExportFormat,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

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
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, phase, progress, result: exportResult } = exportState;
	const isPreparing = phase === "preparing";
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);

	const handleExport = async () => {
		if (!activeProject) return;

		const result = await editor.project.export({
			options: {
				format,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.artifact) {
			const filename = `${activeProject.metadata.name}${getExportFileExtension({ format })}`;
			const mimeType = getExportMimeType({ format });

			if (result.artifact.kind === "opfs") {
				try {
					await triggerOPFSDownload({
						id: result.artifact.id,
						filename,
						mimeType,
					});
				} catch (error) {
					// The file is already in OPFS; the SW just couldn't be reached.
					// Most likely cause is a missing controller on a freshly opened
					// tab. Log and let the user retry — the file will be reaped
					// by the SW's stale sweep.
					console.error("Failed to trigger OPFS download:", error);
					toast.error(
						error instanceof Error
							? error.message
							: "Could not start the download",
					);
					editor.project.clearExportState();
					return;
				}
			} else {
				downloadBlob({ blob: result.artifact.blob, filename });
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
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "Exporting project" : "Export project"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>Format</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">
														MP4 - Better compatibility
													</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">
														WebM - Smaller file size
													</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">
													Include audio in export
												</Label>
											</div>
										</SectionContent>
									</Section>
								</div>

								<div className="p-3 pt-0">
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
					</div>
				</>
			)}
		</PopoverContent>
	);
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
