import { describe, expect, it } from "vitest";
import type { AccountEditCommand } from "../src/lib/sync/contracts";
import {
	createLocalFirstMutationQueueStorage,
	LocalMutationQueueService,
	createMemoryMutationQueueStorage,
} from "../src/lib/sync/mutation-queue-service";
import type { LocalFirstDatabase } from "../src/lib/local-first/rxdb";

function makeCommand(
	opType: AccountEditCommand["opType"],
	payload: Record<string, unknown>,
	createdAt: number,
): AccountEditCommand {
	return {
		idempotencyKey: crypto.randomUUID(),
		opType,
		entityId: "1111 1111 1111 1111",
		payload,
		createdAt,
		attemptCount: 0,
		nextRetryAt: createdAt,
	};
}

describe("LocalMutationQueueService", () => {
	it("replays commands in FIFO order by createdAt", async () => {
		const order: string[] = [];
		const queue = new LocalMutationQueueService({
			executor: async (mutation) => {
				order.push(String(mutation.payload.marker));
				return { kind: "ack" };
			},
			storage: createMemoryMutationQueueStorage(),
		});

		await queue.enqueue(makeCommand("column.reorder", { marker: "second" }, 200));
		await queue.enqueue(makeCommand("column.reorder", { marker: "first" }, 100));

		const report = await queue.replay({ maxBatch: 10 });

		expect(report.attempted).toBe(2);
		expect(report.acked).toBe(2);
		expect(report.ackedCommands).toHaveLength(2);
		expect(report.ackedCommands[0]?.opType).toBe("column.reorder");
		expect(report.ackedCommands[1]?.opType).toBe("column.reorder");
		expect(order).toEqual(["first", "second"]);
	});

	it("applies retry metadata for transient failures", async () => {
		const storage = createMemoryMutationQueueStorage();
		const queue = new LocalMutationQueueService({
			executor: async () => ({ kind: "retry", error: "network" }),
			storage,
		});

		const now = Date.now();
		await queue.enqueue(makeCommand("column.hide_shared", { ids: [] }, now));
		const report = await queue.replay({ maxBatch: 10 });

		expect(report.attempted).toBe(1);
		expect(report.retried).toBe(1);

		const pending = storage.read();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.attemptCount).toBe(1);
		expect((pending[0]?.nextRetryAt ?? 0) > now).toBe(true);
		expect(pending[0]?.lastError).toBe("network");
	});

	it("drops terminal failures and reports reasons", async () => {
		const storage = createMemoryMutationQueueStorage();
		const queue = new LocalMutationQueueService({
			executor: async () => ({
				kind: "drop",
				reason: "validation_failed",
			}),
			storage,
		});

		await queue.enqueue(makeCommand("column.reorder", { columnOrder: [] }, 100));
		const report = await queue.replay({ maxBatch: 10 });

		expect(report.attempted).toBe(1);
		expect(report.dropped).toBe(1);
		expect(report.terminalFailures).toHaveLength(1);
		expect(report.terminalFailures[0]?.reason).toBe("validation_failed");
		expect(report.terminalFailures[0]?.opType).toBe("column.reorder");
		expect(report.terminalFailures[0]?.entityId).toBe("1111 1111 1111 1111");
		expect(storage.read()).toHaveLength(0);
	});

	it("merges pending mutations when storage backend swaps", async () => {
		const queue = new LocalMutationQueueService({
			executor: async () => ({ kind: "ack" }),
			storage: createMemoryMutationQueueStorage(),
		});

		const inMemoryQueueId = await queue.enqueue(
			makeCommand("column.reorder", { marker: "memory" }, 150),
		);

		const persistedMutation = {
			...makeCommand("column.hide_shared", { marker: "persisted" }, 100),
			queueId: "persisted-queue-id",
		};
		const swappedStorage = createMemoryMutationQueueStorage([persistedMutation]);

		let latestQueueIds: string[] = [];
		const subscription = queue.pending$().subscribe((pending) => {
			latestQueueIds = pending.map((mutation) => mutation.queueId);
		});

		queue.swapStorage(swappedStorage);
		subscription.unsubscribe();

		expect(new Set(latestQueueIds)).toEqual(
			new Set([inMemoryQueueId, persistedMutation.queueId]),
		);
		expect(new Set(swappedStorage.read().map((mutation) => mutation.queueId))).toEqual(
			new Set([inMemoryQueueId, persistedMutation.queueId]),
		);
	});

	it("stores and reads queued mutations from local-first storage", () => {
		const db = {
			collections: {
				accountSnapshot: new Map(),
				columnIndex: new Map(),
				columnMetaCache: new Map(),
				mutationOutbox: new Map(),
				yjsUpdateOutbox: new Map(),
				syncState: new Map(),
			},
			async close() {
				return;
			},
		} as unknown as LocalFirstDatabase;

		const storage = createLocalFirstMutationQueueStorage(db);
		const queuedMutation = {
			...makeCommand("column.create", { columnId: "col-1" }, 123),
			queueId: "queue-local-first",
			lastError: "temporary",
		};

		storage.write([queuedMutation]);
		expect(storage.read()).toEqual([queuedMutation]);
	});
});
