"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Value } from "platejs";
import { ColumnEditor } from "@/components/board/ColumnEditor";
import type { BoardColumn } from "@/components/board/types";
import { isColumnEmpty } from "@/types/column";
import { cn } from "@/lib/utils";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/confirm-dialog";

export interface TodoColumnProps {
	column: BoardColumn;
	onRemove?: (column: BoardColumn) => void;
	onToggleCollapse?: (column: BoardColumn) => void;
	onContentChange?: (columnId: string, content: Value) => void;
	identity?: { name: string; color: string };
	renderActions?: (column: BoardColumn) => React.ReactNode;
}

export function TodoColumn({
	column,
	onRemove,
	onToggleCollapse,
	onContentChange,
	identity,
	renderActions,
}: TodoColumnProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: column.id });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	const removal = onRemove ? (column.removal ?? "none") : "none";
	const hasContent = column.snapshot !== undefined && !isColumnEmpty({ id: column.id, value: column.snapshot });

	const handleRemove = () => {
		onRemove?.(column);
	};

	const handleToggleCollapse = () => {
		onToggleCollapse?.(column);
	};

	// Collapsed state: narrow column with just drag handle and expand button
	if (column.collapsed) {
		return (
			<div
				ref={setNodeRef}
				style={style}
				className={cn(
					"flex h-full w-10 flex-shrink-0 flex-col border-r border-border bg-background",
					isDragging && "opacity-50"
				)}
			>
				<div className="flex flex-col w-10 items-center gap-1 border-b border-border bg-muted/30 py-2">
					{/* Drag handle */}
					<button
						className="cursor-grab rounded p-1 hover:bg-muted active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{/* Expand button */}
					<button
						onClick={handleToggleCollapse}
						type="button"
						aria-label="Expand column"
						className="rounded p-1 hover:bg-muted"
						title="Expand column"
					>
						<ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
					</button>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex h-full w-80 flex-shrink-0 flex-col border-r border-border bg-background",
				isDragging && "opacity-50"
			)}
		>
			{/* Column header with drag handle, collapse, share, presence, and delete */}
			<div className="flex h-10 flex-shrink-0 items-start justify-between border-b border-border bg-muted/30 px-2 py-2">
				<div className="flex items-center gap-1">
					{/* Drag handle */}
					<button
						className="cursor-grab rounded p-1 hover:bg-muted active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{/* Collapse button */}
					<button
						onClick={handleToggleCollapse}
						type="button"
						aria-label="Collapse column"
						className="rounded p-1 hover:bg-muted"
						title="Collapse column"
					>
						<ChevronLeftIcon className="h-4 w-4 text-muted-foreground" />
					</button>
					{column.label && (
						<span className="text-xs text-muted-foreground px-1">
							{column.label}
						</span>
					)}
				</div>

				<div className="flex items-center gap-1">
					{renderActions?.(column)}

					{/* Delete/Hide button */}
					{removal !== "none" && (
						<>
							{removal === "hide" || !hasContent ? (
								<button
									onClick={handleRemove}
									className="rounded p-1 hover:bg-muted"
									title={removal === "delete" ? "Delete column" : "Hide column"}
								>
									<XIcon className="h-4 w-4 text-muted-foreground" />
								</button>
							) : (
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<button className="rounded p-1 hover:bg-muted">
											<XIcon className="h-4 w-4 text-muted-foreground" />
										</button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												Delete column?
											</AlertDialogTitle>
											<AlertDialogDescription>
												This column has content. This action
												cannot be undone.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>
												Cancel
											</AlertDialogCancel>
											<AlertDialogAction
												onClick={handleRemove}
											>
												Delete
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
						</>
					)}
				</div>
			</div>

			{/* Editor */}
			<div className="flex-1 overflow-hidden">
				<ColumnEditor
					columnId={column.id}
					snapshot={column.snapshot}
					readOnly={column.readOnly ?? false}
					identity={identity}
					onContentChange={onContentChange}
				/>
			</div>
		</div>
	);
}

function GripVerticalIcon({ className }: { className?: string }) {
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
			<circle cx="9" cy="12" r="1" />
			<circle cx="9" cy="5" r="1" />
			<circle cx="9" cy="19" r="1" />
			<circle cx="15" cy="12" r="1" />
			<circle cx="15" cy="5" r="1" />
			<circle cx="15" cy="19" r="1" />
		</svg>
	);
}

function XIcon({ className }: { className?: string }) {
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
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

function ChevronLeftIcon({ className }: { className?: string }) {
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
			<path d="m15 18-6-6 6-6" />
		</svg>
	);
}

function ChevronRightIcon({ className }: { className?: string }) {
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
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}
