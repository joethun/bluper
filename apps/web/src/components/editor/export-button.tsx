"use client";

import { useEffect, useState } from "react";
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
import {
	tauriMoveFile,
	tauriRemoveFile,
	tauriRevealItemInDir,
	tauriSaveDialog,
} from "@/lib/tauri-runtime";
import {
	getExportFileExtension,
	getExportFormatSpec,
	getVideoCodecLabel,
	isAudioOnlyExportFormat,
	listEncodableVideoCodecs,
	listExportFormats,
	parseExportFormat,
	type ExportFormat,
	type ExportVideoCodec,
	type VideoCodecName,
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
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

const AUTO_VIDEO_CODEC = "auto";

/**
 * The codecs on offer for a container, learned by asking the shell's ffmpeg
 * rather than from a table. Which encoders a build carries is a property of
 * the machine, and the library that answers here is the one that will run the
 * encode — so a codec offered cannot fail to open a moment later.
 *
 * The frame size is no longer part of the question. WebCodecs was asked about
 * a whole configuration and could refuse a codec at one resolution and accept
 * it at another; ffmpeg either has the encoder or it does not.
 */
function useEncodableVideoCodecs({
	format,
}: {
	format: ExportFormat;
}): VideoCodecName[] {
	const [codecs, setCodecs] = useState<VideoCodecName[]>([]);

	useEffect(() => {
		// Audio-only containers resolve to an empty list on their own, so there
		// is no branch here that has to set state before the probe returns.
		let cancelled = false;
		void listEncodableVideoCodecs({ format }).then(
			(available) => {
				if (!cancelled) setCodecs(available);
			},
			() => {
				if (!cancelled) setCodecs([]);
			},
		);

		return () => {
			cancelled = true;
		};
	}, [format]);

	return codecs;
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
	const [videoCodec, setVideoCodec] =
		useState<ExportVideoCodec>(AUTO_VIDEO_CODEC);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);

	const audioOnly = isAudioOnlyExportFormat({ format });
	const availableCodecs = useEncodableVideoCodecs({ format });

	const handleFormatChange = ({ value }: { value: string }) => {
		const parsed = parseExportFormat({ value });
		if (!parsed) return;

		setFormat(parsed);
		// Codecs belong to containers: the H.265 that MP4 offers has no meaning
		// in a WebM, so the pick goes back to following the source.
		setVideoCodec(AUTO_VIDEO_CODEC);
	};

	const handleExport = async () => {
		if (!activeProject) return;

		const result = await editor.project.export({
			options: {
				format,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				videoCodec,
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.artifact) {
			const filename = `${activeProject.metadata.name}${getExportFileExtension({ format })}`;

			// The render already wrote a finished file. All that's left is asking
			// where it should live and moving it there — no bytes pass through
			// the page, whatever the export weighs.
			const scratchPath = result.artifact.path;
			try {
				const spec = getExportFormatSpec({ format });
				const destination = await tauriSaveDialog({
					title: "Export project",
					defaultPath: filename,
					filters: [
						{
							name: `${spec.label} ${spec.kind === "audio" ? "audio" : "video"}`,
							extensions: [spec.extension],
						},
					],
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
												onValueChange={(value) =>
													handleFormatChange({ value })
												}
											>
												<FormatOptions kind="video" />
												<p className="text-muted-foreground pt-1 text-xs">
													Audio only
												</p>
												<FormatOptions kind="audio" />
											</RadioGroup>
										</SectionContent>
									</Section>

									{!audioOnly && availableCodecs.length > 0 && (
										<Section collapsible defaultOpen={false}>
											<SectionHeader>
												<SectionTitle>Codec</SectionTitle>
											</SectionHeader>
											<SectionContent>
												<Select
													value={videoCodec}
													onValueChange={(value) => {
														setVideoCodec(
															// Every option is either the sentinel or a codec
															// this container was just probed for, so anything
															// else means the list changed underneath us.
															value === AUTO_VIDEO_CODEC
																? AUTO_VIDEO_CODEC
																: (availableCodecs.find(
																		(codec) => codec === value,
																	) ?? AUTO_VIDEO_CODEC),
														);
													}}
												>
													<SelectTrigger className="w-full">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value={AUTO_VIDEO_CODEC}>
															Auto - match the source
														</SelectItem>
														{availableCodecs.map((codec) => (
															<SelectItem key={codec} value={codec}>
																{getVideoCodecLabel({ codec })}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
											</SectionContent>
										</Section>
									)}

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>Audio</SectionTitle>
										</SectionHeader>
										<SectionContent>
											{audioOnly ? (
												<p className="text-muted-foreground text-xs">
													{getExportFormatSpec({ format }).label} holds sound and
													nothing else, so the audio on the timeline is what gets
													exported.
												</p>
											) : (
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
											)}
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

function FormatOptions({ kind }: { kind: "video" | "audio" }) {
	return (
		<>
			{listExportFormats({ kind }).map(({ format, spec }) => (
				<div key={format} className="flex items-center space-x-2">
					<RadioGroupItem value={format} id={`export-format-${format}`} />
					<Label htmlFor={`export-format-${format}`}>
						{spec.label} - {spec.description}
					</Label>
				</div>
			))}
		</>
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
