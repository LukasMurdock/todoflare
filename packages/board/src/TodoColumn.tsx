"use client";

import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Value } from "platejs";
import { ColumnEditor } from "./ColumnEditor";
import { useBoardContext } from "./board-context";
import type { BoardColumn } from "./types";
import { isEmptyContent } from "./content";
import { cn } from "./ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./ui/confirm-dialog";

// Board-owned header controls: quiet at rest, full contrast when the column is
// hovered or holds focus, and always on touch, where there is no hover.
const columnButton = cn(
	"grid size-7 place-items-center rounded-md text-muted-foreground opacity-45 max-sm:size-8",
	"transition-[opacity,background-color,color,transform] duration-150",
	"hover:bg-foreground/[0.06] hover:text-foreground active:scale-95",
	"group-hover/column:opacity-100 group-focus-within/column:opacity-100 pointer-coarse:opacity-100",
	"focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
);

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

	const { getEditorContent } = useBoardContext();
	const removal = onRemove ? (column.removal ?? "none") : "none";

	const handleRemove = () => {
		onRemove?.(column);
	};
	// Controlled rather than a Radix Trigger: the trigger's useId-based
	// aria-controls would differ between a server render and island hydration.
	const [confirmOpen, setConfirmOpen] = React.useState(false);
	const [contentKnown, setContentKnown] = React.useState(true);

	// Decided on click from the live document: hosts that sync through Yjs pass
	// no snapshot. Content we cannot see yet counts as content.
	const handleRemoveClick = () => {
		const content = getEditorContent(column.id) ?? column.snapshot;
		if (removal === "delete" && (content === undefined || !isEmptyContent(content))) {
			setContentKnown(content !== undefined);
			setConfirmOpen(true);
		} else {
			handleRemove();
		}
	};

	const handleToggleCollapse = () => {
		onToggleCollapse?.(column);
	};

	// Collapsed state: a full-height rail. The expand button's ::after covers
	// the whole rail, so a click anywhere expands it; the grip sits above it.
	if (column.collapsed) {
		return (
			<div
				ref={setNodeRef}
				style={style}
				className={cn(
					"group/column relative flex h-full w-10 shrink-0 flex-col items-center gap-1 border-r border-hairline bg-background py-1.5",
					"transition-colors hover:bg-foreground/[0.025]",
					isDragging && "z-10 shadow-pop outline-1 outline-brand/40"
				)}
			>
				{/* Drag handle */}
				<button
					type="button"
					aria-label="Reorder column"
					className={cn(columnButton, "relative z-10 cursor-grab active:cursor-grabbing")}
					{...attributes}
					{...listeners}
				>
					<GripVerticalIcon className="size-4" />
				</button>
				{/* Expand button */}
				<button
					onClick={handleToggleCollapse}
					type="button"
					aria-label="Expand column"
					className={cn(columnButton, "after:absolute after:inset-0 after:content-['']")}
					title="Expand column"
				>
					<ChevronRightIcon className="size-4" />
				</button>
			</div>
		);
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"group/column flex h-full w-80 shrink-0 flex-col border-r border-hairline bg-background max-sm:w-[calc(100vw-2.5rem)]",
				isDragging && "relative z-10 shadow-pop outline-1 outline-brand/40"
			)}
		>
			{/* Column header with drag handle, collapse, share, presence, and delete */}
			<div className="flex h-10 shrink-0 items-center justify-between border-b border-hairline bg-transparent px-1.5">
				<div className="flex items-center gap-0.5">
					{/* Drag handle */}
					<button
						type="button"
						aria-label="Reorder column"
						className={cn(columnButton, "cursor-grab active:cursor-grabbing")}
						{...attributes}
						{...listeners}
					>
						<GripVerticalIcon className="size-4" />
					</button>
					{/* Collapse button */}
					<button
						onClick={handleToggleCollapse}
						type="button"
						aria-label="Collapse column"
						className={columnButton}
						title="Collapse column"
					>
						<ChevronLeftIcon className="size-4" />
					</button>
					{column.label && (
						<span className="px-1 text-xs text-muted-foreground">
							{column.label}
						</span>
					)}
				</div>

				<div className="flex items-center gap-1">
					{/* Host actions stay at full contrast: status, presence, agents. */}
					<div className="flex items-center gap-1">{renderActions?.(column)}</div>

					{/* Delete/Hide button */}
					{removal !== "none" && (
						<>
							<button
								type="button"
								aria-label={removal === "delete" ? "Delete column" : "Hide column"}
								title={removal === "delete" ? "Delete column" : "Hide column"}
								aria-haspopup={removal === "delete" ? "dialog" : undefined}
								aria-expanded={removal === "delete" ? confirmOpen : undefined}
								onClick={handleRemoveClick}
								className={columnButton}
							>
								<XIcon className="size-4" />
							</button>
							{removal === "delete" && (
								<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Delete column?</AlertDialogTitle>
											<AlertDialogDescription>
												{contentKnown ? "This column has content." : "This column may have content."}{" "}
												{column.deleteNotice ?? "This action cannot be undone."}
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction onClick={handleRemove}>Delete</AlertDialogAction>
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
			strokeWidth="1.75"
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
			strokeWidth="1.75"
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
			strokeWidth="1.75"
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
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}
