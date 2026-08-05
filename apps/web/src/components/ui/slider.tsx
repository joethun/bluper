"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/utils/ui";

const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
		className?: string;
		/** CSS background painted across the whole track, e.g. a temperature ramp. */
		trackGradient?: string;
		thumbClassName?: string;
	}
>(({ className, trackGradient, thumbClassName, ...props }, ref) => (
	<SliderPrimitive.Root
		ref={ref}
		className={cn(
			"relative flex w-full touch-none items-center select-none",
			className,
		)}
		{...props}
	>
		<SliderPrimitive.Track
			className={cn(
				"bg-accent relative h-1.5 w-full grow overflow-hidden rounded-full",
				// A gradient can run to white or to the panel's own colour at either
				// end, so the track keeps an outline to stay readable in both themes.
				trackGradient && "ring-border/60 ring-1 ring-inset",
			)}
			style={trackGradient ? { backgroundImage: trackGradient } : undefined}
		>
			{/* A gradient track already shows which way the slider pushes the picture;
			    a solid fill over half of it would hide that. */}
			{!trackGradient && (
				<SliderPrimitive.Range className="bg-primary absolute h-full" />
			)}
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			className={cn(
				"border-primary/50 bg-background focus-visible:ring-ring block size-4 rounded-full border shadow-sm focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50",
				thumbClassName,
			)}
		/>
	</SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
