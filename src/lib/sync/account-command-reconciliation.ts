import type {
	AccountCommandDescriptor,
	ReplayReport,
	TerminalReplayFailure,
} from "./contracts";
import { shouldApplyAccessLossPolicy } from "./replay-response";
import { ACCOUNT_COMMANDS } from "../api/account-commands";
import type { SyncFailureDoc } from "../local-first/collections";

export function columnIdForAccountCommand(
	command: AccountCommandDescriptor,
): string | null {
	const { affectedColumnId } = ACCOUNT_COMMANDS[command.opType] as {
		affectedColumnId(payload: AccountCommandDescriptor["payload"]): string | null;
	};
	return affectedColumnId(command.payload);
}

export interface ReplayReconciliationSummary {
	ackedCreatedColumnIds: string[];
	failedCreatedColumnIds: string[];
	accessLostColumnIds: string[];
	nonAccessLossFailureCount: number;
}

/** Pure projection of replay outcomes for React state reconciliation. */
export function summarizeReplayReport(
	report: ReplayReport,
): ReplayReconciliationSummary {
	const ackedCreatedColumnIds = report.ackedCommands.flatMap((command) =>
		command.opType === "column.create" ? [command.payload.columnId] : [],
	);
	const failedCreatedColumnIds = report.terminalFailures.flatMap((failure) =>
		failure.opType === "column.create" ? [failure.payload.columnId] : [],
	);
	const accessLostColumnIds = new Set<string>();
	let nonAccessLossFailureCount = 0;

	for (const failure of report.terminalFailures) {
		if (!shouldApplyAccessLossPolicy(failure.reason)) {
			nonAccessLossFailureCount += 1;
			continue;
		}

		const columnId = columnIdForAccountCommand(failure);
		if (columnId) accessLostColumnIds.add(columnId);
	}

	return {
		ackedCreatedColumnIds,
		failedCreatedColumnIds,
		accessLostColumnIds: [...accessLostColumnIds],
		nonAccessLossFailureCount,
	};
}

/** A rejected command as it appears in the sync debug snapshot. */
export type RecordedSyncFailure = SyncFailureDoc;

export function recordSyncFailure(failure: TerminalReplayFailure, now: number): RecordedSyncFailure {
	return {
		failedAt: failure.failedAt ?? now,
		opType: failure.opType,
		columnId: columnIdForAccountCommand(failure),
		reason: failure.reason,
		status: failure.detail?.status ?? null,
		code: failure.detail?.code ?? null,
		message: failure.detail?.message ?? null,
	};
}

/** One line naming the command and what the server said, e.g. for a toast. */
export function describeSyncFailure(failure: RecordedSyncFailure): string {
	const response = [failure.status, failure.code ?? failure.reason].filter((part) => part !== null).join(" ");
	return failure.message
		? `${failure.opType}: ${failure.message} (${response})`
		: `${failure.opType}: ${response}`;
}
