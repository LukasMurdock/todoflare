import { useCallback, useState, useMemo, useRef } from "react";
import type { Value } from "platejs";
import { EMPTY_COLUMN_VALUE, type Column, createEmptyColumn } from "@/types/column";
import { useSyncContext } from "@/contexts/sync-context";
import type { ColumnMeta } from "@/types/account";
import { isColumnOwner as accountOwnsColumn } from "@/lib/column-access";
import {
	LOCAL_COLUMN_BACKUP_INDEX_KEY,
	LOCAL_COLUMN_BACKUP_PREFIX,
	LOCAL_COLUMNS_STORAGE_KEY,
	parseLocalColumns,
} from "@/lib/local-column-storage";

const LOCAL_BACKUP_MAX_CHECKPOINTS = 24 * 30;

function currentHourBucket(ts = Date.now()): string {
	const d = new Date(ts);
	const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
	const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
	const dd = d.getUTCDate().toString().padStart(2, "0");
	const hh = d.getUTCHours().toString().padStart(2, "0");
	return `${yyyy}${mm}${dd}${hh}`;
}

function persistLocalCheckpoint(columns: Column[]): void {
	try {
		const bucket = currentHourBucket();
		const key = `${LOCAL_COLUMN_BACKUP_PREFIX}${bucket}`;
		const serialized = JSON.stringify(columns);

		localStorage.setItem(key, serialized);

		const existingRaw = localStorage.getItem(LOCAL_COLUMN_BACKUP_INDEX_KEY);
		const existing = existingRaw ? (JSON.parse(existingRaw) as string[]) : [];
		const merged = [key, ...existing.filter((k) => k !== key)];
		const kept = merged.slice(0, LOCAL_BACKUP_MAX_CHECKPOINTS);
		localStorage.setItem(LOCAL_COLUMN_BACKUP_INDEX_KEY, JSON.stringify(kept));

		for (const oldKey of merged.slice(LOCAL_BACKUP_MAX_CHECKPOINTS)) {
			localStorage.removeItem(oldKey);
		}
	} catch (e) {
		console.error("Failed to persist local checkpoint:", e);
	}
}

function loadLocalColumns(): Column[] {
	try {
		const parsed = parseLocalColumns(
			localStorage.getItem(LOCAL_COLUMNS_STORAGE_KEY),
		);
		if (parsed) return parsed;
	} catch (e) {
		console.error("Failed to load columns from localStorage:", e);
	}
	return [createEmptyColumn()];
}

function saveLocalColumns(columns: Column[]): void {
	const serialized = JSON.stringify(columns);
	localStorage.setItem(LOCAL_COLUMNS_STORAGE_KEY, serialized);
	persistLocalCheckpoint(columns);
}

export function clearLocalColumns(): void {
	try {
		localStorage.removeItem(LOCAL_COLUMNS_STORAGE_KEY);
	} catch (e) {
		console.error("Failed to clear columns from localStorage:", e);
	}
}

export function getLocalColumns(): Column[] {
	return loadLocalColumns();
}

/**
 * Hook for managing columns
 *
 * Works in two modes:
 * 1. Local-only: When no account is logged in, uses localStorage
 * 2. Synced: When logged in, uses the account's column order with sync
 */
