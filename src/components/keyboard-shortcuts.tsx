"use client";

import * as React from "react";
import {
	useKeyboardShortcut,
	getModifierSymbol,
} from "@/hooks/useKeyboardShortcut";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ShortcutItem {
	keys: React.ReactNode[];
	description: string;
}

interface ShortcutSection {
	title: string;
	shortcuts: ShortcutItem[];
}

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
				"inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground",
				className
			)}
		>
			{children}
		</kbd>
	);
}

function ShortcutRow({ keys, description }: ShortcutItem) {
	return (
		<div className="flex items-center justify-between py-1.5">
			<span className="text-sm text-foreground">{description}</span>
			<div className="flex items-center gap-1">
				{keys.map((key, index) => (
					<React.Fragment key={index}>
						{index > 0 && (
							<span className="text-muted-foreground text-xs">
								+
							</span>
						)}
						<Kbd>{key}</Kbd>
					</React.Fragment>
				))}
			</div>
		</div>
	);
}

function ShortcutSectionComponent({ title, shortcuts }: ShortcutSection) {
	return (
		<div className="space-y-1">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{title}
			</h3>
			<div className="divide-y divide-border/50">
				{shortcuts.map((shortcut, index) => (
					<ShortcutRow key={index} {...shortcut} />
				))}
			</div>
		</div>
	);
}

export function KeyboardShortcuts() {
	const [open, setOpen] = React.useState(false);
	const mod = getModifierSymbol();

	useKeyboardShortcut({
		key: "/",
		modifiers: ["mod"],
		onTrigger: React.useCallback(() => setOpen((prev) => !prev), []),
	});

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
			{/* Floating button */}
			<button
				onClick={() => setOpen(true)}
				className={cn(
					"fixed bottom-4 left-4 z-50",
					"flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 py-2 shadow-sm backdrop-blur-sm",
					"text-muted-foreground transition-all hover:bg-muted hover:text-foreground",
					"focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
				)}
				aria-label="Keyboard shortcuts"
			>
				<Kbd>{mod}</Kbd>
				<span className="text-muted-foreground text-xs">+</span>
				<Kbd>/</Kbd>
			</button>

			{/* Dialog */}
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Keyboard Shortcuts</DialogTitle>
					</DialogHeader>
					<div className="space-y-6 pt-2">
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
