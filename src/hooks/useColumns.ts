import { useCallback, useState, useMemo, useEffect } from "react";
import type { Value } from "platejs";
import { EMPTY_COLUMN_VALUE, type Column, createEmptyColumn } from "@/types/column";
import { useDebouncedEffect } from "./useDebouncedEffect";
import { useSyncContext } from "@/contexts/sync-context";
import type { ColumnMeta } from "@/types/account";
import { normalizeAccountId } from "@/lib/account";

const LOCAL_STORAGE_KEY = "todoflare-columns";
const LOCAL_BACKUP_PREFIX = "todoflare-backup-";
const LOCAL_BACKUP_INDEX_KEY = "todoflare-backup-index";
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
		const key = `${LOCAL_BACKUP_PREFIX}${bucket}`;
		const serialized = JSON.stringify(columns);

		localStorage.setItem(key, serialized);

		const existingRaw = localStorage.getItem(LOCAL_BACKUP_INDEX_KEY);
		const existing = existingRaw ? (JSON.parse(existingRaw) as string[]) : [];
		const merged = [key, ...existing.filter((k) => k !== key)];
		const kept = merged.slice(0, LOCAL_BACKUP_MAX_CHECKPOINTS);
		localStorage.setItem(LOCAL_BACKUP_INDEX_KEY, JSON.stringify(kept));

		for (const oldKey of merged.slice(LOCAL_BACKUP_MAX_CHECKPOINTS)) {
			localStorage.removeItem(oldKey);
		}
	} catch (e) {
		console.error("Failed to persist local checkpoint:", e);
	}
}

function loadLocalColumns(): Column[] {
	try {
		const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed;
			}
		}
	} catch (e) {
		console.error("Failed to load columns from localStorage:", e);
	}
	return [createEmptyColumn()];
}

function saveLocalColumns(columns: Column[]): void {
	try {
		const serialized = JSON.stringify(columns);
		localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
		persistLocalCheckpoint(columns);
	} catch (e) {
		console.error("Failed to save columns to localStorage:", e);
	}
}

export function clearLocalColumns(): void {
	try {
		localStorage.removeItem(LOCAL_STORAGE_KEY);
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
		sharedColumns,
		createColumn,
		deleteColumn,
		updateColumnOrder,
		updateHiddenSharedColumns,
	} = useSyncContext();

	// Local columns (for offline/unauthenticated mode)
	const [localColumns, setLocalColumns] = useState<Column[]>(() =>
		loadLocalColumns(),
	);
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

	// Persist local columns to localStorage
	useDebouncedEffect(
		() => {
			if (!accountId) {
				saveLocalColumns(localColumns);
			}
		},
		[localColumns, accountId],
		500
	);

	// Add column
	const addColumn = useCallback(async () => {
		if (accountId) {
			// Create column on server
			await createColumn();
		} else {
			// Local-only mode
			setLocalColumns((prev) => [...prev, createEmptyColumn()]);
		}
	}, [accountId, createColumn]);

	// Remove column
	const removeColumn = useCallback(
		async (id: string) => {
			if (accountId) {
				// Check if we own this column
				const meta = columnMetaMap.get(id);
				const isOwner =
					!meta ||
					normalizeAccountId(meta.ownerId) === normalizeAccountId(accountId);

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
			accountId,
			account,
			columnMetaMap,
			deleteColumn,
			updateHiddenSharedColumns,
		],
	);

	// Update column value (for local-only mode)
	const updateColumnValue = useCallback(
		(id: string, value: Value) => {
			if (!accountId) {
				setLocalColumns((prev) =>
					prev.map((col) => (col.id === id ? { ...col, value } : col)),
				);
			}
			// In synced mode, updates go through Yjs collaboration
		},
		[accountId],
	);

	// Reorder columns
	const reorderColumns = useCallback(
		async (activeId: string, overId: string) => {
			if (accountId) {
				// Synced mode: update column order
				const oldIndex = syncedColumnIds.indexOf(activeId);
				const newIndex = syncedColumnIds.indexOf(overId);

				if (oldIndex === -1 || newIndex === -1) return;

				const newOrder = [...syncedColumnIds];
				const [removed] = newOrder.splice(oldIndex, 1);
				newOrder.splice(newIndex, 0, removed);

				// Separate owned and shared columns
				const ownedOrder = newOrder.filter(
					(id) => !columnMetaMap.has(id),
				);

				await updateColumnOrder(ownedOrder);
			} else {
				// Local-only mode
				setLocalColumns((prev) => {
					const oldIndex = prev.findIndex((col) => col.id === activeId);
					const newIndex = prev.findIndex((col) => col.id === overId);

					if (oldIndex === -1 || newIndex === -1) return prev;

					const newColumns = [...prev];
					const [removed] = newColumns.splice(oldIndex, 1);
					newColumns.splice(newIndex, 0, removed);

					return newColumns;
				});
			}
		},
		[accountId, syncedColumnIds, columnMetaMap, updateColumnOrder],
	);

	// Toggle column collapsed
	const toggleColumnCollapsed = useCallback(
		(id: string) => {
			if (!accountId) {
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
		[accountId],
	);

	// Get columns based on mode
	const columns = useMemo(() => {
		if (accountId && account) {
			// Synced mode: return column IDs with metadata
			return syncedColumnIds.map((id) => {
				const meta = columnMetaMap.get(id);
				return {
					id,
					value: EMPTY_COLUMN_VALUE,
					collapsed: collapsedById[id] ?? false,
					ownerId: meta?.ownerId || accountId,
					sharedWith: meta?.sharedWith || [],
					publicId: meta?.publicId || null,
				} as Column;
			});
		}
		// Local-only mode
		return localColumns;
	}, [
		accountId,
		account,
		syncedColumnIds,
		columnMetaMap,
		localColumns,
		collapsedById,
	]);

	// Check if a column is owned by the current user
	const isColumnOwner = useCallback(
		(columnId: string) => {
			if (!accountId) return true; // Local mode, always owner

			const meta = columnMetaMap.get(columnId);
			if (!meta) return true; // If no meta, it's owned

			return (
				normalizeAccountId(meta.ownerId) === normalizeAccountId(accountId)
			);
		},
		[accountId, columnMetaMap],
	);

	// Get column owner info
	const getColumnOwner = useCallback(
		(columnId: string): string | null => {
			if (!accountId) return null;

			const meta = columnMetaMap.get(columnId);
			return meta?.ownerId || null;
		},
		[accountId, columnMetaMap],
	);

	return {
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
