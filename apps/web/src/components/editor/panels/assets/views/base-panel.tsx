import { PanelHeader } from "@/components/editor/panels/panel-header";
import { cn } from "@/utils/ui";

interface PanelViewProps extends React.HTMLAttributes<HTMLDivElement> {
	title?: string;
	actions?: React.ReactNode;
	children: React.ReactNode;
	contentClassName?: string;
	scrollClassName?: string;
	hideHeader?: boolean;
	ref?: React.Ref<HTMLDivElement>;
	onScroll?: React.UIEventHandler<HTMLDivElement>;
	scrollRef?: React.Ref<HTMLDivElement>;
}

export function PanelView({
	title,
	actions,
	children,
	className,
	contentClassName,
	scrollClassName,
	hideHeader = false,
	ref,
	onScroll,
	scrollRef,
	...rest
}: PanelViewProps) {
	return (
		<div
			className={cn("relative flex h-full flex-col", className)}
			ref={ref}
			{...rest}
		>
			{!hideHeader && <PanelHeader title={title}>{actions}</PanelHeader>}
			{/*
			 * The scroll box is a flex column so the content wrapper's flex-1 has
			 * something to grow against. Without it the wrapper is height:auto, and
			 * any child asking for h-full (PanelEmptyState) collapses to its own
			 * content height and pins itself to the top of the panel.
			 */}
			<div
				className={cn(
					"scrollbar-hidden flex size-full flex-col overflow-y-auto",
					hideHeader ? "pt-4" : "pt-2",
					scrollClassName,
				)}
				ref={scrollRef}
				onScroll={onScroll}
			>
			<div className={cn("w-full flex-1 px-2 pt-0 pb-2", contentClassName)}>
				{children}
			</div>
			</div>
		</div>
	);
}
