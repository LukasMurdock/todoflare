import type { YjsOutboxEntry } from "./yjs-update-outbox";

/** Edits for a column the server doesn't list are kept this long, covering a create still in flight. */
export const ORPHANED_YJS_GRACE_MS = 10 * 60 * 1000;

export interface YjsOutboxRetentionInput {
	/** Owned and shared columns, including any with a pending create. */
	activeColumnIds: ReadonlySet<string>;
	/** Columns in the account's trash; their edits send if the column is restored. */
	trashedColumnIds: ReadonlySet<string>;
	now: number;
	awarenessMaxAgeMs: number;
}

export interface YjsOutboxRetention {
	/** Edits that will send once their column connects. */
	sendable: YjsOutboxEntry[];
	/** Edits kept for trashed columns; they only send after a restore. */
	heldForTrash: YjsOutboxEntry[];
	/** Entries that can never send: stale presence, and edits for columns that no longer exist. */
	discardable: YjsOutboxEntry[];
}

/**
 * Sorts outbox entries by whether they can still reach the server. Callers must
 * pass column sets from a server-confirmed projection, never a cached one.
 */
export function classifyYjsOutbox(
	entries: readonly YjsOutboxEntry[],
	input: YjsOutboxRetentionInput,
): YjsOutboxRetention {
	const retention: YjsOutboxRetention = { sendable: [], heldForTrash: [], discardable: [] };
	for (const entry of entries) {
		if (input.activeColumnIds.has(entry.columnId)) {
			const stalePresence =
				entry.kind === "awareness" && input.now - entry.createdAt > input.awarenessMaxAgeMs;
			retention[stalePresence ? "discardable" : "sendable"].push(entry);
		} else if (input.trashedColumnIds.has(entry.columnId)) {
			retention[entry.kind === "sync" ? "heldForTrash" : "discardable"].push(entry);
		} else if (entry.kind === "awareness" || input.now - entry.createdAt > ORPHANED_YJS_GRACE_MS) {
			retention.discardable.push(entry);
		} else {
			retention.sendable.push(entry);
		}
	}
	return retention;
}
