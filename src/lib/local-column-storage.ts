import type { Column } from "../types/column";

export const LOCAL_COLUMNS_STORAGE_KEY = "todoflare-columns";
export const LOCAL_COLUMN_BACKUP_PREFIX = "todoflare-backup-";
export const LOCAL_COLUMN_BACKUP_INDEX_KEY = "todoflare-backup-index";

export function parseLocalColumns(raw: string | null): Column[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) && parsed.length > 0
			? (parsed as Column[])
			: null;
	} catch {
		return null;
	}
}
