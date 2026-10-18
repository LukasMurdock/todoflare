"use client";

import { ReconnectBanner } from "@/components/account/ReconnectBanner";
import { StorageRecoveryBanner } from "@/components/account/StorageRecoveryBanner";

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
	sortableKeyboardCoordinates,
	horizontalListSortingStrategy,
} from "@dnd-kit/sortable";

import { useColumns } from "@/hooks/useColumns";
import { ColumnLayout } from "./ColumnLayout";
import { AccountBadge } from "@/components/account/AccountBadge";
import { ModifierKeyProvider } from "@/components/board/modifier-key";
import { PortalContainerProvider } from "@/components/board/portal-container";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { DocumentAdapterProvider } from "@/components/board/use-column-document";
import { createMemoryDocuments } from "@/components/board/memory-documents";
import { createCloudflareDocuments } from "@/lib/collaboration/cloudflare-yjs-provider";
import { useSyncContext } from "@/contexts/sync-context";

export function TodoApp() {
	const {
		status,
		columns,
		addColumn,
		removeColumn,
		updateColumnValue,
		reorderColumns,
		toggleColumnCollapsed,
		isColumnOwner,
		getColumnOwner,
	} = useColumns();

	const { accountId, account, loadColumnDocument, subscribeToColumn, onColumnMessage, sendUpdate, sendAwareness } =
		useSyncContext();
	const isSyncedMode = !!accountId && !!account;
	// Signed-in columns live in the Cloudflare room; guest columns in memory, saved from onContentChange.
	const documents = React.useMemo(
		() =>
			isSyncedMode
				? createCloudflareDocuments({
					loadColumnDocument,
					transport: { subscribeToColumn, onColumnMessage, sendUpdate, sendAwareness },
				})
				: createMemoryDocuments(),
		[isSyncedMode, loadColumnDocument, subscribeToColumn, onColumnMessage, sendUpdate, sendAwareness],
	);

	// Dialogs, popovers and menus portal into the board root, not document.body.
	const [root, setRoot] = React.useState<HTMLDivElement | null>(null);

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: {
				distance: 8,
			},
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		})
	);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;

		if (over && active.id !== over.id) {
			reorderColumns(active.id as string, over.id as string);
		}
	};

	return (
		<div ref={setRoot} data-todo-board="" className="relative min-h-screen">
			<PortalContainerProvider container={root}>
			<DocumentAdapterProvider value={documents}>
			<StorageRecoveryBanner />
			<ReconnectBanner />
			{/* Account badge in top-right corner */}
			<div className="fixed top-2 right-2 z-50">
				<AccountBadge />
			</div>

			<ModifierKeyProvider>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={columns.map((c) => c.id)}
					strategy={horizontalListSortingStrategy}
				>
					<ColumnLayout
						status={status}
						columns={columns}
						onAdd={addColumn}
						onUpdate={updateColumnValue}
						onRemove={removeColumn}
						onToggleCollapse={toggleColumnCollapsed}
						isColumnOwner={isColumnOwner}
						getColumnOwner={getColumnOwner}
					/>
				</SortableContext>
			</DndContext>
			<KeyboardShortcuts />
			</ModifierKeyProvider>
			</DocumentAdapterProvider>
			</PortalContainerProvider>
		</div>
	);
}
