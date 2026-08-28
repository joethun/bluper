import { cva, type VariantProps } from "class-variance-authority";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "@/utils/ui";

const TooltipProvider = TooltipPrimitive.Provider;

/**
 * The one hover delay, set on the root provider in `app/layout.tsx`. Every
 * tooltip in the app is the label for an icon-only control, so there is no
 * reason for one toolbar to answer faster than another — and the editor had
 * drifted to five different delays (0 on the properties rail, 10 on the assets
 * rail, 200 on the timeline toolbar, 300 in Adjust/Effects, the Radix default
 * of 700 everywhere else). Radix's `skipDelayDuration` still makes the second
 * and subsequent tooltips instant while sweeping across a row, so this is the
 * cost of the first hover only.
 *
 * Set it here rather than per-provider: a nested `TooltipProvider` overrides
 * the root even when it declares no delay of its own, which is how the assets
 * panel silently fell back to 700.
 */
export const TOOLTIP_DELAY_MS = 300;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const tooltipVariants = cva(
	"z-50 overflow-visible rounded-sm text-sm shadow-md",
	{
		variants: {
			variant: {
				default: "bg-popover text-popover-foreground border px-3 py-1.5",
				destructive:
					"bg-destructive/10 text-destructive dark:bg-destructive/20 border-destructive [border-width:0.5px]",
				outline: "border-border",
				important:
					"bg-amber-100/90 text-amber-900 dark:bg-amber-900/20 dark:text-amber-300 border-amber-900 [border-width:0.5px]",
				promotions:
					"bg-red-100/90 text-redb-900 dark:bg-red-900/20 dark:text-red-300 border-red-900 [border-width:0.5px]",
				personal:
					"bg-green-100/90 text-green-900 dark:bg-green-900/20 dark:text-green-300 border-green-900 [border-width:0.5px]",
				updates:
					"bg-purple-100/90 text-purple-900 dark:bg-purple-900/20 dark:text-purple-300 border-purple-900 [border-width:0.5px]",
				forums:
					"bg-blue-100/90 text-blue-900 dark:bg-blue-900/20 dark:text-blue-300 border-blue-900 [border-width:0.5px]",
				sidebar: "bg-white dark:bg-[#413F3E] p-2.5 flex flex-col gap-2",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

interface TooltipContentProps
	extends
		React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>,
		VariantProps<typeof tooltipVariants> {}

const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	TooltipContentProps
>(({ className, sideOffset = 4, variant, ...props }, ref) => (
	<TooltipPrimitive.Content
		ref={ref}
		sideOffset={sideOffset}
		className={cn(tooltipVariants({ variant }), className)}
		{...props}
	>
		{variant === "sidebar" && (
			<svg
				width="6"
				height="10"
				viewBox="0 0 6 10"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				className="absolute top-1/2 left-[-6px] -translate-y-1/2"
				aria-hidden="true"
			>
				<path
					d="M6 0L0 5L6 10V0Z"
					className="fill-white/80 dark:fill-[#413F3E]"
				/>
			</svg>
		)}
		{props.children}
	</TooltipPrimitive.Content>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
