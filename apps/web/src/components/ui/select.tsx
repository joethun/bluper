"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/utils/ui";
import { useOverlayOpenChange } from "./use-overlay-open-change";

function Select({
	open,
	onOpenChange,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
	const handleOpenChange = useOverlayOpenChange({
		open,
		onOpenChange,
	});
	return (
		<SelectPrimitive.Root
			open={open}
			onOpenChange={handleOpenChange}
			{...props}
		/>
	);
}

const SelectValue = SelectPrimitive.Value;

const selectItemVariants = cva(
	"relative flex cursor-pointer select-none items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-foreground/85 outline-hidden data-[highlighted]:bg-popover-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "",
				destructive:
					"text-destructive data-[highlighted]:bg-destructive/5 data-[highlighted]:text-destructive",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

const selectTriggerVariants = cva(
	"border-border ring-offset-background placeholder:text-muted-foreground flex h-7 w-auto cursor-pointer items-center justify-between gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap transition-none focus:border-primary focus:ring-0 focus:ring-primary/10 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
	{
		variants: {
			variant: {
				default: "bg-accent",
				outline: "bg-background hover:bg-accent/50",
			},
			size: {
				default: "",
				sm: "rounded-sm",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

const SelectTrigger = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> &
		VariantProps<typeof selectTriggerVariants> & {
			icon?: React.ReactNode;
		}
>(({ className, children, icon, variant, size, ...props }, ref) => (
	<SelectPrimitive.Trigger
		ref={ref}
		className={cn(selectTriggerVariants({ variant, size }), className)}
		{...props}
	>
		<div className="flex items-center gap-1.5">
			{icon && (
				<span className="text-muted-foreground [&_svg]:size-3.5 shrink-0">
					{icon}
				</span>
			)}
			{children}
		</div>
		<SelectPrimitive.Icon asChild>
			<ChevronDownIcon className="size-3.5" />
		</SelectPrimitive.Icon>
	</SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollUpButton
		ref={ref}
		className={cn(
			"flex cursor-default items-center justify-center py-1",
			className,
		)}
		{...props}
	>
		<ChevronUpIcon className="size-4" />
	</SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.ScrollDownButton
		ref={ref}
		className={cn(
			"flex cursor-default items-center justify-center py-1",
			className,
		)}
		{...props}
	>
		<ChevronDownIcon className="size-4" />
	</SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName =
	SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			ref={ref}
			className={cn(
				"bg-popover text-popover-foreground z-50 max-h-(--radix-select-content-available-height) min-w-32 overflow-hidden rounded-md border p-1 shadow-lg",
				className,
			)}
			position={position}
			onCloseAutoFocus={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			{...props}
		>
			<SelectScrollUpButton />
			<SelectPrimitive.Viewport
				className={cn(
					position === "popper" &&
						"h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)",
				)}
			>
				{children}
			</SelectPrimitive.Viewport>
			<SelectScrollDownButton />
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
		variant?: VariantProps<typeof selectItemVariants>["variant"];
	}
>(({ className, children, variant = "default", ...props }, ref) => (
	<SelectPrimitive.Item
		ref={ref}
		className={cn(selectItemVariants({ variant }), "pl-2 pr-6", className)}
		{...props}
	>
		<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		{/* The gutter is reserved by `pr-6` whether or not this item is the selected
		    one, so labels stay put instead of shifting when the selection moves. */}
		<span className="absolute right-1.5 flex size-3.5 items-center justify-center">
			<SelectPrimitive.ItemIndicator>
				<CheckIcon className="size-3.5" />
			</SelectPrimitive.ItemIndicator>
		</span>
	</SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Separator
		ref={ref}
		className={cn("bg-border mx-1 my-1 h-px", className)}
		{...props}
	/>
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
	Select,
	SelectValue,
	SelectTrigger,
	SelectContent,
	SelectItem,
	SelectSeparator,
};