export function useColumns() {
	const {
		accountId,
		account,
		isLoading,
		sharedColumns,
		sharedWithByColumn,
		publicLinksByColumn,
		syncMode,
		browserStorageError,
		reportBrowserStorageError,
		createColumn,
		deleteColumn,
		updateColumnOrder,
		updateHiddenSharedColumns,
	} = useSyncContext();

	const usesSyncedMode =
		!!accountId && !!account && syncMode !== "guest_local";
	// A signed-in account whose columns are not known yet. Showing guest columns
	// here would let edits land in guest storage and then vanish.
	const status: "loading" | "ready" =
		!!accountId && !account && isLoading ? "loading" : "ready";

	// Local columns (for offline/unauthenticated mode)
	const [localColumns, setLocalColumnsState] = useState<Column[]>(() =>
		loadLocalColumns(),
	);
	const localColumnsRef = useRef(localColumns);
	const setLocalColumns = useCallback((update: (previous: Column[]) => Column[]) => {
		if (browserStorageError) return;
		const next = update(localColumnsRef.current);
		localColumnsRef.current = next;
		try { saveLocalColumns(next); }
		catch (error) { reportBrowserStorageError(error, next); }
		// Retain the attempted value for export; editing is paused after a failure.
		setLocalColumnsState(next);
	}, [browserStorageError, reportBrowserStorageError]);
	const [collapsedById, setCollapsedById] = useState<Record<string, boolean>>({});

	// When authenticated, derive columns from account metadata + shared columns
	const syncedColumnIds = useMemo(() => {
		if (!account) return [];

		// Start with owned columns in order
		const ownedIds = account.columnOrder || [];

		// Add shared columns that aren't hidden
		const hiddenSet = new Set(account.hiddenSharedColumns || []);
		const sharedIds = sharedColumns
			.filter((col) => !hiddenSet.has(col.id))
			.map((col) => col.id);

		return [...ownedIds, ...sharedIds];
	}, [account, sharedColumns]);

	// Build column metadata map
	const columnMetaMap = useMemo(() => {
		const map = new Map<string, ColumnMeta>();
		for (const col of sharedColumns) {
			map.set(col.id, col);
		}
		return map;
	}, [sharedColumns]);


	// Add column
	const addColumn = useCallback(async () => {
		if (usesSyncedMode) {
			// Create column on server
			await createColumn();
		} else {
			// Local-only mode
			setLocalColumns((prev) => [...prev, createEmptyColumn()]);
		}
	}, [usesSyncedMode, createColumn, setLocalColumns]);

	// Remove column
	const removeColumn = useCallback(
		async (id: string) => {
			if (usesSyncedMode) {
				// Check if we own this column
				const meta = columnMetaMap.get(id);
				const isOwner = !meta || accountOwnsColumn(meta, accountId);

				if (isOwner) {
					// Delete column from server
					await deleteColumn(id);
				} else {
					// Hide shared column
					const hiddenSharedColumns = [
						...(account?.hiddenSharedColumns || []),
						id,
					];
					await updateHiddenSharedColumns(hiddenSharedColumns);
				}
			} else {
				// Local-only mode
				setLocalColumns((prev) => {
					if (prev.length <= 1) return prev;
					return prev.filter((col) => col.id !== id);
				});
			}
		},
		[
			usesSyncedMode,
			account,
			accountId,
			columnMetaMap,
			deleteColumn,
			updateHiddenSharedColumns,
			setLocalColumns,
		],
	);

	// Update column value (for local-only mode)
	const updateColumnValue = useCallback(
		(id: string, value: Value) => {
			if (!usesSyncedMode) {
				// The editor reports every change, including selection moves; save only content changes.
				const current = localColumnsRef.current.find((col) => col.id === id);
				if (current && JSON.stringify(current.value) === JSON.stringify(value)) return;
				setLocalColumns((prev) =>
					prev.map((col) => (col.id === id ? { ...col, value } : col)),
				);
			}
			// In synced mode, updates go through Yjs collaboration
		},
		[usesSyncedMode, setLocalColumns],
	);

	// Apply a new column order (all visible column IDs, in order)
	const reorderColumns = useCallback(
		async (columnIds: string[]) => {
			if (usesSyncedMode) {
				// Shared columns are appended after owned ones; only owned order is stored.
				const ownedOrder = columnIds.filter((id) => !columnMetaMap.has(id));
				await updateColumnOrder(ownedOrder);
			} else {
				setLocalColumns((prev) => {
					const byId = new Map(prev.map((col) => [col.id, col]));
					const reordered = columnIds.flatMap((id) => {
						const col = byId.get(id);
						return col ? [col] : [];
					});
					return reordered.length === prev.length ? reordered : prev;
				});
			}
		},
		[usesSyncedMode, columnMetaMap, updateColumnOrder, setLocalColumns],
	);

	// Toggle column collapsed
	const toggleColumnCollapsed = useCallback(
		(id: string) => {
			if (!usesSyncedMode) {
				setLocalColumns((prev) =>
					prev.map((col) =>
						col.id === id ? { ...col, collapsed: !col.collapsed } : col,
					),
				);
				return;
			}

			setCollapsedById((prev) => ({
				...prev,
				[id]: !prev[id],
			}));
		},
		[usesSyncedMode, setLocalColumns],
	);

	// Get columns based on mode
	const columns = useMemo(() => {
		if (status === "loading") return [];
		if (usesSyncedMode) {
			// Synced mode: return column IDs with metadata
			return syncedColumnIds.map((id) => {
				const meta = columnMetaMap.get(id);
				const localSharedWith = sharedWithByColumn[id];
				const localPublicLink = publicLinksByColumn[id] || null;
				return {
					id,
					value: EMPTY_COLUMN_VALUE,
					collapsed: collapsedById[id] ?? false,
					ownerId: meta?.ownerId || accountId,
					sharedWith: localSharedWith ?? meta?.sharedWith ?? [],
					publicId: localPublicLink?.publicId || meta?.publicId || null,
				} as Column;
			});
		}
		// Local-only mode
		return localColumns;
	}, [
		usesSyncedMode,
		syncedColumnIds,
		columnMetaMap,
		sharedWithByColumn,
		publicLinksByColumn,
		localColumns,
		collapsedById,
		accountId,
		status,
	]);

	// Check if a column is owned by the current user
	const isColumnOwner = useCallback(
		(columnId: string) => {
			if (!usesSyncedMode) return true; // Local mode, always owner

			const meta = columnMetaMap.get(columnId);
			if (!meta) return true; // If no meta, it's owned

			return accountOwnsColumn(meta, accountId);
		},
		[usesSyncedMode, accountId, columnMetaMap],
	);

	// Get column owner info
	const getColumnOwner = useCallback(
		(columnId: string): string | null => {
			if (!usesSyncedMode) return null;

			const meta = columnMetaMap.get(columnId);
			return meta?.ownerId || null;
		},
		[usesSyncedMode, columnMetaMap],
	);

	return {
		status,
		columns,
		addColumn,
		removeColumn,
		updateColumnValue,
		reorderColumns,
		toggleColumnCollapsed,
		isColumnOwner,
		getColumnOwner,
		// For migration
		localColumns,
		clearLocalColumns,
	};
}
