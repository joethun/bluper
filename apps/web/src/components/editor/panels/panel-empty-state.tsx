import type { ComponentType } from "react";
import { cn } from "@/utils/ui";

/**
 * The empty state shared by the editor panels. Each panel previously rolled its
 * own, which drifted apart on spacing, icon treatment and title element; this
 * keeps them identical so switching tabs doesn't shift the layout.
 */
export function PanelEmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: {
	icon: ComponentType<{ className?: string }>;
	title: string;
	description?: string;
	action?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-full flex-col items-center justify-center gap-4 p-4 text-center",
				className,
			)}
		>
			<Icon className="text-muted-foreground size-10" />
			<div className="flex flex-col gap-2">
				<h3 className="text-foreground font-medium">{title}</h3>
				{description ? (
					<p className="text-muted-foreground max-w-44 text-balance text-sm">
						{description}
					</p>
				) : null}
			</div>
			{action}
		</div>
	);
}
