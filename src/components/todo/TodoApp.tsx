"use client";

import * as React from "react";

import { ReconnectBanner } from "@/components/account/ReconnectBanner";
import { StorageRecoveryBanner } from "@/components/account/StorageRecoveryBanner";
import { AccountBadge } from "@/components/account/AccountBadge";
import { PresenceAvatars } from "@/components/column/PresenceAvatars";
import { ShareMenu } from "@/components/column/ShareMenu";
import { TodoBoard } from "@/components/board/TodoBoard";
import { createMemoryDocuments } from "@/components/board/memory-documents";
import type { BoardColumn, TodoBoardApi } from "@/components/board/types";
import { useWelcomeRefsOptional } from "@/contexts/welcome-refs-context";
import { useSyncContext } from "@/contexts/sync-context";
import { useColumns } from "@/hooks/useColumns";
import { useKeyboardShortcut } from "@/hooks/useKeyboardShortcut";
import { displayAccountId, getAccountColor, truncateAccountId } from "@/lib/account";
import { createCloudflareDocuments } from "@/lib/collaboration/cloudflare-yjs-provider";

/** Todoflare's host for the board: accounts, Cloudflare sync, sharing, and guest storage. */
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
	const {
		accountId,
		account,
		authenticationStatus,
		browserStorageError,
		syncStateSummary,
		loadColumnDocument,
		subscribeToColumn,
		onColumnMessage,
		sendUpdate,
		sendAwareness,
	} = useSyncContext();
	const isSyncedMode = !!accountId && !!account;
	const board = React.useRef<TodoBoardApi>(null);

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

	const identity = React.useMemo(
		() =>
			isSyncedMode && accountId
				? { name: displayAccountId(accountId), color: getAccountColor(accountId) }
				: undefined,
		[isSyncedMode, accountId],
	);

	const readOnly =
		browserStorageError !== null || (isSyncedMode && syncStateSummary.storageState !== "durable");
	const boardColumns = React.useMemo(
		(): BoardColumn[] =>
			columns.map((column) => {
				const owned = isColumnOwner(column.id);
				const owner = getColumnOwner(column.id);
				return {
					id: column.id,
					collapsed: column.collapsed,
					readOnly,
					removal: columns.length > 1 ? (owned ? "delete" : "hide") : "none",
					label: !owned && owner ? `Shared by ${truncateAccountId(owner)}` : undefined,
					// Guest columns seed their document from saved content; synced ones load theirs.
					snapshot: isSyncedMode ? undefined : column.value,
				};
			}),
		[columns, isColumnOwner, getColumnOwner, readOnly, isSyncedMode],
	);

	const columnsById = React.useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);

	// The welcome tour anchors its callouts to board elements.
	const { registerRef } = useWelcomeRefsOptional();
	React.useEffect(() => {
		registerRef("add-column-button", board.current?.getElement("add-column") ?? null);
		registerRef("first-column", board.current?.getElement("first-column") ?? null);
		registerRef("shortcuts-button", board.current?.getElement("shortcuts-button") ?? null);
	});

	// Todoflare is the whole page, so Mod+/ opens help wherever focus is.
	useKeyboardShortcut({
		key: "/",
		modifiers: MOD,
		onTrigger: React.useCallback(() => board.current?.openShortcutsHelp(), []),
	});

	return (
		<TodoBoard
			ref={board}
			status={status}
			columns={boardColumns}
			documents={documents}
			identity={identity}
			onCreateColumn={addColumn}
			onRemoveColumn={(column) => removeColumn(column.id)}
			onReorderColumns={reorderColumns}
			onCollapsedChange={(column) => toggleColumnCollapsed(column.id)}
			onContentChange={updateColumnValue}
			renderTopBar={() => (
				<>
					<StorageRecoveryBanner />
					<ReconnectBanner />
					{/* Account badge in top-right corner */}
					<div className="fixed top-2 right-2 z-50">
						<AccountBadge />
					</div>
				</>
			)}
			renderColumnActions={(column) => (
				<>
					<PresenceAvatars columnId={column.id} />
					{isColumnOwner(column.id) && authenticationStatus === "authenticated" && (
						<ShareMenu
							columnId={column.id}
							columnMeta={{
								id: column.id,
								ownerId: columnsById.get(column.id)?.ownerId || "",
								sharedWith: columnsById.get(column.id)?.sharedWith || [],
								publicId: columnsById.get(column.id)?.publicId ?? null,
								createdAt: 0,
								schemaVersion: 1,
							}}
						/>
					)}
				</>
			)}
		/>
	);
}

const MOD = ["mod" as const];
