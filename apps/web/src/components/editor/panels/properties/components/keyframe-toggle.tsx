import { Button } from "@/components/ui/button";
import { DiamondIcon } from "lucide-react";
import { cn } from "@/utils/ui";

/**
 * Three states, because two couldn't distinguish "this property isn't animated"
 * from "it is animated, the playhead just isn't on a keyframe":
 *
 *   filled   - a keyframe sits at the playhead; clicking removes it
 *   outlined - the property is animated elsewhere; clicking adds one here
 *   muted    - no keyframes at all; clicking starts animating the property
 */
export function KeyframeToggle({
	isActive,
	isAnimated = false,
	isDisabled = false,
	label,
	onToggle,
}: {
	isActive: boolean;
	isAnimated?: boolean;
	isDisabled?: boolean;
	label: string;
	onToggle: () => void;
}) {
	const title = isDisabled
		? `Move the playhead over this clip to keyframe ${label}`
		: isActive
			? `Remove ${label} keyframe at playhead`
			: `Add ${label} keyframe at playhead`;

	return (
		<Button
			variant="text"
			aria-pressed={isActive}
			disabled={isDisabled}
			title={title}
			aria-label={title}
			onClick={onToggle}
			className="[&>svg]:size-3.5 mb-0.5"
		>
			<DiamondIcon
				className={cn(
					isActive && "text-primary fill-primary",
					!isActive && isAnimated && "text-primary",
					!isActive && !isAnimated && "text-muted-foreground",
				)}
			/>
		</Button>
	);
}
