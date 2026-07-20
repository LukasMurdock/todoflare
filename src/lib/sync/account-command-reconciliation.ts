import type {
	AccountCommandDescriptor,
	ReplayReport,
} from "./contracts";
import { shouldApplyAccessLossPolicy } from "./replay-response";

function assertNever(value: never): never {
	throw new Error(`Unhandled account command: ${JSON.stringify(value)}`);
}

export function columnIdForAccountCommand(
	command: AccountCommandDescriptor,
): string | null {
	switch (command.opType) {
		case "column.create":
		case "column.delete":
		case "column.restore":
		case "column.share":
		case "column.revoke":
		case "column.public.enable":
		case "column.public.disable":
			return command.payload.columnId;
		case "column.reorder":
		case "column.hide_shared":
			return null;
		default:
			return assertNever(command);
	}
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
