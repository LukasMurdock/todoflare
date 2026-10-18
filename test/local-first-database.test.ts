import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
	getLocalFirstDb,
	LOCAL_FIRST_COLLECTION_STORE,
	LOCAL_FIRST_DB_NAME,
	LOCAL_FIRST_DB_VERSION,
	resetLocalFirstDbForTests,
} from "../src/lib/local-first/database";

type RawCollection = {
	name: string;
	layoutVersion?: number;
	entries: Array<[string, unknown]>;
};

function openRawDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(LOCAL_FIRST_DB_NAME, LOCAL_FIRST_DB_VERSION);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(LOCAL_FIRST_COLLECTION_STORE)) {
				request.result.createObjectStore(LOCAL_FIRST_COLLECTION_STORE, {
					keyPath: "name",
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function seedCollections(collections: RawCollection[]): Promise<void> {
	const db = await openRawDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(LOCAL_FIRST_COLLECTION_STORE, "readwrite");
		const store = tx.objectStore(LOCAL_FIRST_COLLECTION_STORE);
		for (const collection of collections) store.put(collection);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	db.close();
}

async function readRawCollection(name: string): Promise<RawCollection | undefined> {
	const db = await openRawDb();
	const result = await new Promise<RawCollection | undefined>((resolve, reject) => {
		const request = db
			.transaction(LOCAL_FIRST_COLLECTION_STORE, "readonly")
			.objectStore(LOCAL_FIRST_COLLECTION_STORE)
			.get(name);
		request.onsuccess = () => resolve(request.result as RawCollection | undefined);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return result;
}

function legacyAccountSnapshot(id = "account:1111111111111111") {
	return {
		id,
		accountId: "1111 1111 1111 1111",
		account: {
			schemaVersion: 1,
			id: "1111 1111 1111 1111",
			columnOrder: ["00000000-0000-4000-8000-000000000001"],
			hiddenSharedColumns: [],
			createdAt: 100,
		},
		sharedColumns: [],
		deletedColumns: [],
		hydratedAt: 100,
		reconciledAt: null,
	};
}

function legacyMutation(queueId: string, payload: unknown = { columnId: "00000000-0000-4000-8000-000000000001" }) {
	return {
		id: queueId,
		queueId,
		idempotencyKey: `idempotency-${queueId}`,
		opType: "column.create",
		entityId: "1111 1111 1111 1111",
		payload,
		createdAt: 100,
		attemptCount: 0,
		nextRetryAt: 100,
		ackedAt: null,
		lastError: null,
		terminalReason: null,
		lastAttemptAt: null,
		insertedAt: 100,
	};
}

describe("local-first IndexedDB record contract", () => {
	beforeEach(async () => {
		await resetLocalFirstDbForTests();
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: new IDBFactory(),
		});
	});

	afterEach(async () => {
		await resetLocalFirstDbForTests();
	});

	it("migrates legacy records before exposing them and persists schema version 1", async () => {
		const id = "account:1111111111111111";
		await seedCollections([
			{ name: "accountSnapshot", entries: [[id, legacyAccountSnapshot(id)]] },
		]);

		const db = await getLocalFirstDb();
		const snapshot = db.collections.accountSnapshot.get(id);

		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			sharedWithByColumn: {},
			publicLinksByColumn: {},
		});
		expect(db.getStorageHealth().state).toBe("durable");

		const stored = await readRawCollection("accountSnapshot");
		expect(stored?.layoutVersion).toBe(1);
		expect(stored?.entries[0]?.[1]).toMatchObject({ schemaVersion: 1 });
	});

	it("quarantines malformed durable mutations instead of silently deleting them", async () => {
		await seedCollections([
			{
				name: "mutationOutbox",
				entries: [
					["valid", legacyMutation("valid")],
					["invalid", legacyMutation("invalid", { columnId: 42 })],
				],
			},
		]);

		const db = await getLocalFirstDb();
		expect(Array.from(db.collections.mutationOutbox.keys())).toEqual(["valid"]);
		const quarantined = Array.from(db.collections.quarantine.values());
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]).toMatchObject({
			sourceCollection: "mutationOutbox",
			sourceKey: "invalid",
			containsDurableMutation: true,
		});
		expect(quarantined[0]?.raw).toMatchObject({ queueId: "invalid" });

		const storedQuarantine = await readRawCollection("quarantine");
		expect(storedQuarantine?.entries).toHaveLength(1);
	});

	it("preserves future-version records and blocks writes to their collection", async () => {
		const future = {
			schemaVersion: 2,
			id: "future-yjs",
			accountId: "1111 1111 1111 1111",
			columnId: "00000000-0000-4000-8000-000000000001",
			kind: "sync",
			updateBytes: [1],
		};
		await seedCollections([
			{ name: "yjsUpdateOutbox", entries: [["future-yjs", future]] },
		]);

		const db = await getLocalFirstDb();
		expect(db.getStorageHealth().state).toBe("degraded");
		expect(db.collections.yjsUpdateOutbox.size).toBe(0);
		db.collections.yjsUpdateOutbox.set("replacement", {
			schemaVersion: 1,
			id: "replacement",
			accountId: "1111 1111 1111 1111",
			columnId: "00000000-0000-4000-8000-000000000001",
			kind: "sync",
			updateBytes: [2],
			stateVectorBytes: null,
			createdAt: 100,
			attemptCount: 0,
			nextRetryAt: 100,
			ackedAt: null,
			terminalReason: null,
			lastError: null,
		});
		await expect(db.flush()).rejects.toThrow();

		const stored = await readRawCollection("yjsUpdateOutbox");
		expect(stored?.entries).toEqual([["future-yjs", future]]);
	});

	it("validates snapshots, Yjs bytes, and sync telemetry at startup", async () => {
		const invalidSnapshot = legacyAccountSnapshot("account:bad");
		invalidSnapshot.account.columnOrder = "not-an-array" as unknown as string[];
		await seedCollections([
			{ name: "accountSnapshot", entries: [["account:bad", invalidSnapshot]] },
			{
				name: "yjsUpdateOutbox",
				entries: [["bad-yjs", {
					id: "bad-yjs",
					accountId: "1111 1111 1111 1111",
					columnId: "00000000-0000-4000-8000-000000000001",
					kind: "sync",
					updateBytes: [999],
					stateVectorBytes: null,
					createdAt: 100,
					attemptCount: 0,
					nextRetryAt: 100,
					ackedAt: null,
					terminalReason: null,
					lastError: null,
				}]],
			},
			{
				name: "syncState",
				entries: [["sync:bad", {
					id: "sync:bad",
					accountId: null,
					mode: "not-a-mode",
					queueDepth: -1,
					yjsQueueDepth: 0,
					lastServerHydrationAt: null,
					lastReplayAt: null,
					lastReplayLatencyMs: null,
					revokeDiscardCount: 0,
					convergenceFailureCount: 0,
					updatedAt: 100,
				}]],
			},
		]);

		const db = await getLocalFirstDb();
		expect(db.collections.accountSnapshot.size).toBe(0);
		expect(db.collections.yjsUpdateOutbox.size).toBe(0);
		expect(db.collections.syncState.size).toBe(0);
		expect(
			new Set(
				Array.from(db.collections.quarantine.values()).map(
					(record) => record.sourceCollection,
				),
			),
		).toEqual(new Set(["accountSnapshot", "yjsUpdateOutbox", "syncState"]));
	});

	it("reports memory-only storage instead of treating IndexedDB absence as success", async () => {
		await resetLocalFirstDbForTests();
		Object.defineProperty(globalThis, "indexedDB", {
			configurable: true,
			value: undefined,
		});

		const db = await getLocalFirstDb();
		expect(db.getStorageHealth()).toMatchObject({
			state: "memory-only",
			lastError: { operation: "open" },
		});
	});

});
