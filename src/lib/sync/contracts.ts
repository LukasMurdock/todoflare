import type { SyncMode } from "@/lib/sync/mode-machine";

export interface ObservableLike<T> {
	subscribe(next: (value: T) => void): { unsubscribe(): void };
}

export interface SyncStatus {
	mode: SyncMode;
	isNetworkOnline: boolean;
	isRealtimeDegraded: boolean;
	queueDepth: number;
}

export interface DispatchResult {
	accepted: boolean;
	commandId?: string;
	terminalReason?: TerminalReplayReason;
}

export type DropReason = "revoked" | "column_deleted" | "manual";

export type TerminalReplayReason =
	| "revoked"
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

export interface AccessContext {
	accountId: string | null;
	columnId: string;
	receivedAt: number;
	source: "replay" | "websocket" | "http";
}

export type AccessPolicy = "allowed" | "revoked" | "unknown";

export type SyncCommand =
	| {
		kind: "account.edit";
		command: AccountEditCommand;
	  }
	| {
		kind: "runtime.replay";
		maxBatch?: number;
	  }
	| {
		kind: "runtime.stop";
	  };

export interface SyncRuntime {
	start(): Promise<void>;
	stop(): Promise<void>;
	dispatch(command: SyncCommand): Promise<DispatchResult>;
	status$(): ObservableLike<SyncStatus>;
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

export interface AccessPolicyService {
	evaluate(ctx: AccessContext): Promise<AccessPolicy>;
	policy$(): ObservableLike<AccessPolicy>;
}
