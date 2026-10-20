import { mergeUpdates } from "yjs";
/** IndexedDB-backed local-first collections with validated, versioned records. */
import type {
	AccountSnapshotDoc,
	ColumnDocumentDoc,
	DurableCollectionName,
	MutationOutboxDoc,
	QuarantinedRecord,
	SyncStateDoc,
	YjsUpdateOutboxDoc,
} from "@/lib/local-first/collections";
import { REMOVAL_MARKER_TTL_MS } from "./outbox-journal";
import { migrateCollectionEntries } from "./persistence-contract";

export interface LocalFirstCollections {
	accountSnapshot: Map<string, AccountSnapshotDoc>;
	columnDocument: Map<string, ColumnDocumentDoc>;
	mutationOutbox: Map<string, MutationOutboxDoc>;
	yjsUpdateOutbox: Map<string, YjsUpdateOutboxDoc>;
	syncState: Map<string, SyncStateDoc>;
	quarantine: Map<string, QuarantinedRecord>;
}

export type StorageHealth =
	| { state: "durable"; lastError: null }
	| { state: "degraded" | "memory-only"; lastError: StorageIssue };

export interface StorageIssue {
	operation: "open" | "read" | "migrate" | "write";
	collection: DurableCollectionName | "quarantine" | null;
	message: string;
	at: number;
}

export interface LocalFirstDatabase {
	collections: LocalFirstCollections;
	getStorageHealth(): StorageHealth;
	subscribeStorageHealth(listener: (health: StorageHealth) => void): () => void;
	flush(): Promise<void>;
	retryFailedWrites?(): Promise<void>;
	close(): Promise<void>;
}

export const LOCAL_FIRST_DB_NAME = "todoflare-local-first";
export const LOCAL_FIRST_DB_VERSION = 1;
export const LOCAL_FIRST_COLLECTION_STORE = "collections";
const COLLECTION_LAYOUT_VERSION = 1;

const DURABLE_COLLECTION_KEYS = [
	"accountSnapshot",
	"columnDocument",
	"mutationOutbox",
	"yjsUpdateOutbox",
	"syncState",
] as const satisfies readonly DurableCollectionName[];
const ALL_COLLECTION_KEYS = [...DURABLE_COLLECTION_KEYS, "quarantine"] as const;
type CollectionName = (typeof ALL_COLLECTION_KEYS)[number];
type StoredCollectionEntries = Array<[string, unknown]>;

interface CollectionPatch {
	sets: StoredCollectionEntries;
	deletes: string[];
}

function collectionDiff(previous: StoredCollectionEntries, next: StoredCollectionEntries): CollectionPatch {
	const before = new Map(previous);
	const after = new Map(next);
	return {
		sets: next.filter(([key, value]) => !before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(value)),
		deletes: previous.filter(([key]) => !after.has(key)).map(([key]) => key),
	};
}

class PersistedMap<T> extends Map<string, T> {
	private readonly onChange: (patch: CollectionPatch) => void;

	constructor(
		entries: Array<[string, T]>,
		onChange: (patch: CollectionPatch) => void,
	) {
		super();
		this.onChange = onChange;
		for (const [key, value] of entries) super.set(key, value);
	}

	override set(key: string, value: T): this {
		super.set(key, value);
		this.onChange({ sets: [[key, value]], deletes: [] });
		return this;
	}

	override delete(key: string): boolean {
		const deleted = super.delete(key);
		if (deleted) this.onChange({ sets: [], deletes: [key] });
		return deleted;
	}

	override clear(): void {
		if (this.size === 0) return;
		const deletes = Array.from(this.keys());
		super.clear();
		this.onChange({ sets: [], deletes });
	}

	replaceAll(entries: Iterable<[string, T]>): void {
		const next = Array.from(entries);
		const patch = collectionDiff(Array.from(this.entries()), next);
		super.clear();
		for (const [key, value] of next) super.set(key, value);
		if (patch.sets.length || patch.deletes.length) this.onChange(patch);
	}
}

