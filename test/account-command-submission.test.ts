import { createActor, waitFor } from "xstate";
import { describe, expect, it } from "vitest";
import { persistAccountCommand } from "../src/hooks/use-account-convergence";
import { createAccountConvergenceMachine } from "../src/lib/sync/account-convergence-machine";
import { projectionFromServer } from "../src/lib/sync/account-projection";
import {
	LocalMutationQueueService,
	type MutationQueueStorage,
} from "../src/lib/sync/mutation-queue-service";
import type { QueuedMutation } from "../src/lib/sync/contracts";

const ACCOUNT_ID = "1111 1111 1111 1111";
const FIRST_COLUMN_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_COLUMN_ID = "00000000-0000-4000-8000-000000000002";

function projection() {
	return projectionFromServer({
		account: {
			schemaVersion: 1,
			id: ACCOUNT_ID,
			columnOrder: [],
			hiddenSharedColumns: [],
			createdAt: 1,
		},
		ownedColumns: [],
		sharedColumns: [],
		deletedColumns: [],
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function memoryStorage(): MutationQueueStorage {
	let stored: QueuedMutation[] = [];
	return {
		read: () => stored.map((mutation) => ({ ...mutation })),
		write: (mutations) => {
			stored = mutations.map((mutation) => ({ ...mutation }));
		},
	};
}

function actorForQueue(queue: LocalMutationQueueService) {
	return createActor(
		createAccountConvergenceMachine({
			loadLocal: async () => projection(),
			fetchServer: async () => projection(),
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: (accountId, signal) =>
				queue.replay({ accountId, signal, maxBatch: 50 }),
			getPending: (accountId) => queue.getPending(accountId),
			getNextRetryAt: (accountId) => queue.getNextRetryAt(accountId),
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		}),
		{ input: { networkOnline: true, restoredAccountId: ACCOUNT_ID } },
	).start();
}

describe("account command submission", () => {
	it("settles concurrent submissions against their own queue ids", async () => {
		const first = deferred();
		const second = deferred();
		const firstStarted = deferred();
		const secondStarted = deferred();
		let execution = 0;
		const queue = new LocalMutationQueueService({
			storage: memoryStorage(),
			executor: async () => {
				execution += 1;
				if (execution === 1) {
					firstStarted.resolve();
					await first.promise;
				} else {
					secondStarted.resolve();
					await second.promise;
				}
				return { kind: "ack" };
			},
		});
		const actor = actorForQueue(queue);
		await waitFor(actor, (state) => state.matches("ready"));

		const firstSubmission = persistAccountCommand(
			actor,
			queue,
			"column.create",
			{ columnId: FIRST_COLUMN_ID },
		);
		await firstStarted.promise;
		const secondSubmission = persistAccountCommand(
			actor,
			queue,
			"column.create",
			{ columnId: SECOND_COLUMN_ID },
		);
		first.resolve();

		const firstResult = await firstSubmission;
		const secondResult = await secondSubmission;
		expect(firstResult.outcome).toBe("acknowledged");
		expect(firstResult.report?.ackedCommands[0]?.queueId).toBe(
			firstResult.queueId,
		);
		expect(secondResult).toMatchObject({ outcome: "queued", report: null });

		await secondStarted.promise;
		second.resolve();
		await waitFor(actor, (state) => state.matches("ready"));
		actor.stop();
	});

	it("times out settlement without removing the durable command", async () => {
		const started = deferred();
		const queue = new LocalMutationQueueService({
			storage: memoryStorage(),
			executor: async () => {
				started.resolve();
				return new Promise(() => {});
			},
		});
		const actor = actorForQueue(queue);
		await waitFor(actor, (state) => state.matches("ready"));

		const submission = persistAccountCommand(
			actor,
			queue,
			"column.create",
			{ columnId: FIRST_COLUMN_ID },
			25,
		);
		await started.promise;
		const result = await submission;

		expect(result.outcome).toBe("timed_out");
		expect(queue.getPending(ACCOUNT_ID)).toHaveLength(1);
		actor.stop();
	});
});
