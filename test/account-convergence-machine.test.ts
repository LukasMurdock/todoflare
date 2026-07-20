import { createActor, waitFor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import {
	AccountConvergenceFailure,
	createAccountConvergenceMachine,
	type AccountConvergenceDependencies,
	type AccountConvergenceEvent,
} from "../src/lib/sync/account-convergence-machine";
import { projectionFromServer } from "../src/lib/sync/account-projection";
import type { QueuedMutation, ReplayReport } from "../src/lib/sync/contracts";

const ACCOUNT_ID = "1111 1111 1111 1111";
const COLUMN_ID = "00000000-0000-4000-8000-000000000001";

function projection(columnOrder: string[] = []) {
	return projectionFromServer({
		account: {
			schemaVersion: 1,
			id: ACCOUNT_ID,
			columnOrder,
			hiddenSharedColumns: [],
			createdAt: 1,
		},
		sharedColumns: [],
		deletedColumns: [],
	});
}

function sharedProjection() {
	const value = projection();
	return {
		...value,
		sharedColumns: [
			{
				schemaVersion: 1 as const,
				id: COLUMN_ID,
				ownerId: "2222 2222 2222 2222",
				sharedWith: [ACCOUNT_ID],
				publicId: null,
				createdAt: 1,
			},
		],
	};
}

function queuedCreate(): QueuedMutation<"column.create"> {
	return {
		opType: "column.create",
		payload: { columnId: COLUMN_ID },
		queueId: "queue:create",
		idempotencyKey: "key:create",
		entityId: ACCOUNT_ID,
		createdAt: 2,
		attemptCount: 0,
		nextRetryAt: 0,
	};
}

function emptyReport(): ReplayReport {
	return {
		attempted: 0,
		acked: 0,
		retried: 0,
		dropped: 0,
		ackedCommands: [],
		terminalFailures: [],
		effects: [],
	};
}

function harness(options?: {
	online?: boolean;
	local?: ReturnType<typeof projection> | null;
	server?: ReturnType<typeof projection>;
	pending?: QueuedMutation[];
	replay?: (signal: AbortSignal) => Promise<ReplayReport>;
}) {
	let pending = [...(options?.pending ?? [])];
	const persistedCredentials: Array<string | null> = [];
	const fetchSignals: AbortSignal[] = [];
	let serverFetchCount = 0;
	const dependencies: AccountConvergenceDependencies = {
		loadLocal: async () => options?.local ?? null,
		fetchServer: async (_accountId, signal) => {
			fetchSignals.push(signal);
			serverFetchCount += 1;
			return options?.server ?? projection();
		},
		login: async () => options?.server ?? projection(),
		createAccount: async () => options?.server ?? projection(),
		replay: async (_accountId, signal) => {
			if (options?.replay) return options.replay(signal);
			return emptyReport();
		},
		getPending: () => [...pending],
		getNextRetryAt: () =>
			pending.length > 0
				? Math.min(...pending.map((command) => command.nextRetryAt))
				: null,
		persistCredential: (accountId) => persistedCredentials.push(accountId),
		reconcileAccessLoss: async () => {},
		now: () => 100,
	};
	const actor = createActor(createAccountConvergenceMachine(dependencies), {
		input: { networkOnline: options?.online ?? true },
	}).start();

	return {
		actor,
		fetchSignals,
		persistedCredentials,
		getServerFetchCount: () => serverFetchCount,
		setPending: (next: QueuedMutation[]) => {
			pending = [...next];
		},
	};
}

describe("account convergence machine", () => {
	it("loads the cached projection and remains ready while offline", async () => {
		const test = harness({ online: false, local: projection(["cached"]) });
		test.actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });

		const snapshot = await waitFor(test.actor, (state) =>
			state.matches("readyOffline"),
		);

		expect(snapshot.context.projection?.account.columnOrder).toEqual(["cached"]);
		expect(test.getServerFetchCount()).toBe(0);
	});

	it("layers durable pending commands over a stale server hydration", async () => {
		const test = harness({
			local: projection([COLUMN_ID]),
			server: projection([]),
			pending: [queuedCreate()],
		});
		test.actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });

		const snapshot = await waitFor(test.actor, (state) =>
			state.matches("retryScheduled"),
		);

		expect(snapshot.context.projection?.account.columnOrder).toEqual([COLUMN_ID]);
		expect(snapshot.context.serverBase?.account.columnOrder).toEqual([]);
	});

	it("runs hydrate, replay, reconcile, and confirmation in order", async () => {
		const order: string[] = [];
		let pending: QueuedMutation[] = [queuedCreate()];
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => {
				order.push("local");
				return projection([COLUMN_ID]);
			},
			fetchServer: async () => {
				order.push("hydrate");
				return projection([COLUMN_ID]);
			},
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => {
				order.push("replay");
				const command = pending[0]!;
				pending = [];
				return {
					...emptyReport(),
					attempted: 1,
					acked: 1,
					ackedCommands: [command],
				};
			},
			getPending: () => [...pending],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async () => {
				order.push("reconcile");
			},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true },
		}).start();
		actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });

		await waitFor(actor, (state) => state.matches("ready"));

		expect(order).toEqual([
			"local",
			"hydrate",
			"replay",
			"reconcile",
			"hydrate",
		]);
	});

	it("reconciles shared-column access lost during server hydration", async () => {
		const reconciled: string[][] = [];
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => sharedProjection(),
			fetchServer: async () => projection(),
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => emptyReport(),
			getPending: () => [],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async (_accountId, columnIds) => {
				reconciled.push(columnIds);
			},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true },
		}).start();
		actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });

		const snapshot = await waitFor(actor, (state) => state.matches("ready"));

		expect(reconciled).toEqual([[COLUMN_ID]]);
		expect(snapshot.context.projection?.sharedColumns).toEqual([]);
	});

	it("cancels an in-flight hydration to replay a newly persisted command", async () => {
		let pending: QueuedMutation[] = [];
		let firstHydrationSignal: AbortSignal | null = null;
		let fetchCount = 0;
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => projection([]),
			fetchServer: (_accountId, signal) => {
				fetchCount += 1;
				if (fetchCount === 1) {
					firstHydrationSignal = signal;
					return new Promise(() => {});
				}
				return Promise.resolve(projection([COLUMN_ID]));
			},
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => {
				const command = pending[0]!;
				pending = [];
				return {
					...emptyReport(),
					attempted: 1,
					acked: 1,
					ackedCommands: [command],
				};
			},
			getPending: () => [...pending],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true },
		}).start();
		actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });
		await waitFor(actor, (state) => state.matches("hydratingServer"));

		pending = [queuedCreate()];
		actor.send({ type: "COMMAND_PERSISTED" });
		const snapshot = await waitFor(actor, (state) => state.matches("ready"));

		expect((firstHydrationSignal as AbortSignal | null)?.aborted).toBe(true);
		expect(snapshot.context.projection?.account.columnOrder).toEqual([COLUMN_ID]);
		expect(fetchCount).toBe(2);
	});

	it("classifies authentication failures and returns to signed out", async () => {
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => null,
			fetchServer: async () => projection(),
			login: async () => {
				throw new AccountConvergenceFailure(
					{ scope: "auth", kind: "not_found" },
					"missing",
				);
			},
			createAccount: async () => projection(),
			replay: async () => emptyReport(),
			getPending: () => [],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true },
		}).start();

		actor.send({ type: "LOGIN", accountId: ACCOUNT_ID });
		const snapshot = await waitFor(
			actor,
			(state) => state.matches("signedOut") && state.context.error !== null,
		);

		expect(snapshot.context.accountId).toBeNull();
		expect(snapshot.context.error).toEqual({
			scope: "auth",
			kind: "not_found",
		});
	});

	it("retries hydration failures through hydration rather than replay", async () => {
		vi.useFakeTimers();
		try {
			let fetchCount = 0;
			let replayCount = 0;
			const dependencies: AccountConvergenceDependencies = {
				loadLocal: async () => projection(),
				fetchServer: async () => {
					fetchCount += 1;
					if (fetchCount === 1) {
						throw new AccountConvergenceFailure(
							{ scope: "hydrate", kind: "rate_limited" },
							"retry",
						);
					}
					return projection();
				},
				login: async () => projection(),
				createAccount: async () => projection(),
				replay: async () => {
					replayCount += 1;
					return emptyReport();
				},
				getPending: () => [],
				getNextRetryAt: () => null,
				persistCredential: () => {},
				reconcileAccessLoss: async () => {},
			};
			const actor = createActor(createAccountConvergenceMachine(dependencies), {
				input: { networkOnline: true, restoredAccountId: ACCOUNT_ID },
			}).start();
			await waitFor(actor, (state) => state.matches("retryScheduled"));
			expect(actor.getSnapshot().context.retryKind).toBe("hydrate");

			await vi.advanceTimersByTimeAsync(5_000);
			await waitFor(actor, (state) => state.matches("ready"));

			expect(fetchCount).toBe(2);
			expect(replayCount).toBe(1);
			actor.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries replay exceptions without repeating server hydration", async () => {
		vi.useFakeTimers();
		try {
			let fetchCount = 0;
			let replayCount = 0;
			const dependencies: AccountConvergenceDependencies = {
				loadLocal: async () => projection(),
				fetchServer: async () => {
					fetchCount += 1;
					return projection();
				},
				login: async () => projection(),
				createAccount: async () => projection(),
				replay: async () => {
					replayCount += 1;
					if (replayCount === 1) throw new Error("temporary");
					return emptyReport();
				},
				getPending: () => [],
				getNextRetryAt: () => null,
				persistCredential: () => {},
				reconcileAccessLoss: async () => {},
			};
			const actor = createActor(createAccountConvergenceMachine(dependencies), {
				input: { networkOnline: true, restoredAccountId: ACCOUNT_ID },
			}).start();
			await waitFor(actor, (state) => state.matches("retryScheduled"));
			expect(actor.getSnapshot().context.retryKind).toBe("replay");

			await vi.advanceTimersByTimeAsync(5_000);
			await waitFor(actor, (state) => state.matches("ready"));

			expect(fetchCount).toBe(1);
			expect(replayCount).toBe(2);
			actor.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves a classified terminal replay failure after confirmation", async () => {
		let pending: QueuedMutation[] = [queuedCreate()];
		const failed = pending[0]!;
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => projection(),
			fetchServer: async () => projection(),
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => {
				pending = [];
				return {
					...emptyReport(),
					attempted: 1,
					dropped: 1,
					terminalFailures: [{ ...failed, reason: "validation_failed" }],
				};
			},
			getPending: () => [...pending],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true, restoredAccountId: ACCOUNT_ID },
		}).start();

		const snapshot = await waitFor(actor, (state) => state.matches("ready"));
		expect(snapshot.context.error).toEqual({
			scope: "replay",
			kind: "terminal",
		});
	});

	it("replays a command persisted while server confirmation is in flight", async () => {
		let pending: QueuedMutation[] = [queuedCreate()];
		let replayCount = 0;
		let fetchCount = 0;
		const confirmation = { release: null as (() => void) | null };
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => projection(),
			fetchServer: async () => {
				fetchCount += 1;
				if (fetchCount === 2) {
					await new Promise<void>((resolve) => {
						confirmation.release = resolve;
					});
				}
				return projection();
			},
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => {
				replayCount += 1;
				const commands = pending;
				pending = [];
				return {
					...emptyReport(),
					attempted: commands.length,
					acked: commands.length,
					ackedCommands: commands,
				};
			},
			getPending: () => [...pending],
			getNextRetryAt: () => (pending.length > 0 ? 0 : null),
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true, restoredAccountId: ACCOUNT_ID },
		}).start();
		await waitFor(actor, (state) => state.matches("confirmingServer"));

		pending = [{ ...queuedCreate(), queueId: "queue:during-confirmation" }];
		actor.send({ type: "COMMAND_PERSISTED" });
		confirmation.release?.();
		await waitFor(actor, (state) => state.matches("ready"));

		expect(replayCount).toBe(2);
		expect(fetchCount).toBe(3);
	});

	it("keeps realtime transport policy outside account convergence events", () => {
		const networkEvent: AccountConvergenceEvent = { type: "NETWORK_ONLINE" };
		expect(networkEvent.type).toBe("NETWORK_ONLINE");
		// @ts-expect-error Realtime policy belongs to column actors.
		const realtimeEvent: AccountConvergenceEvent = { type: "REALTIME_DISABLED" };
		expect(realtimeEvent.type).toBe("REALTIME_DISABLED");
	});

	it("aborts hydration and rejects its result after logout", async () => {
		let resolveHydration: ((value: ReturnType<typeof projection>) => void) | null =
			null;
		let hydrationSignal: AbortSignal | null = null;
		const dependencies: AccountConvergenceDependencies = {
			loadLocal: async () => projection(["cached"]),
			fetchServer: (_accountId, signal) => {
				hydrationSignal = signal;
				return new Promise((resolve) => {
					resolveHydration = resolve;
				});
			},
			login: async () => projection(),
			createAccount: async () => projection(),
			replay: async () => emptyReport(),
			getPending: () => [],
			getNextRetryAt: () => null,
			persistCredential: () => {},
			reconcileAccessLoss: async () => {},
		};
		const actor = createActor(createAccountConvergenceMachine(dependencies), {
			input: { networkOnline: true },
		}).start();
		actor.send({ type: "RESTORE_SESSION", accountId: ACCOUNT_ID });
		await waitFor(actor, (state) => state.matches("hydratingServer"));

		actor.send({ type: "LOGOUT" });
		expect(actor.getSnapshot().matches("signedOut")).toBe(true);
		expect((hydrationSignal as AbortSignal | null)?.aborted).toBe(true);
		if (resolveHydration) {
			(resolveHydration as (value: ReturnType<typeof projection>) => void)(
				projection(["server"]),
			);
		}
		await Promise.resolve();
		expect(actor.getSnapshot().context.projection).toBeNull();
	});
});
