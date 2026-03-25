"use client";

import * as React from "react";
import { useEffect, useRef } from "react";
import type { Value } from "platejs";
import type { Column } from "@/types/column";
import { TodoColumn } from "./TodoColumn";
import { cn } from "@/lib/utils";
import { useWelcomeRefsOptional } from "@/contexts/welcome-refs-context";

interface ColumnLayoutProps {
	columns: Column[];
	onAdd: () => void;
	onUpdate: (id: string, value: Value) => void;
	onRemove: (id: string) => void;
	onToggleCollapse: (id: string) => void;
	isColumnOwner?: (columnId: string) => boolean;
	getColumnOwner?: (columnId: string) => string | null;
}

export function ColumnLayout({
	columns,
	onAdd,
	onUpdate,
	onRemove,
	onToggleCollapse,
	isColumnOwner,
	getColumnOwner,
}: ColumnLayoutProps) {
	const canRemove = columns.length > 1;
	const { registerRef } = useWelcomeRefsOptional();
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const firstColumnRef = useRef<HTMLDivElement>(null);

	// Register refs for welcome screen annotations
	useEffect(() => {
		registerRef("add-column-button", addButtonRef.current);
		registerRef("first-column", firstColumnRef.current);
	}, [registerRef]);

	return (
		<div className="flex h-full overflow-x-auto pr-28 scrollbar-hide scroll-pr-28">
			{columns.map((column, index) => (
				<div
					key={column.id}
					ref={index === 0 ? firstColumnRef : undefined}
				>
					<TodoColumn
						column={column}
						onUpdate={onUpdate}
						onRemove={onRemove}
						onToggleCollapse={onToggleCollapse}
						canRemove={canRemove}
						isOwner={isColumnOwner?.(column.id) ?? true}
						sharedBy={getColumnOwner?.(column.id) ?? null}
					/>
				</div>
			))}

			{/* Add column button */}
			<div className="flex h-full w-16 flex-shrink-0 items-start justify-center pt-2">
				<button
					ref={addButtonRef}
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
