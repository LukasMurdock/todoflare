import type { DurableCollectionName } from "./collections";
import { readVersionedLocalStorageArray } from "./local-storage-quarantine";

/**
 * How long a removal marker outlives its delivery. A marker only matters while
 * another open tab may still hold the delivery in memory; a later resurrection
 * is replayed and deduplicated by the server. Markers that never expired filled
 * localStorage (one per acknowledged edit).
 */
export const REMOVAL_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes expired markers and their rows. Legacy markers ("1") count as expired. */
function pruneRemovalMarkers(storage: Storage, rowPrefix: string, removedPrefix: string, now: number): void {
	const expired: string[] = [];
	for (let index = 0; index < storage.length; index++) {
		const key = storage.key(index);
		if (!key?.startsWith(removedPrefix)) continue;
		const removedAt = Number(storage.getItem(key));
		if (!Number.isFinite(removedAt) || now - removedAt > REMOVAL_MARKER_TTL_MS) expired.push(key);
	}
	for (const key of expired) {
		storage.removeItem(rowPrefix + key.slice(removedPrefix.length));
		storage.removeItem(key);
	}
}

/**
 * A synchronous write-ahead journal, keyed by delivery ID. Tabs never replace a
 * shared array. Removal markers prevent a stale tab from resurrecting an ack.
 * Markers expire after REMOVAL_MARKER_TTL_MS. Legacy arrays remain read-only
 * until an explicit migration can preserve them.
 */
export function createOutboxJournal<T>(options: {
	storageKey: string;
	collection: Extract<DurableCollectionName, "mutationOutbox" | "yjsUpdateOutbox">;
	parse: (value: unknown) => T | null;
	id: (value: T) => string;
}) {
	const rowPrefix = `${options.storageKey}:row:`;
	const removedPrefix = `${options.storageKey}:removed:`;
	let observed = new Map<string, string>();
	let writeBlocked = false;
	let prunedAt = 0;
	const prune = (storage: Storage) => {
		const now = Date.now();
		if (now - prunedAt < PRUNE_INTERVAL_MS) return;
		pruneRemovalMarkers(storage, rowPrefix, removedPrefix, now);
		prunedAt = now;
	};
	return {
		read(): T[] {
			const legacy = readVersionedLocalStorageArray(options);
			writeBlocked ||= legacy.writeBlocked;
			const rows = new Map(legacy.records.map((row) => [options.id(row), row]));
			if (typeof window !== "undefined") {
				const storage = window.localStorage;
				prunedAt = 0;
				prune(storage);
				for (let index = 0; index < storage.length; index++) {
					const key = storage.key(index);
					if (!key?.startsWith(rowPrefix) || key.slice(rowPrefix.length).includes(":")) continue;
					const parsed = readVersionedLocalStorageArray({ ...options, storageKey: key });
					writeBlocked ||= parsed.writeBlocked;
					for (const row of parsed.records) rows.set(options.id(row), row);
				}
				for (const id of rows.keys()) if (storage.getItem(removedPrefix + id)) rows.delete(id);
			}
			observed = new Map(Array.from(rows, ([id, row]) => [id, JSON.stringify(row)]));
			return Array.from(rows.values());
		},
		write(entries: T[]): void {
			if (typeof window === "undefined") return;
			if (writeBlocked) throw new Error("Browser journal contains unsupported records; export recovery data before editing");
			const storage = window.localStorage;
			// Prune first: expired markers are what fill the quota.
			prune(storage);
			const next = new Map(entries.map((row) => [options.id(row), JSON.stringify(row)]));
			// Write new content before retiring old entries. A quota failure leaves
			// all previous recovery data intact and propagates to the caller.
			for (const [id, serialized] of next) {
				if (storage.getItem(removedPrefix + id)) continue;
				if (observed.get(id) !== serialized || storage.getItem(rowPrefix + id) === null) {
					storage.setItem(rowPrefix + id, JSON.stringify([{ ...JSON.parse(serialized), schemaVersion: 1 }]));
				}
			}
			for (const id of observed.keys()) {
				if (next.has(id)) continue;
				storage.setItem(removedPrefix + id, String(Date.now()));
				storage.removeItem(rowPrefix + id);
			}
			observed = next;
		},
	};
}
