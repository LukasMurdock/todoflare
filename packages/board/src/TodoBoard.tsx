"use client";

import * as React from "react";
import {
	DndContext,
	closestCenter,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	arrayMove,
	horizontalListSortingStrategy,
	sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";

import { ColumnLayout } from "./ColumnLayout";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { cn } from "./ui/cn";
import { BoardContextProvider, useBoardContextValue } from "./board-context";
import { ModifierKeyProvider } from "./modifier-key";
import { isModShortcut } from "./platform";
import { PortalContainerProvider } from "./portal-container";
import type { BoardColumn, TodoBoardApi, TodoBoardProps } from "./types";
import { DocumentAdapterProvider } from "./use-column-document";

/**
 * The embeddable todo board. Everything the board needs from its host arrives
 * through props; overlays render inside the board's root element, and keyboard
 * handling is limited to events inside the board.
 */
export function TodoBoard({
	columns,
	documents,
	status = "ready",
	onCreateColumn,
	onRemoveColumn,
	onReorderColumns,
	onCollapsedChange,
	onContentChange,
	onError,
	onOpenLink,
	identity,
	editorPlugins,
	shortcutsButton = "board",
	renderColumnActions,
	renderTopBar,
	className,
	ref,
}: TodoBoardProps) {
	const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
	const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
	const { value: boardContext, editors } = useBoardContextValue({ onOpenLink, onError, editorPlugins });
	const { reportError } = boardContext;

	React.useImperativeHandle(
		ref,
		(): TodoBoardApi => ({
			focusColumn(columnId) {
				const editor = editors.get(columnId);
				editor?.focus();
				return editor !== undefined;
			},
			scrollToColumn(columnId) {
				root
					?.querySelector(`[data-column-id="${CSS.escape(columnId)}"]`)
					?.scrollIntoView({ block: "nearest", inline: "nearest" });
			},
			getColumnContent: (columnId) => editors.get(columnId)?.getContent() ?? null,
			openShortcutsHelp: () => setShortcutsOpen(true),
			getElement: (part) => root?.querySelector<HTMLElement>(`[data-board-part="${part}"]`) ?? null,
		}),
		[root, editors],
	);

	/** Runs a host callback; a throw or rejection goes to onError instead of escaping the board. */
	const runIntent = React.useCallback(
		(operation: string, intent: () => unknown, columnId?: string) => {
			try {
				Promise.resolve(intent()).catch((error: unknown) => reportError(error, { columnId, operation }));
			} catch (error) {
				reportError(error, { columnId, operation });
			}
		},
		[reportError],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!onReorderColumns || !over || active.id === over.id) return;
		const ids = columns.map((column) => column.id);
		const from = ids.indexOf(String(active.id));
		const to = ids.indexOf(String(over.id));
		if (from === -1 || to === -1) return;
		runIntent("reorder-columns", () => onReorderColumns(arrayMove(ids, from, to)));
	};

	// Mod+/ toggles the help dialog when focus is inside this board; hosts that
	// want it page-wide call ref.openShortcutsHelp() from their own listener.
	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (!isModShortcut(event, "/")) return;
		event.preventDefault();
		setShortcutsOpen((open) => !open);
	};

	const handleRemove = React.useMemo(
		() =>
			onRemoveColumn
				? (column: BoardColumn) => runIntent("remove-column", () => onRemoveColumn(column), column.id)
				: undefined,
		[onRemoveColumn, runIntent],
	);
	const handleToggleCollapse = React.useMemo(
		() =>
			onCollapsedChange
				? (column: BoardColumn) => onCollapsedChange(column, !column.collapsed)
				: undefined,
		[onCollapsedChange],
	);

	return (
		<div
			ref={setRoot}
			data-todo-board=""
			className={cn("relative min-h-screen", className)}
			onKeyDown={handleKeyDown}
		>
			<BoardContextProvider value={boardContext}>
				<PortalContainerProvider container={root}>
					<DocumentAdapterProvider value={documents}>
						<ModifierKeyProvider>
							{renderTopBar?.()}
							<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
								<SortableContext items={columns.map((column) => column.id)} strategy={horizontalListSortingStrategy}>
									<ColumnLayout
										status={status}
										columns={columns}
										onAdd={onCreateColumn ? () => runIntent("create-column", onCreateColumn) : undefined}
										onRemove={handleRemove}
										onToggleCollapse={handleToggleCollapse}
										onContentChange={onContentChange}
										identity={identity}
										renderColumnActions={renderColumnActions}
									/>
								</SortableContext>
							</DndContext>
							<KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} button={shortcutsButton} />
						</ModifierKeyProvider>
					</DocumentAdapterProvider>
				</PortalContainerProvider>
			</BoardContextProvider>
		</div>
	);
}
