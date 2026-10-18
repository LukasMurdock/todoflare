import type {
	AccountCommandDescriptor,
	ReplayReport,
} from "./contracts";
import { shouldApplyAccessLossPolicy } from "./replay-response";
import { ACCOUNT_COMMANDS } from "../api/account-commands";

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