/** Replaces a collection with one persistence notification instead of one per row. */
export function replaceLocalFirstCollection<T>(
	collection: Map<string, T>,
	entries: Iterable<[string, T]>,
): void {
	if (collection instanceof PersistedMap) {
		collection.replaceAll(entries);
		return;
	}
	collection.clear();
	for (const [key, value] of entries) collection.set(key, value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "Unknown storage error";
}

function createHealthTracker(initial: StorageHealth) {
	let health = initial;
	const listeners = new Set<(value: StorageHealth) => void>();
	return {
		get: () => health,
		set(next: StorageHealth) {
			health = next;
			for (const listener of listeners) listener(health);
		},
		subscribe(listener: (value: StorageHealth) => void) {
			listeners.add(listener);
			listener(health);
			return () => listeners.delete(listener);
		},
	};
}

function storageIssue(
	operation: StorageIssue["operation"],
	collection: StorageIssue["collection"],
	error: unknown,
): StorageIssue {
	return { operation, collection, message: errorMessage(error), at: Date.now() };
}

function canUseIndexedDb(): boolean {
	return typeof indexedDB !== "undefined";
}

function openLocalFirstIndexedDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(LOCAL_FIRST_DB_NAME, LOCAL_FIRST_DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(LOCAL_FIRST_COLLECTION_STORE)) {
				db.createObjectStore(LOCAL_FIRST_COLLECTION_STORE, { keyPath: "name" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
		request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
	});
}

function readCollectionEntries(
	db: IDBDatabase,
	name: CollectionName,
): Promise<StoredCollectionEntries> {
	return new Promise((resolve, reject) => {
		try {
			const tx = db.transaction(LOCAL_FIRST_COLLECTION_STORE, "readonly");
			const request = tx.objectStore(LOCAL_FIRST_COLLECTION_STORE).get(name);
			request.onsuccess = () => {
				const raw = request.result as
					| { layoutVersion?: unknown; entries?: unknown }
					| undefined;
				if (!raw) return resolve([]);
				if (
					typeof raw.layoutVersion === "number" &&
					raw.layoutVersion > COLLECTION_LAYOUT_VERSION
				) {
					return reject(
						new Error(`Collection layout ${raw.layoutVersion} is not supported`),
					);
				}
				if (!Array.isArray(raw.entries)) {
					return reject(new Error("Collection entries are malformed"));
				}
				const entries: StoredCollectionEntries = [];
				for (const entry of raw.entries) {
					if (!Array.isArray(entry) || entry.length < 2) {
						return reject(new Error("Collection contains a malformed entry tuple"));
					}
					entries.push([String(entry[0]), entry[1]]);
				}
				resolve(entries);
			};
			request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
		} catch (error) {
			reject(error);
		}
	});
}

/** Transactions merge only this client's changes into the latest stored row. */
function patchCollections(
	db: IDBDatabase,
	collections: Array<{ name: CollectionName; patch: CollectionPatch }>,
): Promise<void> {
	if (collections.length === 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		try {
			const tx = db.transaction(LOCAL_FIRST_COLLECTION_STORE, "readwrite");
			const store = tx.objectStore(LOCAL_FIRST_COLLECTION_STORE);
			for (const { name, patch } of collections) {
				const request = store.get(name);
				request.onsuccess = () => {
					const raw = request.result as { layoutVersion?: number; entries?: StoredCollectionEntries; deletedKeys?: string[]; deletedKeyTimes?: number[] } | undefined;
					if (raw && (raw.layoutVersion ?? 1) > COLLECTION_LAYOUT_VERSION) {
						tx.abort(); return;
					}
					const entries = new Map(raw?.entries ?? []);
					// Removal markers expire like the localStorage journal's; untimed legacy ones at once.
					const now = Date.now();
					const deleted = new Map<string, number>();
					(raw?.deletedKeys ?? []).forEach((key, index) => {
						const at = raw?.deletedKeyTimes?.[index] ?? 0;
						if (now - at <= REMOVAL_MARKER_TTL_MS) deleted.set(key, at);
					});
					const isOutbox = name === "mutationOutbox" || name === "yjsUpdateOutbox";
					for (const key of patch.deletes) {
						entries.delete(key);
						if (isOutbox) deleted.set(key, now);
					}
					for (const [key, value] of patch.sets) {
						// A receipt/removal always wins over a stale tab's retry state.
						if (name === "columnDocument" && entries.has(key)) {
							try {
								const previous = entries.get(key) as ColumnDocumentDoc;
								const next = value as ColumnDocumentDoc;
								entries.set(key, { ...next, updateBytes: Array.from(mergeUpdates([new Uint8Array(previous.updateBytes), new Uint8Array(next.updateBytes)])) });
							} catch (error) { reject(error); tx.abort(); return; }
						} else if (!isOutbox || !deleted.has(key)) entries.set(key, value);
					}
					store.put({ name, layoutVersion: COLLECTION_LAYOUT_VERSION, entries: Array.from(entries), deletedKeys: Array.from(deleted.keys()), deletedKeyTimes: Array.from(deleted.values()) });
				};
			}
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
		} catch (error) { reject(error); }
	});
}

