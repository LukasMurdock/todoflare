import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIndexedDbBackedDb, type LocalFirstDatabase } from "../src/lib/local-first/database";
import { LocalYjsUpdateOutbox, createLocalStorageYjsOutboxStorage, createLocalFirstYjsOutboxStorage } from "../src/lib/sync/yjs-update-outbox";
import { LocalMutationQueueService, createLocalStorageMutationQueueStorage, createLocalFirstMutationQueueStorage } from "../src/lib/sync/mutation-queue-service";
import { createAccountEditCommand } from "../src/lib/sync/contracts";

class MemoryStorage implements Storage {
	values = new Map<string, string>();
	get length() { return this.values.size; }
	clear() { this.values.clear(); }
	getItem(key: string) { return this.values.get(key) ?? null; }
	key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
	removeItem(key: string) { this.values.delete(key); }
	setItem(key: string, value: string) { this.values.set(key, value); }
}
const accountId = "1111222233334444";
const openDatabases: LocalFirstDatabase[] = [];
async function openDb() { const db = await createIndexedDbBackedDb(); openDatabases.push(db); return db; }

describe("independent browser tabs", () => {
	let storage: MemoryStorage;
	beforeEach(() => {
		storage = new MemoryStorage();
		Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
		Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
	});
	afterEach(async () => {
		for (const db of openDatabases.splice(0)) await db.close();
		Reflect.deleteProperty(globalThis, "window");
		vi.restoreAllMocks();
	});

	it("preserves both tabs' Yjs edits in both journals and prevents receipt resurrection", async () => {
		const a = await openDb(), b = await openDb();
		const tabA = new LocalYjsUpdateOutbox({ storage: createLocalStorageYjsOutboxStorage("yjs") });
		const tabB = new LocalYjsUpdateOutbox({ storage: createLocalStorageYjsOutboxStorage("yjs") });
		tabA.swapStorage(createLocalFirstYjsOutboxStorage(a)); tabB.swapStorage(createLocalFirstYjsOutboxStorage(b));
		const input = { accountId, columnId: "column", kind: "sync" as const, payload: new Uint8Array([0, 0]) };
		const idA = tabA.enqueue(input), idB = tabB.enqueue(input);
		await Promise.all([a.flush(), b.flush()]);
		const c = await openDb();
		expect(new Set(c.collections.yjsUpdateOutbox.keys())).toEqual(new Set([idA, idB]));
		const journal = createLocalStorageYjsOutboxStorage("yjs");
		expect(new Set(journal.read().map(row => row.id))).toEqual(new Set([idA, idB]));
		tabA.acknowledgeSync(accountId, "column", idA); await a.flush();
		// A stale copy actively tries to rewrite the acknowledged row.
		const stale = b.collections.yjsUpdateOutbox;
		stale.set(idA, c.collections.yjsUpdateOutbox.get(idA)!); await b.flush();
		journal.write([...journal.read(), ...tabA.getAllEntries()]);
		const d = await openDb();
		expect(Array.from(d.collections.yjsUpdateOutbox.keys())).toEqual([idB]);
		expect(createLocalStorageYjsOutboxStorage("yjs").read().map(row => row.id)).toEqual([idB]);
	});

	it("preserves concurrent metadata commands while another tab acknowledges its own command", async () => {
		const a = await openDb(), b = await openDb();
		const executor = async () => ({ kind: "ack" as const });
		const tabA = new LocalMutationQueueService({ executor, storage: createLocalStorageMutationQueueStorage("commands") });
		const tabB = new LocalMutationQueueService({ executor, storage: createLocalStorageMutationQueueStorage("commands") });
		await tabA.swapStorage(createLocalFirstMutationQueueStorage(a)); await tabB.swapStorage(createLocalFirstMutationQueueStorage(b));
		const cmd = (columnId: string) => createAccountEditCommand("column.create", { columnId }, { entityId: accountId, idempotencyKey: crypto.randomUUID(), createdAt: 1, attemptCount: 0, nextRetryAt: 1 });
		const idA = await tabA.enqueue(cmd("a")), idB = await tabB.enqueue(cmd("b"));
		await Promise.all([a.flush(), b.flush()]);
		await tabA.replay({ accountId }); await a.flush();
		const c = await openDb();
		expect(Array.from(c.collections.mutationOutbox.keys())).toEqual([idB]);
		expect(createLocalStorageMutationQueueStorage("commands").read().map(row => row.queueId)).toEqual([idB]);
		expect(c.collections.mutationOutbox.has(idA)).toBe(false);
	});

	it("surfaces a journal quota failure and retains the edit for recovery", () => {
		const outbox = new LocalYjsUpdateOutbox({ storage: createLocalStorageYjsOutboxStorage("quota") });
		vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
		expect(() => outbox.enqueue({ accountId, columnId: "a", kind: "sync", payload: new Uint8Array([0, 0]) })).toThrow("Full");
		expect(outbox.getAllEntries()).toHaveLength(1);
	});

	it("rejects flush when an IndexedDB transaction fails instead of reporting durability", async () => {
		const db = await openDb();
		const raw = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open("todoflare-local-first"); r.onsuccess = () => resolve(r.result); });
		const prototype = Object.getPrototypeOf(raw) as IDBDatabase;
		const original = prototype.transaction;
		vi.spyOn(prototype, "transaction").mockImplementation(function(this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
			if (args[1] === "readwrite") throw new DOMException("Full", "QuotaExceededError");
			return original.apply(this, args);
		});
		db.collections.quarantine.set("q", { schemaVersion: 1, id: "q", sourceCollection: "mutationOutbox", sourceKey: "q", detectedAt: 1, category: "invalid", foundVersion: 1, reason: "test", containsDurableMutation: true, raw: {} });
		await expect(db.flush()).rejects.toThrow("Full");
		expect(db.getStorageHealth().state).toBe("degraded");
		raw.close();
	});
	it("reopens unavailable IndexedDB on retry and commits retained rows", async () => {
		const factory = indexedDB;
		Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
		const db = await openDb();
		expect(db.getStorageHealth().state).toBe("memory-only");
		const outbox = new LocalYjsUpdateOutbox({ storage: createLocalFirstYjsOutboxStorage(db) });
		const id = outbox.enqueue({ accountId, columnId: "retry", kind: "sync", payload: new Uint8Array([0, 0]) });
		await expect(db.flush()).rejects.toThrow();
		Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
		await db.retryFailedWrites?.();
		expect(db.getStorageHealth().state).toBe("durable");
		await db.flush();
		const reopened = await openDb();
		expect(reopened.collections.yjsUpdateOutbox.has(id)).toBe(true);
	});

});
