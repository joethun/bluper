"use client";

import { useMemo, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	describeExportResolution,
	getExportResolutionKey,
	getExportResolutionLabel,
	listProjectExportResolutions,
} from "@/export";
import { ArrowUpFromLineIcon, DownloadIcon } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEditor } from "@/editor/use-editor";

/**
 * Starts an export and gets out of the way.
 *
 * Everything after the click — progress, the render as it is written, the
 * failure, where the file ends up — belongs to `ExportScreen`, which covers the
 * editor for as long as the export lasts. This is only the question that has to
 * be answered before the render can start.
 */
export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	return (
		<Popover open={isExportPopoverOpen} onOpenChange={setIsExportPopoverOpen}>
			<PopoverTrigger asChild>
				<Button
					size="sm"
					disabled={!hasProject}
					className="bg-primary text-primary-foreground hover:bg-primary/90 h-8 gap-1.5 px-3"
					aria-label="Export project"
				>
					<ArrowUpFromLineIcon />
					Export
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

	const handleExport = () => {
		// Deliberately not awaited. `export` marks the session as running before
		// it yields, so the screen is already up by the time this returns, and it
		// is the screen that reads the result — awaiting here would tie the run
		// to a popover that has just closed.
		void editor.project.export({
			options: { resolution, fps: activeProject.settings.fps },
		});
		onOpenChange(false);
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			<div className="flex items-center justify-between border-b p-3">
				<h3 className="text-sm font-medium">Export project</h3>
			</div>

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
		</PopoverContent>
	);
}
