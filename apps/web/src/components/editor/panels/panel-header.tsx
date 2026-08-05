import { SectionTitle } from "@/components/section";
import { cn } from "@/utils/ui";

/**
 * The title bar shared by every editor panel — the asset panels on the left and
 * the inspector tabs on the right. Padding matches SectionHeader (px-3.5) so a
 * panel title lines up with the section titles beneath it, and the title itself
 * uses SectionTitle so typography is identical across both sides. It renders at
 * full contrast because a panel title outranks the section titles below it.
 */
export function PanelHeader({
	title,
	children,
	className,
}: {
	title?: string;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"bg-background border-b h-11 shrink-0 px-3.5 flex items-center justify-between gap-2",
				className,
			)}
		>
			{title ? (
				<SectionTitle className="text-foreground">{title}</SectionTitle>
			) : null}
			{children}
		</div>
	);
}
