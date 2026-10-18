import type { z } from "zod";
import type {
	accountContractSchema,
	columnMetaContractSchema,
	createAccountResponseSchema,
	deletedColumnContractSchema,
	getAccountResponseSchema,
	publicLinkContractSchema,
} from "../lib/api/account-contract";

/*
 * Account, column and response shapes are declared once, as zod schemas in
 * src/lib/api/account-contract.ts; these types are derived from them.
 */
export type Account = z.output<typeof accountContractSchema>;
export type ColumnMeta = z.output<typeof columnMetaContractSchema>;
export type DeletedColumn = z.output<typeof deletedColumnContractSchema>;

/**
 * Presence user for real-time awareness
 */
export interface PresenceUser {
	accountId: string;
	color: string;
	connectedAt: number;
}

/**
 * WebSocket message types for sync
 */
export type SyncMessage =
	| { type: "sync"; data: Uint8Array } // Yjs sync message
	| { type: "sync-ack"; outboxId: string } // Durable receipt for a submitted Yjs update
	| { type: "awareness"; data: Uint8Array } // Yjs awareness update
	| { type: "presence"; users: PresenceUser[] } // Presence list update
	| { type: "error"; message: string }
	| { type: "column-deleted" }
	| { type: "access-revoked" };

/**
 * Connection status for UI
 */
export type ConnectionStatus = "connected" | "connecting" | "offline";

/**
 * API response types
 */
export type CreateAccountResponse = z.output<typeof createAccountResponseSchema>;
export type GetAccountResponse = z.output<typeof getAccountResponseSchema>;
export type PublicLinkResponse = z.output<typeof publicLinkContractSchema>;

export interface AccountExportColumn {
	meta: ColumnMeta;
	yjs: number[] | null;
}

export interface AccountExportPayloadV1 {
	schemaVersion: 1;
	exportedAt: number;
	account: Account;
	ownedColumns: AccountExportColumn[];
}

export interface AccountExportPayload {
	schemaVersion: 2;
	exportedAt: number;
	complete: true;
	expectedColumnIds: string[];
	account: Account;
	ownedColumns: AccountExportColumn[];
}

export type AccountImportPayload = AccountExportPayloadV1 | AccountExportPayload;

/**
 * Rate limit error response
 */
export interface RateLimitError {
	error: "rate_limited";
	retryAfter: number; // seconds
}
