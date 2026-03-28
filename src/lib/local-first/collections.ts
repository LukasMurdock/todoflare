import type {
	Account,
	ColumnMeta,
	DeletedColumn,
} from "@/types/account";
import type {
	AccessPolicy,
	AccountEditCommand,
	TerminalReplayReason,
} from "@/lib/sync/contracts";

export const LOCAL_FIRST_COLLECTIONS = {
	accountSnapshot: "account_snapshot",
	columnIndex: "column_index",
	columnMetaCache: "column_meta_cache",
	mutationOutbox: "mutation_outbox",
	yjsUpdateOutbox: "yjs_update_outbox",
	syncState: "sync_state",
} as const;

export interface AccountSnapshotDoc {
	id: string;
	accountId: string;
	account: Account;
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	hydratedAt: number;
	reconciledAt: number | null;
}

export interface ColumnIndexDoc {
	id: string;
	accountId: string;
	ownedColumnIds: string[];
	sharedVisibleColumnIds: string[];
	hiddenSharedColumnIds: string[];
	updatedAt: number;
}

export interface ColumnMetaCacheDoc {
	id: string;
	columnId: string;
	ownerId: string;
	sharedWith: string[];
	publicId: string | null;
	accessPolicy: AccessPolicy;
	updatedAt: number;
}

export interface MutationOutboxDoc extends AccountEditCommand {
	id: string;
	queueId: string;
	ackedAt: number | null;
	lastError: string | null;
	terminalReason: TerminalReplayReason | null;
	lastAttemptAt: number | null;
	insertedAt: number;
}

export interface YjsUpdateOutboxDoc {
	id: string;
	accountId: string;
	columnId: string;
	kind: "sync" | "awareness";
	updateBytes: number[];
	stateVectorBytes: number[] | null;
	createdAt: number;
	attemptCount: number;
	nextRetryAt: number;
	ackedAt: number | null;
	terminalReason: TerminalReplayReason | null;
	lastError: string | null;
}

export interface SyncStateDoc {
	id: string;
	accountId: string | null;
	mode: "guest_local" | "account_offline" | "account_syncing" | "account_realtime" | "public_readonly";
	queueDepth: number;
	yjsQueueDepth: number;
	lastServerHydrationAt: number | null;
	lastReplayAt: number | null;
	lastReplayLatencyMs: number | null;
	revokeDiscardCount: number;
	convergenceFailureCount: number;
	updatedAt: number;
}
