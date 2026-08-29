"use client";

import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/utils/ui";
import { useOverlayOpenChange } from "./use-overlay-open-change";

function DropdownMenu({
	open,
	onOpenChange,
	...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
	const handleOpenChange = useOverlayOpenChange({
		open,
		onOpenChange,
	});
	return (
		<DropdownMenuPrimitive.Root
			open={open}
			onOpenChange={handleOpenChange}
			{...props}
		/>
	);
}

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const dropdownMenuItemVariants = cva(
	"relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-foreground/85 outline-hidden data-[highlighted]:bg-popover-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
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

const DropdownMenuContent = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
	<DropdownMenuPrimitive.Portal>
		<DropdownMenuPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			onCloseAutoFocus={(e) => {
				e.stopPropagation();
				e.preventDefault();
			}}
			className={cn(
				"group/menu bg-popover text-popover-foreground z-50 min-w-32 overflow-hidden rounded-md border p-1 shadow-lg",
				className,
			)}
			{...props}
		/>
	</DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
		inset?: boolean;
		icon?: React.ReactNode;
		variant?: VariantProps<typeof dropdownMenuItemVariants>["variant"];
	}
>(
	(
		{
			className,
			inset,
			icon,
			variant = "default",
			children,
			asChild,
			...props
		},
		ref,
	) => {
		const iconSlot = (
			<span className="hidden size-4 shrink-0 items-center justify-center group-has-data-has-icon/menu:flex">
				{icon}
			</span>
		);

		const renderedChildren =
			asChild && React.isValidElement(children) ? (
				React.cloneElement(
					children as React.ReactElement<{ children?: React.ReactNode }>,
					{},
					iconSlot,
					(children as React.ReactElement<{ children?: React.ReactNode }>).props
						.children,
				)
			) : (
				<>
					{iconSlot}
					{children}
				</>
			);

		return (
			<DropdownMenuPrimitive.Item
				ref={ref}
				asChild={asChild}
				data-has-icon={icon ? "" : undefined}
				className={cn(
					dropdownMenuItemVariants({ variant }),
					inset && "pl-8",
					className,
				)}
				{...props}
			>
				{renderedChildren}
			</DropdownMenuPrimitive.Item>
		);
	},
);
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuLabel = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
	<DropdownMenuPrimitive.Label
		ref={ref}
		className={cn(
			"text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium",
			className,
		)}
		{...props}
	/>
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
	React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<DropdownMenuPrimitive.Separator
		ref={ref}
		className={cn("bg-border mx-1 my-1.5 h-px", className)}
		{...props}
	/>
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
};
