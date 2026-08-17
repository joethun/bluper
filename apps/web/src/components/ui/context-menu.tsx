"use client";

import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon } from "lucide-react";
import { cn } from "@/utils/ui";
import { useOverlayOpenChange } from "./use-overlay-open-change";

function ContextMenu({
	onOpenChange,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
	const handleOpenChange = useOverlayOpenChange({
		onOpenChange,
	});
	return (
		<ContextMenuPrimitive.Root onOpenChange={handleOpenChange} {...props} />
	);
}

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

// Every leading glyph — icon, check, radio dot — renders in this fixed 16px box
// so labels line up at the same x across item types, and `items-center` on the
// row keeps the glyph on the text's optical center.
const contextMenuIconSlot =
	"flex size-4 shrink-0 items-center justify-center [&>svg]:size-4 [&>svg]:shrink-0";

// Trailing shortcut hint. leading-none collapses the hint's own half-leading so
// `items-center` lands it on the label's centre; the margin nudge it used to
// carry is what left it riding 2px high.
const contextMenuShortcutClass =
	"ml-auto pl-4 text-[0.6rem] leading-none tracking-widest text-muted-foreground/80";

const contextMenuItemVariants = cva(
	// px-2 + a 16px icon slot + gap-2 puts every label at 32px from the row's
	// left edge, which is exactly what `inset` (pl-8) reproduces for iconless
	// items.
	// Icon sizing matches dropdown-menu so the two menus read as one component.
	// Scoped to direct children so the check/radio indicators keep their own size.
	"relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground/85 outline-hidden data-disabled:pointer-events-none data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"focus:bg-accent focus:text-accent-foreground [&_svg]:text-muted-foreground",
				destructive:
					"text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

const ContextMenuContent = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content> & {
		container?: HTMLElement | null;
	}
>(({ className, container, ...props }, ref) => (
	<ContextMenuPrimitive.Portal container={container ?? undefined}>
		<ContextMenuPrimitive.Content
			ref={ref}
			className={cn(
				"bg-popover text-popover-foreground z-50 min-w-48 overflow-hidden rounded-md border shadow-xl p-1",
				className,
			)}
			{...props}
		/>
	</ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

const ContextMenuItem = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
		inset?: boolean;
		variant?: VariantProps<typeof contextMenuItemVariants>["variant"];
		icon?: React.ReactNode;
		textRight?: string;
	}
>(
	(
		{
			className,
			inset,
			variant = "default",
			icon,
			children,
			textRight,
			...props
		},
		ref,
	) => {
		return (
			<ContextMenuPrimitive.Item
				ref={ref}
				className={cn(
					contextMenuItemVariants({ variant }),
					// Only iconless items need the manual inset; an icon fills the
					// slot that produces the same label offset.
					inset && !icon && "pl-8",
					className,
				)}
				{...props}
			>
				{icon && (
					<span className={cn(contextMenuIconSlot, "text-muted-foreground")}>
						{icon}
					</span>
				)}
				{children}
				{textRight && (
					<span className={contextMenuShortcutClass}>{textRight}</span>
				)}
			</ContextMenuPrimitive.Item>
		);
	},
);
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

const ContextMenuCheckboxItem = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & {
		variant?: VariantProps<typeof contextMenuItemVariants>["variant"];
		icon?: React.ReactNode;
	}
>(
	(
		{ className, children, checked, variant = "default", icon, ...props },
		ref,
	) => (
		<ContextMenuPrimitive.CheckboxItem
			ref={ref}
			className={cn(contextMenuItemVariants({ variant }), className)}
			checked={checked}
			{...props}
		>
			<span className={contextMenuIconSlot}>
				<ContextMenuPrimitive.ItemIndicator>
					<CheckIcon className="size-4" />
				</ContextMenuPrimitive.ItemIndicator>
			</span>
			{icon && (
				<span className={cn(contextMenuIconSlot, "text-muted-foreground")}>
					{icon}
				</span>
			)}
			{children}
		</ContextMenuPrimitive.CheckboxItem>
	),
);
ContextMenuCheckboxItem.displayName =
	ContextMenuPrimitive.CheckboxItem.displayName;

const ContextMenuSeparator = React.forwardRef<
	React.ElementRef<typeof ContextMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<ContextMenuPrimitive.Separator
		ref={ref}
		className={cn("bg-border mx-1 my-1.5 h-px", className)}
		{...props}
	/>
));
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
	ContextMenu,
	ContextMenuTrigger,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuCheckboxItem,
	ContextMenuSeparator,
};
