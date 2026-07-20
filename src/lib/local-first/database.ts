/** IndexedDB-backed local-first collections with an in-memory fallback. */
import type {
	AccountSnapshotDoc,
	SyncStateDoc,
	YjsUpdateOutboxDoc,
} from "@/lib/local-first/collections";

export interface LocalFirstCollections {
	accountSnapshot: Map<string, AccountSnapshotDoc>;
	mutationOutbox: Map<string, unknown>;
	yjsUpdateOutbox: Map<string, YjsUpdateOutboxDoc>;
	syncState: Map<string, SyncStateDoc>;
}

export interface LocalFirstDatabase {
	collections: LocalFirstCollections;
	close(): Promise<void>;
}

const LOCAL_FIRST_DB_NAME = "todoflare-local-first";
const LOCAL_FIRST_DB_VERSION = 1;
const LOCAL_FIRST_COLLECTION_STORE = "collections";

const COLLECTION_KEYS = [
	"accountSnapshot",
	"mutationOutbox",
	"yjsUpdateOutbox",
	"syncState",
] as const;

type CollectionName = (typeof COLLECTION_KEYS)[number];
type StoredCollectionEntries = Array<[string, unknown]>;

class PersistedMap<T> extends Map<string, T> {
	private readonly onChange: (entries: Array<[string, T]>) => void;

	constructor(
		entries: Array<[string, T]>,
		onChange: (entries: Array<[string, T]>) => void,
	) {
		super();
		this.onChange = onChange;
		for (const [key, value] of entries) {
			super.set(key, value);
		}
	}

	override set(key: string, value: T): this {
		super.set(key, value);
		this.onChange(Array.from(this.entries()));
		return this;
	}

	override delete(key: string): boolean {
		const deleted = super.delete(key);
		if (deleted) {
			this.onChange(Array.from(this.entries()));
		}
		return deleted;
	}

	override clear(): void {
		if (this.size === 0) return;
		super.clear();
		this.onChange([]);
	}
}

function canUseIndexedDb(): boolean {
	return typeof indexedDB !== "undefined";
}

function openLocalFirstIndexedDb(): Promise<IDBDatabase | null> {
	if (!canUseIndexedDb()) {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		const request = indexedDB.open(LOCAL_FIRST_DB_NAME, LOCAL_FIRST_DB_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(LOCAL_FIRST_COLLECTION_STORE)) {
				db.createObjectStore(LOCAL_FIRST_COLLECTION_STORE, { keyPath: "name" });
			}
		};

		request.onsuccess = () => {
			resolve(request.result);
		};

		request.onerror = () => {
			console.warn("Failed to open local-first IndexedDB. Falling back to memory.");
			resolve(null);
		};
	});
}

function readCollectionEntries(
	db: IDBDatabase,
	name: CollectionName,
): Promise<StoredCollectionEntries> {
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(LOCAL_FIRST_COLLECTION_STORE, "readonly");
			const store = tx.objectStore(LOCAL_FIRST_COLLECTION_STORE);
			const request = store.get(name);

			request.onsuccess = () => {
				const raw = request.result as
					| { name?: string; entries?: unknown }
					| undefined;
				if (!raw || !Array.isArray(raw.entries)) {
					resolve([]);
					return;
				}

				const entries = raw.entries
					.filter(
						(entry): entry is [unknown, unknown] =>
							Array.isArray(entry) && entry.length >= 2,
					)
					.map((entry) => [String(entry[0]), entry[1]] as [string, unknown]);

				resolve(entries);
			};

			request.onerror = () => {
				resolve([]);
			};
		} catch {
			resolve([]);
		}
	});
}

function writeCollectionEntries(
	db: IDBDatabase,
	name: CollectionName,
	entries: StoredCollectionEntries,
): Promise<void> {
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(LOCAL_FIRST_COLLECTION_STORE, "readwrite");
			const store = tx.objectStore(LOCAL_FIRST_COLLECTION_STORE);
			store.put({ name, entries });

			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}

function asCollectionEntries<T>(
	entries: StoredCollectionEntries,
): Array<[string, T]> {
	return entries.map(([key, value]) => [key, value as T]);
}

let localFirstDbPromise: Promise<LocalFirstDatabase> | null = null;

function createInMemoryDb(): LocalFirstDatabase {
	return {
		collections: {
			accountSnapshot: new Map(),
			mutationOutbox: new Map(),
			yjsUpdateOutbox: new Map(),
			syncState: new Map(),
		},
		async close() {
			return;
		},
	};
}

async function createIndexedDbBackedDb(): Promise<LocalFirstDatabase> {
	const db = await openLocalFirstIndexedDb();
	if (!db) {
		return createInMemoryDb();
	}

	const loadedEntriesByCollection = new Map<CollectionName, StoredCollectionEntries>();
	for (const collectionName of COLLECTION_KEYS) {
		loadedEntriesByCollection.set(
			collectionName,
			await readCollectionEntries(db, collectionName),
		);
	}

	const persistCollection = (
		collectionName: CollectionName,
		entries: Array<[string, unknown]>,
	) => {
		void writeCollectionEntries(db, collectionName, [...entries]);
	};

	const collections: LocalFirstCollections = {
		accountSnapshot: new PersistedMap<AccountSnapshotDoc>(
			asCollectionEntries<AccountSnapshotDoc>(
				loadedEntriesByCollection.get("accountSnapshot") ?? [],
			),
			(entries) => {
				persistCollection("accountSnapshot", entries);
			},
		),
		mutationOutbox: new PersistedMap<unknown>(
			asCollectionEntries<unknown>(
				loadedEntriesByCollection.get("mutationOutbox") ?? [],
			),
			(entries) => {
				persistCollection("mutationOutbox", entries);
			},
		),
		yjsUpdateOutbox: new PersistedMap<YjsUpdateOutboxDoc>(
			asCollectionEntries<YjsUpdateOutboxDoc>(
				loadedEntriesByCollection.get("yjsUpdateOutbox") ?? [],
			),
			(entries) => {
				persistCollection("yjsUpdateOutbox", entries);
			},
		),
		syncState: new PersistedMap<SyncStateDoc>(
			asCollectionEntries<SyncStateDoc>(
				loadedEntriesByCollection.get("syncState") ?? [],
			),
			(entries) => {
				persistCollection("syncState", entries);
			},
		),
	};

	return {
		collections,
		async close() {
			db.close();
		},
	};
}

export async function getLocalFirstDb(): Promise<LocalFirstDatabase> {
	if (!localFirstDbPromise) {
		localFirstDbPromise = createIndexedDbBackedDb();
	}

	return localFirstDbPromise;
}

export function resetLocalFirstDbForTests() {
	if (localFirstDbPromise) {
		void localFirstDbPromise
			.then((db) => db.close())
			.catch(() => {
				return;
			});
	}
	localFirstDbPromise = null;
}