function validQuarantineEntries(
	entries: StoredCollectionEntries,
): Array<[string, QuarantinedRecord]> {
	return entries.filter((entry): entry is [string, QuarantinedRecord] => {
		const value = entry[1] as Partial<QuarantinedRecord> | null;
		return !!value && typeof value === "object" && value.schemaVersion === 1 &&
			value.id === entry[0] && typeof value.reason === "string";
	});
}

function createInMemoryDb(issue: StorageIssue): LocalFirstDatabase {
	const health = createHealthTracker({ state: "memory-only", lastError: issue });
	let durable: LocalFirstDatabase | null = null;
	let unsubscribe: (() => void) | null = null;
	const fallback: LocalFirstDatabase = {
		collections: { columnDocument: new Map(), accountSnapshot: new Map(), mutationOutbox: new Map(), yjsUpdateOutbox: new Map(), syncState: new Map(), quarantine: new Map() },
		getStorageHealth: health.get,
		subscribeStorageHealth: health.subscribe,
		async flush() { if (durable) return durable.flush(); throw new Error(issue.message); },
		async retryFailedWrites() {
			if (durable) return durable.retryFailedWrites?.();
			const candidate = await createIndexedDbBackedDb();
			if (candidate.getStorageHealth().state !== "durable") { await candidate.close(); throw new Error(issue.message); }
			for (const name of ALL_COLLECTION_KEYS) {
				const target = candidate.collections[name] as Map<string, unknown>;
				for (const [id, row] of fallback.collections[name]) target.set(id, row);
			}
			try { await candidate.flush(); } catch (error) { await candidate.close(); throw error; }
			durable = candidate;
			Object.assign(fallback.collections, candidate.collections);
			unsubscribe = candidate.subscribeStorageHealth(health.set);
			health.set(candidate.getStorageHealth());
		},
		async close() { unsubscribe?.(); await durable?.close(); },
	};
	return fallback;
}

