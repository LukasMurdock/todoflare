"use client";

import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Value } from "platejs";
import type { Column } from "@/types/column";
import { ColumnEditor } from "@/components/board/ColumnEditor";
import { isColumnEmpty } from "@/types/column";
import { cn } from "@/lib/utils";
import { displayAccountId, getAccountColor, truncateAccountId } from "@/lib/account";
import { useSyncContext } from "@/contexts/sync-context";
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
import { ShareMenu } from "@/components/column/ShareMenu";
import { PresenceAvatars } from "@/components/column/PresenceAvatars";
import { useAccount } from "@/hooks/useAccount";

export interface TodoColumnProps {
	column: Column;
	onUpdate: (id: string, value: Value) => void;
	onRemove: (id: string) => void;
	onToggleCollapse: (id: string) => void;
	canRemove: boolean;
	isOwner?: boolean;
	sharedBy?: string | null;
}

export function TodoColumn({
	column,
	onUpdate,
	onRemove,
	onToggleCollapse,
	canRemove,
	isOwner = true,
	sharedBy = null,
}: TodoColumnProps) {
	const { isAuthenticated } = useAccount();

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

	const isEmpty = isColumnEmpty(column);

	const handleRemove = () => {
		onRemove(column.id);
	};

	const handleToggleCollapse = () => {
		onToggleCollapse(column.id);
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
					{/* Shared indicator */}
					{!isOwner && sharedBy && (
						<span className="text-xs text-muted-foreground px-1">
							Shared by {truncateAccountId(sharedBy)}
						</span>
					)}
				</div>

				<div className="flex items-center gap-1">
					{/* Presence avatars */}
					<PresenceAvatars columnId={column.id} />

					{/* Share button (owner only) */}
					{isOwner && isAuthenticated && (
						<ShareMenu
							columnId={column.id}
							columnMeta={{
								id: column.id,
								ownerId: column.ownerId || "",
								sharedWith: column.sharedWith || [],
								publicId: column.publicId ?? null,
								createdAt: 0,
								schemaVersion: 1,
							}}
						/>
					)}

					{/* Delete/Hide button */}
					{canRemove && (
						<>
							{isEmpty || !isOwner ? (
								<button
									onClick={handleRemove}
									className="rounded p-1 hover:bg-muted"
									title={isOwner ? "Delete column" : "Hide column"}
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
				<TodoEditor column={column} onUpdate={onUpdate} />
			</div>
		</div>
	);
}

interface TodoEditorProps {
	column: Column;
	onUpdate: (id: string, value: Value) => void;
}

function TodoEditor({ column, onUpdate }: TodoEditorProps) {
	const { accountId, account, browserStorageError, syncStateSummary } = useSyncContext();
	const isSyncedMode = !!accountId && !!account;
	const identity = React.useMemo(
		() =>
			isSyncedMode && accountId
				? { name: displayAccountId(accountId), color: getAccountColor(accountId) }
				: undefined,
		[isSyncedMode, accountId],
	);

	return (
		<ColumnEditor
			columnId={column.id}
			// Guest columns seed their document from saved content; synced ones load theirs.
			snapshot={isSyncedMode ? undefined : column.value}
			readOnly={browserStorageError !== null || (isSyncedMode && syncStateSummary.storageState !== "durable")}
			identity={identity}
			onContentChange={onUpdate}
		/>
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
