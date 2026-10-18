import { mergeUpdates } from "yjs";
import { normalizeAccountId } from "../account";
import type { LocalFirstDatabase } from "../local-first/database";

export function columnDocumentKey(accountId: string, columnId: string): string {
	return `${normalizeAccountId(accountId)}:${columnId}`;
}

export function cacheColumnUpdate(db: LocalFirstDatabase, accountId: string, columnId: string, update: Uint8Array) {
	const id = columnDocumentKey(accountId, columnId);
	const previous = db.collections.columnDocument.get(id);
	const merged = previous ? mergeUpdates([new Uint8Array(previous.updateBytes), update]) : update;
	db.collections.columnDocument.set(id, {
		schemaVersion: 1, id, accountId: normalizeAccountId(accountId), columnId, updateBytes: Array.from(merged),
	});
}

export function readColumnDocument(db: LocalFirstDatabase, accountId: string, columnId: string, pending: Uint8Array[]): Uint8Array | null {
	const saved = db.collections.columnDocument.get(columnDocumentKey(accountId, columnId));
	const updates = saved ? [new Uint8Array(saved.updateBytes), ...pending] : pending;
	return updates.length ? mergeUpdates(updates) : null;
}
