"use client";

import * as React from "react";
import type { Value } from "platejs";
import type { BoardColumn } from "./types";
import { TodoColumn } from "./TodoColumn";
import { cn } from "./ui/cn";

interface ColumnLayoutProps {
	/** "loading" renders no columns and no add button until the host knows which columns exist. */
	status?: "loading" | "ready";
	layout?: "fill" | "page";
	columns: readonly BoardColumn[];
	onAdd?: () => void;
	onRemove?: (column: BoardColumn) => void;
	onToggleCollapse?: (column: BoardColumn) => void;
	onContentChange?: (columnId: string, content: Value) => void;
	identity?: { name: string; color: string };
	renderColumnActions?: (column: BoardColumn) => React.ReactNode;
}

export function ColumnLayout({
	status = "ready",
	layout = "fill",
	columns,
	onAdd,
	onRemove,
	onToggleCollapse,
	onContentChange,
	identity,
	renderColumnActions,
}: ColumnLayoutProps) {
	// "page" grows with the page but never stops short of the viewport, so
	// column hairlines, collapsed rails and the add gutter run to the bottom.
	const height = layout === "page" ? "h-full min-h-dvh" : "min-h-0 flex-1";
	if (status === "loading") {
		return <div className={cn("flex", height)} aria-busy="true" />;
	}

	return (
		<div
			className={cn(
				"flex overflow-x-auto pr-28 scrollbar-hide scroll-pr-28",
				"max-sm:snap-x max-sm:snap-proximity max-sm:scroll-px-3",
				height
			)}
		>
			{columns.map((column, index) => (
				<div
					key={column.id}
					data-column-id={column.id}
					data-board-part={index === 0 ? "first-column" : undefined}
					className="flex shrink-0 max-sm:snap-start"
				>
					<TodoColumn
						column={column}
						onRemove={onRemove}
						onToggleCollapse={onToggleCollapse}
						onContentChange={onContentChange}
						identity={identity}
						renderActions={renderColumnActions}
					/>
				</div>
			))}

			{/* Add column button, centred on the h-10 column header */}
			<div className="flex w-16 shrink-0 items-start justify-center pt-1">
				{onAdd && (
					<button
						data-board-part="add-column"
						onClick={onAdd}
						type="button"
						aria-label="Add column"
						className={cn(
							"grid size-8 place-items-center rounded-lg",
							"border border-border bg-background text-muted-foreground shadow-raised",
							"hover:-translate-y-px hover:border-foreground/20 hover:text-foreground",
							"active:translate-y-0 active:scale-[0.96]",
							"transition-[color,border-color,transform,box-shadow] duration-150 ease-out-quint",
							"[&_svg]:transition-transform [&_svg]:duration-300 [&_svg]:ease-spring hover:[&_svg]:rotate-90",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						)}
						title="Add column"
					>
						<PlusIcon className="size-4" />
					</button>
				)}
			</div>

			<div className="w-12 shrink-0" aria-hidden="true" />
		</div>
	);
}


function PlusIcon({ className }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	);
}
