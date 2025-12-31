"use client";

import * as React from "react";
import type { Value } from "platejs";
import type { Column } from "@/types/column";
import { TodoColumn } from "./TodoColumn";
import { cn } from "@/lib/utils";

interface ColumnLayoutProps {
	columns: Column[];
	onAdd: () => void;
	onUpdate: (id: string, value: Value) => void;
	onRemove: (id: string) => void;
}

export function ColumnLayout({
	columns,
	onAdd,
	onUpdate,
	onRemove,
}: ColumnLayoutProps) {
	const canRemove = columns.length > 1;

	return (
		<div className="flex h-full overflow-x-auto scrollbar-hide">
			{columns.map((column) => (
				<TodoColumn
					key={column.id}
					column={column}
					onUpdate={onUpdate}
					onRemove={onRemove}
					canRemove={canRemove}
				/>
			))}

			{/* Add column button */}
			<div className="flex h-full w-16 flex-shrink-0 items-start justify-center pt-2">
				<button
					onClick={onAdd}
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
