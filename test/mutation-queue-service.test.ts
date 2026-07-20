import { describe, expect, it } from "vitest";
import {
	createAccountEditCommand,
	type AccountCommandPayloadMap,
	type AccountCommandType,
	type AccountEditCommand,
} from "../src/lib/sync/contracts";
import {
	createLocalFirstMutationQueueStorage,
	LocalMutationQueueService,
	createMemoryMutationQueueStorage,
} from "../src/lib/sync/mutation-queue-service";
import type { LocalFirstDatabase } from "../src/lib/local-first/database";

function makeCommand<T extends AccountCommandType>(
	opType: T,
	payload: AccountCommandPayloadMap[T],
	createdAt: number,
): AccountEditCommand<T> {
	return createAccountEditCommand(opType, payload, {
		idempotencyKey: crypto.randomUUID(),
		entityId: "1111 1111 1111 1111",
		createdAt,
		attemptCount: 0,
		nextRetryAt: createdAt,
	});
}

describe("LocalMutationQueueService", () => {
	it("replays commands in FIFO order by createdAt", async () => {
		const order: string[] = [];
		const queue = new LocalMutationQueueService({
			executor: async (mutation) => {
				if (mutation.opType === "column.reorder") {
					order.push(mutation.payload.columnOrder[0] ?? "");
				}
				return { kind: "ack" };
			},
			storage: createMemoryMutationQueueStorage(),
		});

		await queue.enqueue(
			makeCommand("column.reorder", { columnOrder: ["second"] }, 200),
		);
		await queue.enqueue(
			makeCommand("column.reorder", { columnOrder: ["first"] }, 100),
		);

		const report = await queue.replay({
			accountId: "1111 1111 1111 1111",
			maxBatch: 10,
		});

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
		await queue.enqueue(
			makeCommand("column.hide_shared", { hiddenSharedColumns: [] }, now),
		);
		const report = await queue.replay({
			accountId: "1111 1111 1111 1111",
			maxBatch: 10,
		});

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
		const report = await queue.replay({
			accountId: "1111 1111 1111 1111",
			maxBatch: 10,
		});

		expect(report.attempted).toBe(1);
		expect(report.dropped).toBe(1);
		expect(report.terminalFailures).toHaveLength(1);
		expect(report.terminalFailures[0]?.reason).toBe("validation_failed");
		expect(report.terminalFailures[0]?.opType).toBe("column.reorder");
		expect(report.terminalFailures[0]?.entityId).toBe("1111 1111 1111 1111");
		expect(storage.read()).toHaveLength(0);
	});

	it("scopes replay to one immutable account and returns command effects", async () => {
		const storage = createMemoryMutationQueueStorage();
		const queue = new LocalMutationQueueService({
			executor: async (mutation) => ({
				kind: "ack",
				effects:
					mutation.opType === "column.delete"
						? [
								{
									type: "column.deleted" as const,
									columnId: mutation.payload.columnId,
								},
							]
						: [],
			}),
			storage,
		});
		await queue.enqueue(
			makeCommand("column.delete", { columnId: "first" }, 100),
		);
		await queue.enqueue({
			...makeCommand("column.delete", { columnId: "second" }, 101),
			entityId: "2222 2222 2222 2222",
		});

		const report = await queue.replay({
			accountId: "1111 1111 1111 1111",
			maxBatch: 10,
		});

		expect(report.acked).toBe(1);
		expect(report.effects).toEqual([
			{ type: "column.deleted", columnId: "first" },
		]);
		expect(queue.getPending("1111 1111 1111 1111")).toEqual([]);
		expect(queue.getPending("2222 2222 2222 2222")).toHaveLength(1);
	});

	it("does not mutate retry metadata after an aborted replay", async () => {
		const storage = createMemoryMutationQueueStorage();
		const queue = new LocalMutationQueueService({
			executor: async (_mutation, options) =>
				new Promise((_, reject) => {
					options?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				}),
			storage,
		});
		await queue.enqueue(
			makeCommand("column.reorder", { columnOrder: [] }, 100),
		);
		const controller = new AbortController();
		const replay = queue.replay({
			accountId: "1111 1111 1111 1111",
			signal: controller.signal,
		});
		controller.abort();
		await replay;

		expect(storage.read()[0]?.attemptCount).toBe(0);
		expect(storage.read()[0]?.lastError).toBeUndefined();
	});

	it("merges pending mutations when storage backend swaps", async () => {
		const queueStorage = createMemoryMutationQueueStorage();
		const queue = new LocalMutationQueueService({
			executor: async () => ({ kind: "ack" }),
			storage: queueStorage,
		});

		const inMemoryQueueId = await queue.enqueue(
			makeCommand("column.reorder", { columnOrder: ["memory"] }, 150),
		);

		const persistedMutation = {
			...makeCommand(
				"column.hide_shared",
				{ hiddenSharedColumns: ["persisted"] },
				100,
			),
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
		const afterSwapId = await queue.enqueue(
			makeCommand("column.reorder", { columnOrder: ["mirrored"] }, 200),
		);
		expect(
			queueStorage.read().map((mutation) => mutation.queueId),
		).toContain(afterSwapId);
		expect(
			swappedStorage.read().map((mutation) => mutation.queueId),
		).toContain(afterSwapId);
	});

	it("stores and reads queued mutations from local-first storage", () => {
		const db = {
			collections: {
				accountSnapshot: new Map(),
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

	it("discards malformed records loaded from the persisted outbox", () => {
		const db = {
			collections: {
				accountSnapshot: new Map(),
				mutationOutbox: new Map<string, unknown>(),
				yjsUpdateOutbox: new Map(),
				syncState: new Map(),
			},
			async close() {
				return;
			},
		} satisfies LocalFirstDatabase;
		const storage = createLocalFirstMutationQueueStorage(db);
		const valid = {
			...makeCommand("column.delete", { columnId: "column-1" }, 123),
			queueId: "valid",
		};

		storage.write([valid]);
		db.collections.mutationOutbox.set("malformed", {
			...valid,
			queueId: "malformed",
			payload: { columnId: 42 },
		});

		expect(storage.read()).toEqual([valid]);
	});
});
