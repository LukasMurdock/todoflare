export interface ObservableLike<T> {
	subscribe(next: (value: T) => void): { unsubscribe(): void };
}

export type DropReason = "revoked" | "column_deleted" | "manual";

export type TerminalReplayReason =
	| "revoked"
	| "not_owner"
	| "not_found"
	| "validation_failed";

export const ACCOUNT_COMMAND_TYPES = [
	"column.create",
	"column.delete",
	"column.restore",
	"column.reorder",
	"column.share",
	"column.revoke",
	"column.public.enable",
	"column.public.disable",
	"column.hide_shared",
] as const;

export type AccountCommandType = (typeof ACCOUNT_COMMAND_TYPES)[number];

export interface AccountCommandPayloadMap {
	"column.create": { columnId: string };
	"column.delete": { columnId: string };
	"column.restore": { columnId: string };
	"column.reorder": { columnOrder: string[] };
	"column.share": { columnId: string; targetAccountId: string };
	"column.revoke": { columnId: string; targetAccountId: string };
	"column.public.enable": { columnId: string };
	"column.public.disable": { columnId: string };
	"column.hide_shared": { hiddenSharedColumns: string[] };
}

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
	? Pick<QueuedMutation<T>, "queueId" | "opType" | "entityId" | "payload">
	: never;

export type TerminalReplayFailure<
	T extends AccountCommandType = AccountCommandType,
> = ReplayCommandSummary<T> & { reason: TerminalReplayReason };

export interface ReplayReport {
	attempted: number;
	acked: number;
	retried: number;
	dropped: number;
	ackedCommands: ReplayCommandSummary[];
	terminalFailures: TerminalReplayFailure[];
}

export interface MutationQueueService {
	enqueue<T extends AccountCommandType>(cmd: AccountEditCommand<T>): Promise<string>;
	replay(options?: { maxBatch?: number }): Promise<ReplayReport>;
	dropWhere(
		predicate: (m: QueuedMutation) => boolean,
		reason: DropReason,
	): Promise<number>;
	pending$(): ObservableLike<QueuedMutation[]>;
}