export async function createIndexedDbBackedDb(): Promise<LocalFirstDatabase> {
	if (!canUseIndexedDb()) {
		return createInMemoryDb(
			storageIssue("open", null, new Error("IndexedDB is unavailable")),
		);
	}

	let db: IDBDatabase;
	try {
		db = await openLocalFirstIndexedDb();
	} catch (error) {
		console.warn("Failed to open local-first IndexedDB. Falling back to memory.", error);
		return createInMemoryDb(storageIssue("open", null, error));
	}

	const rawCollections = new Map<CollectionName, StoredCollectionEntries>();
	try {
		for (const name of ALL_COLLECTION_KEYS) {
			rawCollections.set(name, await readCollectionEntries(db, name));
		}
	} catch (error) {
		db.close();
		console.error("Failed to read local-first IndexedDB. Falling back to memory.", error);
		return createInMemoryDb(storageIssue("read", null, error));
	}

	const health = createHealthTracker({ state: "durable", lastError: null });
	const blockedCollections = new Set<CollectionName>();
	const migrated = new Map<DurableCollectionName, ReturnType<typeof migrateCollectionEntries>>();
	const quarantineMap = new Map<string, QuarantinedRecord>(
		validQuarantineEntries(rawCollections.get("quarantine") ?? []),
	);
	const migrationWrites: Array<{
		name: CollectionName;
		entries: StoredCollectionEntries;
	}> = [];

	for (const name of DURABLE_COLLECTION_KEYS) {
		const result = migrateCollectionEntries(name, rawCollections.get(name) ?? []);
		migrated.set(name, result);
		for (const record of result.quarantined) quarantineMap.set(record.id, record);
		if (result.writeBlocked) blockedCollections.add(name);
		if (result.changed && !result.writeBlocked) {
			migrationWrites.push({ name, entries: result.entries });
		}
	}
	if (Array.from(migrated.values()).some((result) => result.quarantined.length > 0)) {
		migrationWrites.push({ name: "quarantine", entries: Array.from(quarantineMap) });
	}

	try {
		await patchCollections(db, migrationWrites.map(({ name, entries }) => ({
			name, patch: collectionDiff(rawCollections.get(name) ?? [], entries),
		})));
	} catch (error) {
		for (const write of migrationWrites) blockedCollections.add(write.name);
		health.set({ state: "degraded", lastError: storageIssue("migrate", null, error) });
	}

	for (const name of blockedCollections) {
		if (health.get().state === "durable") {
			health.set({
				state: "degraded",
				lastError: storageIssue(
					"migrate",
					name,
					new Error("Collection contains unsupported or uncommitted records; writes are blocked"),
				),
			});
		}
	}

	const pendingWrites = new Map<CollectionName, Promise<void>>();
	const failedWrites = new Map<CollectionName, CollectionPatch[]>();
	const persistCollection = (name: CollectionName, patch: CollectionPatch) => {
		if (blockedCollections.has(name)) {
			failedWrites.set(name, [...(failedWrites.get(name) ?? []), patch]);
			return;
		}
		const previous = pendingWrites.get(name) ?? Promise.resolve();
		const next = previous.then(async () => {
			const patches = [...(failedWrites.get(name) ?? []), patch];
			failedWrites.delete(name);
			try {
				// Merge retries in order, so a later removal still wins.
				const sets = new Map<string, unknown>();
				const deletes = new Set<string>();
				for (const item of patches) {
					for (const key of item.deletes) { sets.delete(key); deletes.add(key); }
					for (const [key, value] of item.sets) { sets.set(key, value); }
				}
				await patchCollections(db, [{ name, patch: { sets: Array.from(sets), deletes: Array.from(deletes) } }]);
			} catch (error) {
				failedWrites.set(name, patches);
				health.set({ state: "degraded", lastError: storageIssue("write", name, error) });
			}
		});
		pendingWrites.set(name, next);
	};

	const entriesFor = <T>(name: DurableCollectionName): Array<[string, T]> =>
		(migrated.get(name)?.entries ?? []) as Array<[string, T]>;
	const collections: LocalFirstCollections = {
		columnDocument: new PersistedMap(entriesFor<ColumnDocumentDoc>("columnDocument"),
			(entries) => persistCollection("columnDocument", entries)),
		accountSnapshot: new PersistedMap(entriesFor<AccountSnapshotDoc>("accountSnapshot"),
			(entries) => persistCollection("accountSnapshot", entries)),
		mutationOutbox: new PersistedMap(entriesFor<MutationOutboxDoc>("mutationOutbox"),
			(entries) => persistCollection("mutationOutbox", entries)),
		yjsUpdateOutbox: new PersistedMap(entriesFor<YjsUpdateOutboxDoc>("yjsUpdateOutbox"),
			(entries) => persistCollection("yjsUpdateOutbox", entries)),
		syncState: new PersistedMap(entriesFor<SyncStateDoc>("syncState"),
			(entries) => persistCollection("syncState", entries)),
		quarantine: new PersistedMap(Array.from(quarantineMap),
			(entries) => persistCollection("quarantine", entries)),
	};

	return {
		collections,
		getStorageHealth: health.get,
		subscribeStorageHealth: health.subscribe,
		async flush() {
			await Promise.all(pendingWrites.values());
			if (failedWrites.size) throw new Error(health.get().lastError?.message ?? "Browser storage did not commit changes");
		},
		async retryFailedWrites() {
			await Promise.all(pendingWrites.values());
			for (const name of failedWrites.keys()) persistCollection(name, { sets: [], deletes: [] });
			await Promise.all(pendingWrites.values());
			if (failedWrites.size || blockedCollections.size) throw new Error(health.get().lastError?.message ?? "Browser storage is blocked");
			health.set({ state: "durable", lastError: null });
		},
		async close() {
			await Promise.all(pendingWrites.values());
			db.close();
		},
	};
}

let localFirstDbPromise: Promise<LocalFirstDatabase> | null = null;

export async function getLocalFirstDb(): Promise<LocalFirstDatabase> {
	if (!localFirstDbPromise) localFirstDbPromise = createIndexedDbBackedDb();
	return localFirstDbPromise;
}

/** Test-only reset for isolated IndexedDB boot scenarios. */
export async function resetLocalFirstDbForTests(): Promise<void> {
	if (localFirstDbPromise) await (await localFirstDbPromise).close();
	localFirstDbPromise = null;
}
