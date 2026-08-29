import { VideoOffIcon } from "lucide-react";
import { cn } from "@/utils/ui";

/**
 * The placeholder a thumbnail collapses to when the timeline has no image or
 * video on it: a muted panel with a crossed-out camera in the middle. Three
 * surfaces render it — the projects page (when a project's metadata has no
 * thumbnail), the effects tile grid (when the active scene is empty), and the
 * transition tile grid (same condition).
 */
export function NoMediaThumbnail({
	className,
	iconClassName,
}: {
	className?: string;
	iconClassName?: string;
}) {
	return (
		<div
			className={cn(
				"bg-muted/70 relative flex size-full items-center justify-center overflow-hidden",
				className,
			)}
		>
			<VideoOffIcon
				className={cn(
					"text-muted-foreground/60 shrink-0",
					iconClassName,
				)}
			/>
		</div>
	);
}