import { UploadIcon } from "lucide-react";

interface MediaDragOverlayProps {
	isVisible: boolean;
	isProcessing?: boolean;
	progress?: number;
	onClick?: () => void;
}

export function MediaDragOverlay({
	isVisible,
	isProcessing = false,
	progress = 0,
	onClick,
}: MediaDragOverlayProps) {
	if (!isVisible) return null;

	const handleClick = ({
		event,
	}: {
		event: React.MouseEvent<HTMLButtonElement>;
	}) => {
		if (isProcessing || !onClick) return;
		event.preventDefault();
		event.stopPropagation();
		onClick();
	};

	return (
		<button
			className="bg-foreground/5 hover:bg-foreground/10 border-border flex size-full flex-col items-center justify-center gap-3 rounded-md border border-dashed p-8 text-center transition-colors"
			type="button"
			disabled={isProcessing || !onClick}
			onClick={(event) => handleClick({ event })}
		>
			<UploadIcon className="text-muted-foreground size-8" />

			<div className="space-y-1">
				<p className="text-foreground text-sm font-medium">
					{isProcessing ? "Processing your files" : "Drag and drop or click to browse"}
				</p>
				<p className="text-muted-foreground max-w-sm text-xs">
					{isProcessing
						? `${progress}% complete`
						: "Videos, photos, and audio"}
				</p>
			</div>

			{isProcessing && (
				<div className="w-full max-w-xs">
					<div className="bg-muted/50 h-2 w-full overflow-hidden rounded-full">
						<div
							className="bg-primary h-2 rounded-full transition-[width] duration-200 ease-out"
							style={{ width: `${progress}%` }}
						/>
					</div>
				</div>
			)}
		</button>
	);
}
