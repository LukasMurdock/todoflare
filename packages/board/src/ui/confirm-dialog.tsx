"use client";

import React from "react";
import { Action as AlertDialogPrimitiveAction, Cancel as AlertDialogPrimitiveCancel, Content as AlertDialogPrimitiveContent, Description as AlertDialogPrimitiveDescription, Overlay as AlertDialogPrimitiveOverlay, Portal as AlertDialogPrimitivePortal, Root as AlertDialogPrimitiveRoot, Title as AlertDialogPrimitiveTitle, Trigger as AlertDialogPrimitiveTrigger } from "@radix-ui/react-alert-dialog";
import { cn } from "./cn";
import { usePortalContainer } from "../portal-container";

const AlertDialog = AlertDialogPrimitiveRoot;
const AlertDialogTrigger = AlertDialogPrimitiveTrigger;
const AlertDialogPortal = AlertDialogPrimitivePortal;

const AlertDialogOverlay = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveOverlay>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveOverlay>
>(({ className, ...props }, ref) => (
	<AlertDialogPrimitiveOverlay
		className={cn(
			"fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px] dark:bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
			className
		)}
		{...props}
		ref={ref}
	/>
));
AlertDialogOverlay.displayName = AlertDialogPrimitiveOverlay.displayName;

const AlertDialogContent = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveContent>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveContent>
>(({ className, ...props }, ref) => (
	<AlertDialogPortal container={usePortalContainer()}>
		<AlertDialogOverlay />
		<AlertDialogPrimitiveContent
			ref={ref}
			className={cn(
				"fixed left-[50%] top-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-hairline bg-background p-6 shadow-pop duration-200 ease-out-quint outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] sm:max-w-[400px]",
				className
			)}
			{...props}
		/>
	</AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitiveContent.displayName;

const AlertDialogHeader = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex flex-col space-y-2 text-center sm:text-left",
			className
		)}
		{...props}
	/>
);
AlertDialogHeader.displayName = "AlertDialogHeader";

const AlertDialogFooter = ({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
			className
		)}
		{...props}
	/>
);
AlertDialogFooter.displayName = "AlertDialogFooter";

const AlertDialogTitle = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveTitle>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveTitle>
>(({ className, ...props }, ref) => (
	<AlertDialogPrimitiveTitle
		ref={ref}
		className={cn("text-base font-semibold tracking-[-0.01em]", className)}
		{...props}
	/>
));
AlertDialogTitle.displayName = AlertDialogPrimitiveTitle.displayName;

const AlertDialogDescription = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveDescription>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveDescription>
>(({ className, ...props }, ref) => (
	<AlertDialogPrimitiveDescription
		ref={ref}
		className={cn("text-sm text-muted-foreground", className)}
		{...props}
	/>
));
AlertDialogDescription.displayName =
	AlertDialogPrimitiveDescription.displayName;

const AlertDialogAction = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveAction>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveAction>
>(({ className, ...props }, ref) => (
	<AlertDialogPrimitiveAction
		ref={ref}
		className={cn(
			"inline-flex h-9 items-center justify-center rounded-lg bg-destructive px-4 py-2 text-sm font-semibold shadow-raised active:scale-[0.98] transition-[background-color,transform] text-destructive-foreground ring-offset-background hover:bg-destructive/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
			className
		)}
		{...props}
	/>
));
AlertDialogAction.displayName = AlertDialogPrimitiveAction.displayName;

const AlertDialogCancel = React.forwardRef<
	React.ElementRef<typeof AlertDialogPrimitiveCancel>,
	React.ComponentPropsWithoutRef<typeof AlertDialogPrimitiveCancel>
>(({ className, ...props }, ref) => (
	<AlertDialogPrimitiveCancel
		ref={ref}
		className={cn(
			"mt-2 inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background shadow-raised active:scale-[0.98] transition-[background-color,color,transform] px-4 py-2 text-sm font-semibold ring-offset-background hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 sm:mt-0",
			className
		)}
		{...props}
	/>
));
AlertDialogCancel.displayName = AlertDialogPrimitiveCancel.displayName;

export {
	AlertDialog,
	AlertDialogPortal,
	AlertDialogOverlay,
	AlertDialogTrigger,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogAction,
	AlertDialogCancel,
};
