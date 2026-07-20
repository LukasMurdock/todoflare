export interface ObservableLike<T> {
	subscribe(next: (value: T) => void): { unsubscribe(): void };
}

export type DropReason = "revoked" | "column_deleted" | "manual";

export type TerminalReplayReason =
	| "revoked"
	| "not_owner"
	| "not_found"
	| "validation_failed";

export type AccountCommandType =
	| "column.create"
	| "column.delete"
	| "column.restore"
	| "column.reorder"
	| "column.share"
	| "column.revoke"
	| "column.public.enable"
	| "column.public.disable"
	| "column.hide_shared";

export interface AccountEditCommand {
	idempotencyKey: string;
	opType: AccountCommandType;
	entityId: string;
	payload: Record<string, unknown>;
	createdAt: number;
	attemptCount: number;
	nextRetryAt: number;
}

export interface QueuedMutation extends AccountEditCommand {
	queueId: string;
	lastError?: string;
}

export interface ReplayCommandSummary {
	queueId: string;
	opType: AccountCommandType;
	entityId: string;
	payload: Record<string, unknown>;
}

export interface ReplayReport {
	attempted: number;
	acked: number;
	retried: number;
	dropped: number;
	ackedCommands: ReplayCommandSummary[];
	terminalFailures: Array<{
		queueId: string;
		reason: TerminalReplayReason;
		opType: AccountCommandType;
		entityId: string;
		payload: Record<string, unknown>;
	}>;
}

export interface MutationQueueService {
	enqueue(cmd: AccountEditCommand): Promise<string>;
	replay(options?: { maxBatch?: number }): Promise<ReplayReport>;
	dropWhere(
		predicate: (m: QueuedMutation) => boolean,
		reason: DropReason,
	): Promise<number>;
	pending$(): ObservableLike<QueuedMutation[]>;
}
