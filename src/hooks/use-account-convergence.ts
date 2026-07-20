import { useCallback, useMemo } from "react";
import { useActorRef, useSelector } from "@xstate/react";
import { waitFor, type ActorRefFrom } from "xstate";
import {
	type AccountConvergenceError,
	type AccountConvergenceDependencies,
	type AccountConvergenceInput,
	createAccountConvergenceMachine,
} from "../lib/sync/account-convergence-machine";
import {
	createAccountEditCommand,
	type AccountCommandPayloadMap,
	type AccountCommandType,
	type ReplayReport,
} from "../lib/sync/contracts";
import type { LocalMutationQueueService } from "../lib/sync/mutation-queue-service";

type AccountConvergenceMachine = ReturnType<
	typeof createAccountConvergenceMachine
>;
export type AccountConvergenceActor = ActorRefFrom<AccountConvergenceMachine>;

export function accountConvergenceErrorMessage(
	error: AccountConvergenceError | null,
): string | null {
	if (!error) return null;
	if (error.scope === "auth") {
		return error.kind === "invalid"
			? "Invalid account ID format"
			: "Account not found";
	}
	if (error.scope === "access") return "Access revoked";
	if (error.kind === "rate_limited") {
		return "Account request was rate limited";
	}
	if (error.scope === "replay") {
		return error.kind === "terminal"
			? "Some offline changes could not be synced"
			: null;
	}
	return "Failed to synchronize account";
}

export function useAccountConvergence(
	dependencies: AccountConvergenceDependencies,
	input: AccountConvergenceInput,
) {
	const machine = useMemo(
		() => createAccountConvergenceMachine(dependencies),
		[dependencies],
	);
	const actor = useActorRef(machine, { input });
	const accountId = useSelector(actor, (snapshot) => snapshot.context.accountId);
	const projection = useSelector(
		actor,
		(snapshot) => snapshot.context.projection,
	);
	const queueDepth = useSelector(
		actor,
		(snapshot) => snapshot.context.queueDepth,
	);
	const lastReplayAt = useSelector(
		actor,
		(snapshot) => snapshot.context.lastReplayAt,
	);
	const lastConvergedAt = useSelector(
		actor,
		(snapshot) => snapshot.context.lastConvergedAt,
	);
	const error = useSelector(actor, (snapshot) => snapshot.context.error);
	const isLoading = useSelector(
		actor,
		(snapshot) =>
			(snapshot.matches("signedOut") && snapshot.context.accountId !== null) ||
			snapshot.matches("authenticating") ||
			snapshot.matches("loadingLocal") ||
			snapshot.matches("hydratingServer") ||
			snapshot.matches("confirmingServer"),
	);

	return {
		actor,
		accountId,
		projection,
		queueDepth,
		lastReplayAt,
		lastConvergedAt,
		error,
		isLoading,
	};
}

export function useAccountCommandSubmission(
	actor: AccountConvergenceActor,
	mutationQueue: LocalMutationQueueService,
	onReplay?: (report: ReplayReport, latencyMs: number) => void,
) {
	const waitForStableConvergence = useCallback(
		() =>
			waitFor(actor, (snapshot) =>
				snapshot.matches("ready") ||
				snapshot.matches("readyOffline") ||
				snapshot.matches("retryScheduled") ||
				snapshot.matches("signedOut"),
			),
		[actor],
	);

	const submitAccountCommand = useCallback(
		async <T extends AccountCommandType>(
			opType: T,
			payload: AccountCommandPayloadMap[NoInfer<T>],
		) => {
			const before = actor.getSnapshot();
			const accountId = before.context.accountId;
			if (!accountId) return { queueId: null, report: null };

			const createdAt = Date.now();
			const queueId = await mutationQueue.enqueue(
				createAccountEditCommand(opType, payload, {
					idempotencyKey: crypto.randomUUID(),
					entityId: accountId,
					createdAt,
					attemptCount: 0,
					nextRetryAt: createdAt,
				}),
			);
			const startedAt = Date.now();
			actor.send({ type: "COMMAND_PERSISTED" });
			const snapshot = await waitForStableConvergence();
			const report =
				snapshot.context.lastReplayReport === before.context.lastReplayReport
					? null
					: snapshot.context.lastReplayReport;
			if (report) onReplay?.(report, Math.max(0, Date.now() - startedAt));
			return { queueId, report };
		},
		[actor, mutationQueue, onReplay, waitForStableConvergence],
	);

	return { submitAccountCommand, waitForStableConvergence };
}
