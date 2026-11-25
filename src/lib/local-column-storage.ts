import type { Column } from "../types/column";

export const LOCAL_COLUMNS_STORAGE_KEY = "todoflare-columns";
export const LOCAL_COLUMN_BACKUP_PREFIX = "todoflare-backup-";
export const LOCAL_COLUMN_BACKUP_INDEX_KEY = "todoflare-backup-index";

export function parseLocalColumns(raw: string | null): Array<Column> | null {
	if (!raw) {return null;}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) {return null;}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Guest exports are unversioned. Preserve the original array, including nodes written by older editors.
		return parsed as Array<Column>;
	} catch {
		return null;
	}
}
