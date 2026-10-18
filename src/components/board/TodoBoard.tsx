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

import { ColumnLayout } from "@/components/todo/ColumnLayout";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { cn } from "@/lib/utils";
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
	identity,
	renderColumnActions,
	renderTopBar,
	className,
	ref,
}: TodoBoardProps) {
	const [root, setRoot] = React.useState<HTMLDivElement | null>(null);
	const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

	React.useImperativeHandle(
		ref,
		(): TodoBoardApi => ({
			openShortcutsHelp: () => setShortcutsOpen(true),
			getElement: (part) => root?.querySelector<HTMLElement>(`[data-board-part="${part}"]`) ?? null,
		}),
		[root],
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
		void onReorderColumns(arrayMove(ids, from, to));
	};

	// Mod+/ toggles the help dialog when focus is inside this board; hosts that
	// want it page-wide call ref.openShortcutsHelp() from their own listener.
	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (!isModShortcut(event, "/")) return;
		event.preventDefault();
		setShortcutsOpen((open) => !open);
	};

	const handleRemove = React.useMemo(
		() => (onRemoveColumn ? (column: BoardColumn) => void onRemoveColumn(column) : undefined),
		[onRemoveColumn],
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
			<PortalContainerProvider container={root}>
				<DocumentAdapterProvider value={documents}>
					<ModifierKeyProvider>
						{renderTopBar?.()}
						<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
							<SortableContext items={columns.map((column) => column.id)} strategy={horizontalListSortingStrategy}>
								<ColumnLayout
									status={status}
									columns={columns}
									onAdd={onCreateColumn ? () => void onCreateColumn() : undefined}
									onRemove={handleRemove}
									onToggleCollapse={handleToggleCollapse}
									onContentChange={onContentChange}
									identity={identity}
									renderColumnActions={renderColumnActions}
								/>
							</SortableContext>
						</DndContext>
						<KeyboardShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
					</ModifierKeyProvider>
				</DocumentAdapterProvider>
			</PortalContainerProvider>
		</div>
	);
}
