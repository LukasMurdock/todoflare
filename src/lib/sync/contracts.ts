import type { ColumnMeta, PublicLinkResponse } from "../../types/account";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
} from "../api/account-commands";

export interface ObservableLike<T> {
	subscribe(next: (value: T) => void): { unsubscribe(): void };
}

export type DropReason = "revoked" | "column_deleted" | "manual";

export const TERMINAL_REPLAY_REASONS = [
	"revoked",
	"not_owner",
	"not_found",
	"validation_failed",
] as const;

export type TerminalReplayReason = (typeof TERMINAL_REPLAY_REASONS)[number];

export {
	ACCOUNT_COMMAND_TYPES,
	type AccountCommandPayloadMap,
	type AccountCommandType,
} from "../api/account-commands";

export type AccountCommandDescriptor<
	T extends AccountCommandType = AccountCommandType,
> = T extends AccountCommandType
	? { opType: T; payload: AccountCommandPayloadMap[T] }
	: never;

interface AccountEditCommandBase {
	idempotencyKey: string;
	entityId: string;
	createdAt: number;
	attemptCount: number;
	nextRetryAt: number;
}

export type NewAccountEditCommandFields = AccountEditCommandBase;

export type AccountEditCommand<
	T extends AccountCommandType = AccountCommandType,
> = T extends AccountCommandType
	? AccountEditCommandBase & AccountCommandDescriptor<T>
	: never;

export function createAccountEditCommand<T extends AccountCommandType>(
	opType: T,
	payload: AccountCommandPayloadMap[NoInfer<T>],
	fields: NewAccountEditCommandFields,
): AccountEditCommand<T> {
	return { ...fields, opType, payload } as AccountEditCommand<T>;
}

interface QueuedMutationFields {
	queueId: string;
	lastError?: string;
}

export type QueuedMutation<
	T extends AccountCommandType = AccountCommandType,
> = AccountEditCommand<T> & QueuedMutationFields;

export type ReplayCommandSummary<
	T extends AccountCommandType = AccountCommandType,
> = T extends AccountCommandType
	? Pick<
			QueuedMutation<T>,
			"queueId" | "opType" | "entityId" | "payload" | "createdAt"
	  >
	: never;

export type TerminalReplayFailure<
	T extends AccountCommandType = AccountCommandType,
> = ReplayCommandSummary<T> & { reason: TerminalReplayReason };

export type AccountCommandEffect =
	| { type: "column.created"; queueId: string; column: ColumnMeta }
	| { type: "column.deleted"; columnId: string }
	| { type: "column.sharing.updated"; columnId: string; sharedWith: string[] }
	| {
			type: "column.public.enabled";
			queueId: string;
			columnId: string;
			publicLink: PublicLinkResponse;
	  }
	| { type: "column.public.disabled"; columnId: string };

export interface ReplayReport {
	authenticationRequired?: boolean;
	attempted: number;
	acked: number;
	retried: number;
	dropped: number;
	ackedCommands: ReplayCommandSummary[];
	terminalFailures: TerminalReplayFailure[];
	effects: AccountCommandEffect[];
}

export interface MutationQueueService {
	enqueue<T extends AccountCommandType>(cmd: AccountEditCommand<T>): Promise<string>;
	replay(options: {
		accountId: string;
		signal?: AbortSignal;
		maxBatch?: number;
	}): Promise<ReplayReport>;
	dropWhere(
		predicate: (m: QueuedMutation) => boolean,
		reason: DropReason,
	): Promise<number>;
	pending$(): ObservableLike<QueuedMutation[]>;
	getPending(accountId: string): QueuedMutation[];
	getNextRetryAt(accountId: string): number | null;
}
