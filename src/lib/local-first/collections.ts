import type {
	Account,
	ColumnMeta,
	DeletedColumn,
	PublicLinkResponse,
} from "@/types/account";
import type { TerminalReplayReason } from "@/lib/sync/contracts";
import type { SyncMode } from "@/lib/sync/mode-machine";

export interface AccountSnapshotDoc {
	schemaVersion: 1;
	id: string;
	accountId: string;
	account: Account;
	sharedColumns: ColumnMeta[];
	deletedColumns: DeletedColumn[];
	sharedWithByColumn?: Record<string, string[] | undefined>;
	publicLinksByColumn?: Record<string, PublicLinkResponse | null>;
	hydratedAt: number;
	reconciledAt: number | null;
}

export interface YjsUpdateOutboxDoc {
	schemaVersion: 1;
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
	schemaVersion: 1;
	id: string;
	accountId: string | null;
	mode: SyncMode;
	queueDepth: number;
	yjsQueueDepth: number;
	lastServerHydrationAt: number | null;
	lastReplayAt: number | null;
	lastReplayLatencyMs: number | null;
	revokeDiscardCount: number;
	convergenceFailureCount: number;
	updatedAt: number;
}

export interface MutationOutboxDoc {
	schemaVersion: 1;
	id: string;
	queueId: string;
	idempotencyKey: string;
	opType: string;
	entityId: string;
	payload: unknown;
	createdAt: number;
	attemptCount: number;
	nextRetryAt: number;
	ackedAt: number | null;
	lastError: string | null;
	terminalReason: TerminalReplayReason | null;
	lastAttemptAt: number | null;
	insertedAt: number;
}

export type DurableCollectionName =
	| "accountSnapshot"
	| "mutationOutbox"
	| "yjsUpdateOutbox"
	| "syncState";

export interface QuarantinedRecord {
	schemaVersion: 1;
	id: string;
	sourceCollection: DurableCollectionName;
	sourceKey: string;
	detectedAt: number;
	category: "invalid" | "migration_failed" | "unsupported_version";
	foundVersion: number | null;
	reason: string;
	containsDurableMutation: boolean;
	raw: unknown;
}
