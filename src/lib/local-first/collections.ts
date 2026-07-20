import type {
	Account,
	ColumnMeta,
	DeletedColumn,
} from "@/types/account";
import type { TerminalReplayReason } from "@/lib/sync/contracts";

export interface AccountSnapshotDoc {
	id: string;
	accountId: string;
	account: Account;
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	hydratedAt: number;
	reconciledAt: number | null;
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
