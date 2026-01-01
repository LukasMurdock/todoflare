import { useCallback, useState } from "react";
import type { Value } from "platejs";
import { type Column, createEmptyColumn } from "@/types/column";
import { useDebouncedEffect } from "./useDebouncedEffect";

const STORAGE_KEY = "todoflare-columns";

function loadColumns(): Column[] {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
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

function saveColumns(columns: Column[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
	} catch (e) {
		console.error("Failed to save columns to localStorage:", e);
	}
}

export function useColumns() {
	const [columns, setColumns] = useState<Column[]>(() => loadColumns());

	// Persist to localStorage with debouncing (500ms)
	// Skips initial mount, flushes on unmount and beforeunload
	useDebouncedEffect(
		() => {
			saveColumns(columns);
		},
		[columns],
		500
	);

	const addColumn = useCallback(() => {
		setColumns((prev) => [...prev, createEmptyColumn()]);
	}, []);

	const removeColumn = useCallback((id: string) => {
		setColumns((prev) => {
			// Don't remove if it's the last column
			if (prev.length <= 1) return prev;
			return prev.filter((col) => col.id !== id);
		});
	}, []);

	const updateColumnValue = useCallback((id: string, value: Value) => {
		setColumns((prev) =>
			prev.map((col) => (col.id === id ? { ...col, value } : col))
		);
	}, []);

	const reorderColumns = useCallback(
		(activeId: string, overId: string) => {
			setColumns((prev) => {
				const oldIndex = prev.findIndex((col) => col.id === activeId);
				const newIndex = prev.findIndex((col) => col.id === overId);

				if (oldIndex === -1 || newIndex === -1) return prev;

				const newColumns = [...prev];
				const [removed] = newColumns.splice(oldIndex, 1);
				newColumns.splice(newIndex, 0, removed);

				return newColumns;
			});
		},
		[]
	);

	const toggleColumnCollapsed = useCallback((id: string) => {
		setColumns((prev) =>
			prev.map((col) =>
				col.id === id ? { ...col, collapsed: !col.collapsed } : col
			)
		);
	}, []);

	return {
		columns,
		addColumn,
		removeColumn,
		updateColumnValue,
		reorderColumns,
		toggleColumnCollapsed,
	};
}
