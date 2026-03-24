/**
 * Account stored in KV
 */
export interface Account {
	id: string; // "4829 1047 3856 2019" (formatted with spaces)
	columnOrder: string[]; // Column IDs in user's preferred order
	hiddenSharedColumns: string[]; // Shared columns user has hidden
	createdAt: number;
}

/**
 * Column metadata stored in Durable Object
 */
export interface ColumnMeta {
	id: string;
	ownerId: string; // Account ID that created this column
	sharedWith: string[]; // Account IDs with full edit access
	publicId: string | null; // Short ID for public read-only link (e.g., "x7Km9p2N")
	createdAt: number;
}

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
export interface CreateAccountResponse {
	account: Account;
}

export interface GetAccountResponse {
	account: Account;
	sharedColumns: ColumnMeta[]; // Columns shared TO this account
}

export interface CreateColumnResponse {
	column: ColumnMeta;
}

export interface ShareColumnRequest {
	accountId: string;
}

export interface PublicLinkResponse {
	publicId: string;
	url: string;
}

/**
 * Rate limit error response
 */
export interface RateLimitError {
	error: "rate_limited";
	retryAfter: number; // seconds
}
