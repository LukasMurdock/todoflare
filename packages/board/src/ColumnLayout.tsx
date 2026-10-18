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
	const height = layout === "page" ? "h-full" : "min-h-0 flex-1";
	if (status === "loading") {
		return <div className={cn("flex", height)} aria-busy="true" />;
	}

	return (
		<div className={cn("flex overflow-x-auto pr-28 scrollbar-hide scroll-pr-28", height)}>
			{columns.map((column, index) => (
				<div
					key={column.id}
					data-column-id={column.id}
					data-board-part={index === 0 ? "first-column" : undefined}
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

			{/* Add column button */}
			<div className="flex h-full w-16 flex-shrink-0 items-start justify-center pt-2">
				{onAdd && (
					<button
						data-board-part="add-column"
						onClick={onAdd}
						type="button"
						aria-label="Add column"
						className={cn(
							"flex h-8 w-8 items-center justify-center rounded-md",
							"border border-dashed border-border",
							"text-muted-foreground hover:border-foreground hover:text-foreground",
							"transition-colors"
						)}
						title="Add column"
					>
						<PlusIcon className="h-4 w-4" />
					</button>
				)}
			</div>

			<div className="h-full w-12 flex-shrink-0" aria-hidden="true" />
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
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	);
}
