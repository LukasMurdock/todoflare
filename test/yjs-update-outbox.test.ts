import { describe, expect, it } from "vitest";
import {
	LocalYjsUpdateOutbox,
	createMemoryYjsOutboxStorage,
	type YjsOutboxEntry,
} from "../src/lib/sync/yjs-update-outbox";

function withMockedNow<T>(startAt: number, run: () => T): T {
	const originalNow = Date.now;
	let now = startAt;
	Date.now = () => now++;

	try {
		return run();
	} finally {
		Date.now = originalNow;
	}
}

function makeEntry(overrides: Partial<YjsOutboxEntry>): YjsOutboxEntry {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		accountId: overrides.accountId ?? "1111 1111 1111 1111",
		columnId: overrides.columnId ?? "col-1",
		kind: overrides.kind ?? "sync",
		updateBytes: overrides.updateBytes ?? [1],
		stateVectorBytes: overrides.stateVectorBytes ?? null,
		createdAt: overrides.createdAt ?? Date.now(),
		attemptCount: overrides.attemptCount ?? 0,
		nextRetryAt: overrides.nextRetryAt ?? Date.now(),
		ackedAt: overrides.ackedAt ?? null,
		terminalReason: overrides.terminalReason ?? null,
		lastError: overrides.lastError ?? null,
	};
}

describe("LocalYjsUpdateOutbox", () => {
	it("replays sync updates in enqueue order", () => {
		withMockedNow(1000, () => {
			const outbox = new LocalYjsUpdateOutbox({
				storage: createMemoryYjsOutboxStorage(),
			});

			outbox.enqueue({
				accountId: "1111 1111 1111 1111",
				columnId: "col-1",
				kind: "sync",
				payload: new Uint8Array([1]),
			});
			outbox.enqueue({
				accountId: "1111 1111 1111 1111",
				columnId: "col-1",
				kind: "sync",
				payload: new Uint8Array([2]),
			});

			const replayable = outbox.getReplayableForColumn(
				"1111 1111 1111 1111",
				"col-1",
			);

			expect(replayable.map((entry) => entry.updateBytes)).toEqual([[1], [2]]);
		});
	});

	it("coalesces awareness updates per account and column", () => {
		const outbox = new LocalYjsUpdateOutbox({
			storage: createMemoryYjsOutboxStorage(),
		});

		outbox.enqueue({
			accountId: "1111 1111 1111 1111",
			columnId: "col-1",
			kind: "awareness",
			payload: new Uint8Array([1]),
		});
		outbox.enqueue({
			accountId: "1111 1111 1111 1111",
			columnId: "col-1",
			kind: "awareness",
			payload: new Uint8Array([2]),
		});

		const replayable = outbox.getReplayableForColumn(
			"1111 1111 1111 1111",
			"col-1",
		);

		expect(replayable).toHaveLength(1);
		expect(replayable[0]?.kind).toBe("awareness");
		expect(replayable[0]?.updateBytes).toEqual([2]);
	});

	it("prunes stale awareness entries when loading replay", () => {
		withMockedNow(10_000, () => {
			const storage = createMemoryYjsOutboxStorage([
				makeEntry({
					id: "old-awareness",
					accountId: "1111 1111 1111 1111",
					columnId: "col-1",
					kind: "awareness",
					updateBytes: [9],
					createdAt: 1_000,
				}),
				makeEntry({
					id: "sync-entry",
					accountId: "1111 1111 1111 1111",
					columnId: "col-1",
					kind: "sync",
					updateBytes: [7],
					createdAt: 9_900,
				}),
			]);
			const outbox = new LocalYjsUpdateOutbox({ storage });

			const replayable = outbox.getReplayableForColumn(
				"1111 1111 1111 1111",
				"col-1",
				{ awarenessMaxAgeMs: 2_000 },
			);

			expect(replayable.map((entry) => entry.id)).toEqual(["sync-entry"]);
			expect(
				outbox.pendingCountForColumn("1111 1111 1111 1111", "col-1"),
			).toBe(1);
		});
	});

	it("acknowledges and removes sent entries", () => {
		const storage = createMemoryYjsOutboxStorage([
			makeEntry({ id: "entry-1", createdAt: 100 }),
			makeEntry({ id: "entry-2", createdAt: 200 }),
		]);
		const outbox = new LocalYjsUpdateOutbox({ storage });

		const removed = outbox.acknowledge(["entry-1"]);

		expect(removed).toBe(1);
		expect(outbox.pendingCountForColumn("1111 1111 1111 1111", "col-1")).toBe(
			1,
		);
	});

	it("migrates queued updates when storage backend swaps", () => {
		const transientStorage = createMemoryYjsOutboxStorage();
		const persistentStorage = createMemoryYjsOutboxStorage([
			makeEntry({
				id: "persisted-entry",
				accountId: "1111 1111 1111 1111",
				columnId: "col-1",
				kind: "sync",
				updateBytes: [8],
				createdAt: 50,
			}),
		]);

		const outbox = new LocalYjsUpdateOutbox({ storage: transientStorage });
		const transientId = outbox.enqueue({
			accountId: "1111 1111 1111 1111",
			columnId: "col-1",
			kind: "sync",
			payload: new Uint8Array([9]),
		});

		outbox.swapStorage(persistentStorage);

		const replayable = outbox
			.getReplayableForColumn("1111 1111 1111 1111", "col-1")
			.map((entry) => entry.id);
		expect(replayable).toContain("persisted-entry");
		expect(replayable).toContain(transientId);

		const persistedIds = persistentStorage.read().map((entry) => entry.id);
		expect(persistedIds).toContain("persisted-entry");
		expect(persistedIds).toContain(transientId);
	});

	it("drops queued entries for a revoked column", () => {
		const storage = createMemoryYjsOutboxStorage([
			makeEntry({
				id: "drop-1",
				accountId: "1111 1111 1111 1111",
				columnId: "col-a",
				kind: "sync",
			}),
			makeEntry({
				id: "drop-2",
				accountId: "1111 1111 1111 1111",
				columnId: "col-a",
				kind: "awareness",
			}),
			makeEntry({
				id: "keep-1",
				accountId: "1111 1111 1111 1111",
				columnId: "col-b",
				kind: "sync",
			}),
			makeEntry({
				id: "keep-2",
				accountId: "2222 2222 2222 2222",
				columnId: "col-a",
				kind: "sync",
			}),
		]);

		const outbox = new LocalYjsUpdateOutbox({ storage });

		const removed = outbox.dropForColumn("1111 1111 1111 1111", "col-a");

		expect(removed).toBe(2);
		const remainingIds = outbox.getAllEntries().map((entry) => entry.id);
		expect(remainingIds).toEqual(["keep-1", "keep-2"]);
	});
});
