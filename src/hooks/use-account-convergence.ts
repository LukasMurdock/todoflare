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
export const COMMAND_SETTLEMENT_TIMEOUT_MS = 15_000;
export type AccountCommandOutcome =
	| "acknowledged"
	| "queued"
	| "terminal"
	| "signed_out"
	| "timed_out";

function isStableConvergenceSnapshot(
	snapshot: ReturnType<AccountConvergenceActor["getSnapshot"]>,
): boolean {
	return (
		snapshot.matches("ready") ||
		snapshot.matches("readyOffline") ||
		snapshot.matches("retryScheduled") ||
		snapshot.matches("signedOut")
	);
}

function reportOutcomeForQueue(
	report: ReplayReport | null,
	queueId: string,
): "acknowledged" | "terminal" | null {
	if (!report) return null;
	if (report.terminalFailures.some((failure) => failure.queueId === queueId)) {
		return "terminal";
	}
	return report.ackedCommands.some((command) => command.queueId === queueId)
		? "acknowledged"
		: null;
}

export async function persistAccountCommand<T extends AccountCommandType>(
	actor: AccountConvergenceActor,
	mutationQueue: LocalMutationQueueService,
	opType: T,
	payload: AccountCommandPayloadMap[NoInfer<T>],
	timeout = COMMAND_SETTLEMENT_TIMEOUT_MS,
): Promise<{
	queueId: string | null;
	outcome: AccountCommandOutcome;
	report: ReplayReport | null;
}> {
	const accountId = actor.getSnapshot().context.accountId;
	if (!accountId) {
		return { queueId: null, outcome: "signed_out", report: null };
	}

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
	actor.send({ type: "COMMAND_PERSISTED" });

	let snapshot: ReturnType<AccountConvergenceActor["getSnapshot"]>;
	try {
		snapshot = await waitFor(
			actor,
			(candidate) => {
				if (
					reportOutcomeForQueue(candidate.context.lastReplayReport, queueId)
				) {
					return true;
				}
				return isStableConvergenceSnapshot(candidate);
			},
			{ timeout },
		);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Timeout of ")) {
			return { queueId, outcome: "timed_out", report: null };
		}
		throw error;
	}

	const reportOutcome = reportOutcomeForQueue(
		snapshot.context.lastReplayReport,
		queueId,
	);
	if (reportOutcome) {
		return {
			queueId,
			outcome: reportOutcome,
			report: snapshot.context.lastReplayReport,
		};
	}
	if (snapshot.matches("signedOut")) {
		return { queueId, outcome: "signed_out", report: null };
	}
	const remainsQueued = mutationQueue
		.getPending(accountId)
		.some((command) => command.queueId === queueId);
	return {
		queueId,
		// A command that vanished without appearing in an acknowledgement report
		// was discarded by another reconciliation path; never infer success.
		outcome: remainsQueued ? "queued" : "terminal",
		report: null,
	};
}

export function accountConvergenceErrorMessage(
	error: AccountConvergenceError | null,
): string | null {
	if (!error) return null;
	if (error.scope === "auth") {
		if (error.kind === "invalid") return "Invalid account ID format";
		if (error.kind === "not_found") return "Account not found";
		return "Failed to authenticate account";
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
	const lastReplayReport = useSelector(
		actor,
		(snapshot) => snapshot.context.lastReplayReport,
	);
	const lastReplayDurationMs = useSelector(
		actor,
		(snapshot) => snapshot.context.lastReplayDurationMs,
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
		lastReplayReport,
		lastReplayDurationMs,
		error,
		isLoading,
	};
}

export function useAccountCommandSubmission(
	actor: AccountConvergenceActor,
	mutationQueue: LocalMutationQueueService,
) {
	const waitForStableConvergence = useCallback(
		() =>
			waitFor(actor, isStableConvergenceSnapshot, {
				timeout: COMMAND_SETTLEMENT_TIMEOUT_MS,
			}),
		[actor],
	);

	const submitAccountCommand = useCallback(
		async <T extends AccountCommandType>(
			opType: T,
			payload: AccountCommandPayloadMap[NoInfer<T>],
		) => {
			return persistAccountCommand(actor, mutationQueue, opType, payload);
		},
		[actor, mutationQueue],
	);

	return { submitAccountCommand, waitForStableConvergence };
}
