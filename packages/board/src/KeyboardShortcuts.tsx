"use client";

import * as React from "react";
import { useModifierSymbol } from "./platform";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { cn } from "./ui/cn";

interface ShortcutItem {
	keys: React.ReactNode[];
	description: string;
}

interface ShortcutSection {
	title: string;
	shortcuts: ShortcutItem[];
}

// A sculpted keycap: a faint top-to-bottom gradient with a pressed-in bottom lip.
function Kbd({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-gradient-to-b from-background to-muted px-1",
				"font-sans text-[11px] font-medium tabular-nums text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]",
				className
			)}
		>
			{children}
		</kbd>
	);
}

function ShortcutRow({ keys, description }: ShortcutItem) {
	return (
		<div className="flex h-9 items-center justify-between gap-4 px-5">
			<span className="text-sm text-foreground">{description}</span>
			<div className="flex items-center gap-1">
				{keys.map((key, index) => (
					<Kbd key={index}>{key}</Kbd>
				))}
			</div>
		</div>
	);
}

function ShortcutSectionComponent({ title, shortcuts }: ShortcutSection) {
	return (
		<div className="py-3">
			<h3 className="px-5 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
				{title}
			</h3>
			<div className="divide-y divide-hairline">
				{shortcuts.map((shortcut, index) => (
					<ShortcutRow key={index} {...shortcut} />
				))}
			</div>
		</div>
	);
}

/** The shortcuts button and help dialog; the board owns the open state and the Mod+/ shortcut. */
export function KeyboardShortcuts({
	open,
	onOpenChange,
	button = "board",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	button?: "board" | "viewport" | "none";
}) {
	const mod = useModifierSymbol();

	const sections: ShortcutSection[] = [
		// {
		// 	title: "Formatting",
		// 	shortcuts: [
		// 		{ keys: [mod, "B"], description: "Bold" },
		// 		{ keys: [mod, "I"], description: "Italic" },
		// 		{ keys: [mod, "U"], description: "Underline" },
		// 		{ keys: [mod, "Shift", "X"], description: "Strikethrough" },
		// 		{ keys: [mod, "Shift", "H"], description: "Highlight" },
		// 	],
		// },
		{
			title: "Lists",
			shortcuts: [
				{ keys: [mod, "E"], description: "Rotate list type" },
				{ keys: [mod, "Enter"], description: "Toggle todo complete" },
			],
		},
		{
			title: "Markdown Shortcuts",
			shortcuts: [
				{ keys: ["#", "Space"], description: "Heading 1" },
				{ keys: ["##", "Space"], description: "Heading 2" },
				{ keys: ["###", "Space"], description: "Heading 3" },
				{ keys: ["-", "Space"], description: "Bullet list" },
				{ keys: ["*", "Space"], description: "Bullet list" },
				{ keys: ["1.", "Space"], description: "Numbered list" },
				{ keys: ["- []", "Space"], description: "Todo (unchecked)" },
				{ keys: ["- [x]", "Space"], description: "Todo (checked)" },
			],
		},
		{
			title: "General",
			shortcuts: [
				{ keys: [mod, "/"], description: "Show keyboard shortcuts" },
			],
		},
	];

	return (
		<>
			{/* Floating button: Mod / on a keyboard, ? on touch. */}
			{button !== "none" && (
				<button
					data-board-part="shortcuts-button"
					onClick={() => onOpenChange(true)}
					className={cn(
						button === "viewport" ? "fixed bottom-4 left-4 z-50" : "absolute bottom-4 left-4 z-50",
						"flex h-8 items-center gap-1 rounded-full border border-hairline bg-background/80 px-2 shadow-raised backdrop-blur-md",
						"text-muted-foreground hover:-translate-y-px hover:text-foreground hover:shadow-pop",
						"transition-[transform,box-shadow,color] duration-200 ease-out-quint",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					)}
					aria-label="Keyboard shortcuts"
				>
					<span className="flex items-center gap-1 pointer-coarse:hidden">
						<Kbd>{mod}</Kbd>
						<Kbd>/</Kbd>
					</span>
					<span className="hidden pointer-coarse:inline-flex">
						<Kbd>?</Kbd>
					</span>
				</button>
			)}

			{/* Dialog */}
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-h-[85vh] gap-0 overflow-y-auto rounded-xl p-0 shadow-pop sm:max-w-[400px]">
					<DialogHeader className="border-b border-hairline px-5 py-4">
						<DialogTitle className="text-[15px] font-semibold tracking-[-0.01em]">Keyboard Shortcuts</DialogTitle>
					</DialogHeader>
					<div className="divide-y divide-hairline pb-1">
						{sections.map((section) => (
							<ShortcutSectionComponent
								key={section.title}
								{...section}
							/>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
