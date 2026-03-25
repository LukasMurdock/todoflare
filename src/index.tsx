import { Hono } from "hono";
import type { Context } from "hono";
import type { Account, ColumnMeta } from "./types/account";
import {
	generateAccountId,
	normalizeAccountId,
	displayAccountId,
	validateAccountId,
	generatePublicId,
} from "./lib/account";
import {
	checkRateLimit,
	getClientIP,
	ipRateLimitKey,
	resourceRateLimitKey,
	RATE_LIMITS,
} from "./lib/rate-limit";
import { ColumnRoomSql } from "./durable-objects/column-room";

// Re-export Durable Objects for Cloudflare
export { ColumnRoomSql };

type Bindings = {
	ACCOUNTS: KVNamespace;
	RATE_LIMIT: KVNamespace;
	COLUMN_ROOM: DurableObjectNamespace;
	RATE_LIMIT_DISABLED?: string;
	READ_ONLY_MODE?: string;
	BACKUPS?: R2Bucket;
	BACKUP_ADMIN_TOKEN?: string;
	AUTO_BACKUP_ENABLED?: string;
	BACKUP_MAX_COLUMNS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const ACCOUNT_SCHEMA_VERSION = 1;
const COLUMN_META_SCHEMA_VERSION = 1;

type SchemaParseErrorCode =
	| "invalid_json"
	| "unsupported_schema_version"
	| "invalid_shape";

type SchemaParseResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code: SchemaParseErrorCode;
			message: string;
			foundVersion?: number;
			expectedVersion: number;
	  };

function schemaErrorResponse(
	kind: "account" | "column_meta",
	result: Extract<SchemaParseResult<unknown>, { ok: false }>,
) {
	return Response.json(
		{
			error: "schema_guard_blocked",
			kind,
			code: result.code,
			message: result.message,
			expectedVersion: result.expectedVersion,
			foundVersion: result.foundVersion ?? null,
		},
		{ status: 503 },
	);
}

function parseAccountRecord(raw: string): SchemaParseResult<Account> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			code: "invalid_json",
			message: "Account record is invalid JSON",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Account record has invalid shape",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	const obj = parsed as Partial<Account> & { schemaVersion?: number };
	const foundVersion = obj.schemaVersion ?? ACCOUNT_SCHEMA_VERSION;
	if (foundVersion !== ACCOUNT_SCHEMA_VERSION) {
		return {
			ok: false,
			code: "unsupported_schema_version",
			message: "Account schema version is not supported",
			foundVersion,
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	if (
		typeof obj.id !== "string" ||
		!Array.isArray(obj.columnOrder) ||
		!Array.isArray(obj.hiddenSharedColumns) ||
		typeof obj.createdAt !== "number"
	) {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Account record missing required fields",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	return {
		ok: true,
		value: {
			schemaVersion: ACCOUNT_SCHEMA_VERSION,
			id: obj.id,
			columnOrder: obj.columnOrder,
			hiddenSharedColumns: obj.hiddenSharedColumns,
			createdAt: obj.createdAt,
		},
	};
}

function parseColumnMetaRecord(raw: unknown): SchemaParseResult<ColumnMeta> {
	if (!raw || typeof raw !== "object") {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Column metadata has invalid shape",
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	const obj = raw as Partial<ColumnMeta> & { schemaVersion?: number };
	const foundVersion = obj.schemaVersion ?? COLUMN_META_SCHEMA_VERSION;
	if (foundVersion !== COLUMN_META_SCHEMA_VERSION) {
		return {
			ok: false,
			code: "unsupported_schema_version",
			message: "Column metadata schema version is not supported",
			foundVersion,
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	if (
		typeof obj.id !== "string" ||
		typeof obj.ownerId !== "string" ||
		!Array.isArray(obj.sharedWith) ||
		!(typeof obj.publicId === "string" || obj.publicId === null) ||
		typeof obj.createdAt !== "number"
	) {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Column metadata missing required fields",
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	return {
		ok: true,
		value: {
			schemaVersion: COLUMN_META_SCHEMA_VERSION,
			id: obj.id,
			ownerId: obj.ownerId,
			sharedWith: obj.sharedWith,
			publicId: obj.publicId,
			createdAt: obj.createdAt,
		},
	};
}

function shouldSkipRateLimit(c: Context<{ Bindings: Bindings }>): boolean {
	if (c.env.RATE_LIMIT_DISABLED === "true" || c.env.RATE_LIMIT_DISABLED === "1") {
		return true;
	}

	const hostname = new URL(c.req.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1";
}

function isReadOnlyMode(c: Context<{ Bindings: Bindings }>): boolean {
	return c.env.READ_ONLY_MODE === "true" || c.env.READ_ONLY_MODE === "1";
}

function blockWritesIfReadOnly(c: Context<{ Bindings: Bindings }>): Response | null {
	if (!isReadOnlyMode(c)) return null;

	return c.json(
		{
			error: "read_only_mode",
			message:
				"Writes are temporarily disabled while we protect data. Please try again later.",
		},
		503,
	);
}

function requireBackupAdmin(c: Context<{ Bindings: Bindings }>): Response | null {
	if (!c.env.BACKUPS) {
		return c.json({ error: "backup_not_configured" }, 503);
	}

	if (!c.env.BACKUP_ADMIN_TOKEN) {
		return c.json({ error: "backup_auth_not_configured" }, 503);
	}

	const authHeader = c.req.header("Authorization") ?? "";
	const token = authHeader.startsWith("Bearer ")
		? authHeader.slice("Bearer ".length)
		: null;

	if (!token || token !== c.env.BACKUP_ADMIN_TOKEN) {
		return c.json({ error: "unauthorized" }, 401);
	}

	return null;
}

function backupObjectKey(columnId: string, timestampMs: number): string {
	return `columns/${columnId}/${timestampMs.toString().padStart(13, "0")}.json`;
}

function isAutoBackupEnabled(env: Bindings): boolean {
	return env.AUTO_BACKUP_ENABLED === "true" || env.AUTO_BACKUP_ENABLED === "1";
}

function parseBackupMaxColumns(env: Bindings): number {
	const parsed = Number(env.BACKUP_MAX_COLUMNS ?? "1000");
	if (!Number.isFinite(parsed) || parsed <= 0) return 1000;
	return Math.min(Math.floor(parsed), 10_000);
}

function toHex(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return toHex(digest);
}

type ColumnBackupPayload = {
	schemaVersion: 1;
	columnId: string;
	snapshotAt: number;
	checksum: string;
	meta: ColumnMeta;
	yjs: number[] | null;
};

type AccountExportPayload = {
	schemaVersion: 1;
	exportedAt: number;
	account: Account;
	ownedColumns: Array<{
		meta: ColumnMeta;
		yjs: number[] | null;
	}>;
};

async function restoreColumnFromBackupPayload(
	env: Bindings,
	columnId: string,
	payload: ColumnBackupPayload,
) {
	const parsedBackupMeta = parseColumnMetaRecord(payload.meta);
	if (!parsedBackupMeta.ok) {
		return { ok: false as const, code: "column_meta_invalid" as const };
	}
	const backupMeta = parsedBackupMeta.value;

	const expectedChecksum = await sha256Hex(
		JSON.stringify({
			schemaVersion: payload.schemaVersion,
			columnId: payload.columnId,
			snapshotAt: payload.snapshotAt,
			meta: payload.meta,
			yjs: payload.yjs,
		}),
	);

	if (expectedChecksum !== payload.checksum) {
		return { ok: false as const, code: "backup_checksum_mismatch" as const };
	}

	const preBackup = await createColumnBackupSnapshot(env, columnId).catch(() => null);
	if (!preBackup) {
		return { ok: false as const, code: "pre_restore_backup_failed" as const };
	}

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const importResponse = await stub.fetch(
		new Request("http://do/import", {
			method: "POST",
			body: JSON.stringify({ meta: backupMeta, yjs: payload.yjs }),
		}),
	);

	if (!importResponse.ok) {
		return { ok: false as const, code: "restore_failed" as const };
	}

	return {
		ok: true as const,
		meta: backupMeta,
		preRestoreBackupKey: preBackup.key,
	};
}

async function rebuildSharedIndexesForColumns(env: Bindings, columns: ColumnMeta[]) {
	const byAccount = new Map<string, Set<string>>();

	for (const meta of columns) {
		for (const sharedAccountId of meta.sharedWith) {
			const normalized = normalizeAccountId(sharedAccountId);
			if (!byAccount.has(normalized)) {
				byAccount.set(normalized, new Set<string>());
			}
			byAccount.get(normalized)!.add(meta.id);
		}
	}

	for (const [normalizedAccountId, expectedColumnsSet] of byAccount) {
		const sharedColumnsData = await env.ACCOUNTS.get(`shared:${normalizedAccountId}`);
		const existingColumns = sharedColumnsData
			? (JSON.parse(sharedColumnsData) as string[])
			: [];

		const expectedColumns = Array.from(expectedColumnsSet);
		const merged = Array.from(new Set([...existingColumns, ...expectedColumns]));
		await env.ACCOUNTS.put(`shared:${normalizedAccountId}`, JSON.stringify(merged));
	}
}

async function createColumnBackupSnapshot(env: Bindings, columnId: string) {
	if (!env.BACKUPS) {
		throw new Error("backup_not_configured");
	}

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const exportResponse = await stub.fetch(new Request("http://do/export"));

	if (!exportResponse.ok) {
		throw new Error("column_not_found");
	}

	const exported = (await exportResponse.json()) as {
		meta: unknown;
		yjs: number[] | null;
	};
	const parsedMeta = parseColumnMetaRecord(exported.meta);
	if (!parsedMeta.ok) {
		throw new Error("column_meta_invalid");
	}

	const snapshotAt = Date.now();
	const key = backupObjectKey(columnId, snapshotAt);

	const basePayload = {
		schemaVersion: 1 as const,
		columnId,
		snapshotAt,
		meta: parsedMeta.value,
		yjs: exported.yjs,
	};

	const checksum = await sha256Hex(JSON.stringify(basePayload));
	const payload: ColumnBackupPayload = { ...basePayload, checksum };

	await env.BACKUPS.put(key, JSON.stringify(payload), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: {
			columnId,
			snapshotAt: String(snapshotAt),
			checksum,
		},
	});

	return { key, snapshotAt, checksum };
}

async function collectColumnIdsForBackup(env: Bindings): Promise<string[]> {
	const allColumnIds = new Set<string>();
	let cursor: string | undefined;

	while (true) {
		const page = await env.ACCOUNTS.list({
			prefix: "account:",
			cursor,
			limit: 1000,
		});

		for (const key of page.keys) {
			const raw = await env.ACCOUNTS.get(key.name);
			if (!raw) continue;

			const parsedAccount = parseAccountRecord(raw);
			if (!parsedAccount.ok) continue;

			for (const columnId of parsedAccount.value.columnOrder ?? []) {
				allColumnIds.add(columnId);
			}
		}

		if (page.list_complete) break;
		cursor = page.cursor;
	}

	return Array.from(allColumnIds);
}

async function runScheduledBackups(env: Bindings) {
	if (!env.BACKUPS) {
		return { skipped: true, reason: "backup_not_configured" as const };
	}

	const maxColumns = parseBackupMaxColumns(env);
	const allColumns = await collectColumnIdsForBackup(env);
	const selected = allColumns.slice(0, maxColumns);

	let backedUp = 0;
	let failed = 0;

	for (const columnId of selected) {
		try {
			await createColumnBackupSnapshot(env, columnId);
			backedUp += 1;
		} catch {
			failed += 1;
		}
	}

	return {
		skipped: false,
		columnsDiscovered: allColumns.length,
		columnsSelected: selected.length,
		backedUp,
		failed,
	};
}

// ============================================
// Account Routes
// ============================================

/**
 * Create a new account
 * Rate limited: 5 per IP per hour
 */
app.post("/api/account", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			ipRateLimitKey("create-account", ip),
			RATE_LIMITS.createAccount,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const accountId = generateAccountId();
	const normalizedId = normalizeAccountId(accountId);

	const account: Account = {
		schemaVersion: ACCOUNT_SCHEMA_VERSION,
		id: accountId,
		columnOrder: [],
		hiddenSharedColumns: [],
		createdAt: Date.now(),
	};

	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ account });
});

/**
 * Get account metadata
 * Rate limited: 20 per IP per minute
 */
app.get("/api/account/:id", async (c) => {
	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			ipRateLimitKey("account-lookup", ip),
			RATE_LIMITS.accountLookup,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}
	const account = parsedAccount.value;

	// Get shared columns (columns where this account is in sharedWith)
	const sharedColumnsData = await c.env.ACCOUNTS.get(
		`shared:${normalizedId}`,
	);
	const sharedColumnIds: string[] = sharedColumnsData
		? JSON.parse(sharedColumnsData)
		: [];

	// Fetch metadata for shared columns
	const sharedColumns: ColumnMeta[] = [];
	for (const columnId of sharedColumnIds) {
				const stub = c.env.COLUMN_ROOM.get(
			c.env.COLUMN_ROOM.idFromName(columnId),
		);
		const response = await stub.fetch(new Request("http://do/meta"));
		if (response.ok) {
			const parsedMeta = parseColumnMetaRecord(await response.json());
			if (parsedMeta.ok) {
				sharedColumns.push(parsedMeta.value);
			}
		}
	}

	return c.json({ account, sharedColumns });
});

/**
 * Update column order for an account
 */
app.put("/api/account/:id/columns", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}
	const account = parsedAccount.value;
	const { columnOrder } = await c.req.json<{ columnOrder: string[] }>();

	account.columnOrder = columnOrder;
	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ success: true });
});

/**
 * Update hidden shared columns for an account
 */
app.put("/api/account/:id/hidden", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const accountId = c.req.param("id");

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}
	const account = parsedAccount.value;
	const { hiddenSharedColumns } = await c.req.json<{
		hiddenSharedColumns: string[];
	}>();

	account.hiddenSharedColumns = hiddenSharedColumns;
	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ success: true });
});

/**
 * Export account-owned columns as JSON (self-serve)
 */
app.get("/api/account/:id/export", async (c) => {
	const accountIdParam = c.req.param("id");
	const requesterAccountId = c.req.header("X-Account-ID");

	if (!requesterAccountId || !validateAccountId(requesterAccountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (
		normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountIdParam)
	) {
		return c.json({ error: "Access denied" }, 403);
	}

	const normalizedId = normalizeAccountId(accountIdParam);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}

	const ownedColumns: AccountExportPayload["ownedColumns"] = [];
	for (const columnId of parsedAccount.value.columnOrder) {
		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
		const exportResponse = await stub.fetch(new Request("http://do/export"));
		if (!exportResponse.ok) continue;

		const exported = (await exportResponse.json()) as {
			meta: unknown;
			yjs: number[] | null;
		};
		const parsedMeta = parseColumnMetaRecord(exported.meta);
		if (!parsedMeta.ok) continue;

		if (
			normalizeAccountId(parsedMeta.value.ownerId) !== normalizeAccountId(accountIdParam)
		) {
			continue;
		}

		ownedColumns.push({
			meta: parsedMeta.value,
			yjs: exported.yjs,
		});
	}

	const payload: AccountExportPayload = {
		schemaVersion: 1,
		exportedAt: Date.now(),
		account: parsedAccount.value,
		ownedColumns,
	};

	return c.json(payload);
});

/**
 * Import account data from self-serve export JSON
 */
app.post("/api/account/:id/import", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const accountIdParam = c.req.param("id");
	const requesterAccountId = c.req.header("X-Account-ID");

	if (!requesterAccountId || !validateAccountId(requesterAccountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (
		normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountIdParam)
	) {
		return c.json({ error: "Access denied" }, 403);
	}

	const body = await c.req
		.json<AccountExportPayload>()
		.catch(() => null as AccountExportPayload | null);
	if (!body || body.schemaVersion !== 1 || !Array.isArray(body.ownedColumns)) {
		return c.json({ error: "Invalid import payload" }, 400);
	}

	const normalizedId = normalizeAccountId(accountIdParam);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}

	const account = parsedAccount.value;
	const importedColumnIds: string[] = [];

	for (const column of body.ownedColumns) {
		const parsedMeta = parseColumnMetaRecord(column.meta);
		if (!parsedMeta.ok) continue;

		const newColumnId = crypto.randomUUID();
		const importedMeta: ColumnMeta = {
			...parsedMeta.value,
			id: newColumnId,
			ownerId: displayAccountId(accountIdParam),
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(newColumnId));
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(importedMeta),
			}),
		);
		await stub.fetch(
			new Request("http://do/import", {
				method: "POST",
				body: JSON.stringify({ meta: importedMeta, yjs: column.yjs ?? null }),
			}),
		);

		importedColumnIds.push(newColumnId);
	}

	account.columnOrder = [...account.columnOrder, ...importedColumnIds];
	await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ success: true, importedColumns: importedColumnIds.length });
});

// ============================================
// Column Routes
// ============================================

/**
 * Create a new column
 */
app.post("/api/column", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const { accountId } = await c.req.json<{ accountId: string }>();

	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedAccountId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(
		`account:${normalizedAccountId}`,
	);

	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}
	const account = parsedAccount.value;

	// Check column limit (100 per account)
	if (account.columnOrder.length >= 100) {
		return c.json({ error: "Column limit reached (100)" }, 400);
	}

	const columnId = crypto.randomUUID();
	const meta: ColumnMeta = {
		schemaVersion: COLUMN_META_SCHEMA_VERSION,
		id: columnId,
		ownerId: displayAccountId(accountId),
		sharedWith: [],
		publicId: null,
		createdAt: Date.now(),
	};

	// Initialize the Durable Object
		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	await stub.fetch(
		new Request("http://do/init", {
			method: "POST",
			body: JSON.stringify(meta),
		}),
	);

	// Add to account's column order
	account.columnOrder.push(columnId);
	await c.env.ACCOUNTS.put(
		`account:${normalizedAccountId}`,
		JSON.stringify(account),
	);

	return c.json({ column: meta });
});

/**
 * Delete a column
 */
app.delete("/api/column/:id", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Only owner can delete
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can delete" }, 403);
	}

	// Remove from owner's column order
	const normalizedOwnerId = normalizeAccountId(meta.ownerId);
	const ownerData = await c.env.ACCOUNTS.get(`account:${normalizedOwnerId}`);
	if (ownerData) {
		const parsedOwner = parseAccountRecord(ownerData);
		if (!parsedOwner.ok) {
			return schemaErrorResponse("account", parsedOwner);
		}
		const ownerAccount = parsedOwner.value;
		ownerAccount.columnOrder = ownerAccount.columnOrder.filter(
			(id) => id !== columnId,
		);
		await c.env.ACCOUNTS.put(
			`account:${normalizedOwnerId}`,
			JSON.stringify(ownerAccount),
		);
	}

	// Remove from shared accounts' lists
	for (const sharedAccountId of meta.sharedWith) {
		const normalizedSharedId = normalizeAccountId(sharedAccountId);
		const sharedColumnsData = await c.env.ACCOUNTS.get(
			`shared:${normalizedSharedId}`,
		);
		if (sharedColumnsData) {
			const sharedColumns = JSON.parse(sharedColumnsData) as string[];
			const updated = sharedColumns.filter((id) => id !== columnId);
			await c.env.ACCOUNTS.put(
				`shared:${normalizedSharedId}`,
				JSON.stringify(updated),
			);
		}
	}

	// Delete the Durable Object
	await stub.fetch(new Request("http://do/", { method: "DELETE" }));

	return c.json({ success: true });
});

/**
 * Get column metadata
 */
app.get("/api/column/:id", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Check access
	if (accountId && validateAccountId(accountId)) {
		const normalizedAccountId = normalizeAccountId(accountId);
		const isOwner =
			normalizeAccountId(meta.ownerId) === normalizedAccountId;
		const isShared = meta.sharedWith.some(
			(id) => normalizeAccountId(id) === normalizedAccountId,
		);

		if (!isOwner && !isShared) {
			return c.json({ error: "Access denied" }, 403);
		}
	} else {
		return c.json({ error: "Access denied" }, 403);
	}

	return c.json({ column: meta });
});

/**
 * WebSocket connection for column sync
 */
app.get("/api/column/:id/ws", async (c) => {
	const columnId = c.req.param("id");
	const accountId = c.req.query("accountId");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	// Important: forward the original upgrade request as-is.
	// Rewriting/cloning upgrade requests can break WebSocket upgrades in local dev.
	return stub.fetch(c.req.raw);
});

// ============================================
// Sharing Routes
// ============================================

/**
 * Share a column with another account
 */
app.post("/api/column/:id/share", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");
	const { targetAccountId } = await c.req.json<{ targetAccountId: string }>();

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	if (!validateAccountId(targetAccountId)) {
		return c.json({ error: "Invalid target account ID" }, 400);
	}

	// Check target account exists
	const normalizedTargetId = normalizeAccountId(targetAccountId);
	const targetData = await c.env.ACCOUNTS.get(`account:${normalizedTargetId}`);
	if (!targetData) {
		return c.json({ error: "Target account not found" }, 404);
	}
	const parsedTarget = parseAccountRecord(targetData);
	if (!parsedTarget.ok) {
		return schemaErrorResponse("account", parsedTarget);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Only owner can share
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can share" }, 403);
	}

	// Add to sharedWith
	const formattedTargetId = displayAccountId(targetAccountId);
	if (!meta.sharedWith.includes(formattedTargetId)) {
		meta.sharedWith.push(formattedTargetId);

		await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({ sharedWith: meta.sharedWith }),
			}),
		);

		// Add to target's shared columns list
		const sharedColumnsData = await c.env.ACCOUNTS.get(
			`shared:${normalizedTargetId}`,
		);
		const sharedColumns: string[] = sharedColumnsData
			? JSON.parse(sharedColumnsData)
			: [];

		if (!sharedColumns.includes(columnId)) {
			sharedColumns.push(columnId);
			await c.env.ACCOUNTS.put(
				`shared:${normalizedTargetId}`,
				JSON.stringify(sharedColumns),
			);
		}
	}

	return c.json({ success: true, sharedWith: meta.sharedWith });
});

/**
 * Revoke sharing for a column
 */
app.delete("/api/column/:id/share/:targetId", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const columnId = c.req.param("id");
	const targetAccountId = c.req.param("targetId");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Only owner can revoke
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can revoke sharing" }, 403);
	}

	// Remove from sharedWith
	const normalizedTargetId = normalizeAccountId(targetAccountId);
	meta.sharedWith = meta.sharedWith.filter(
		(id) => normalizeAccountId(id) !== normalizedTargetId,
	);

	await stub.fetch(
		new Request("http://do/share", {
			method: "PUT",
			body: JSON.stringify({ sharedWith: meta.sharedWith }),
		}),
	);

	// Remove from target's shared columns list
	const sharedColumnsData = await c.env.ACCOUNTS.get(
		`shared:${normalizedTargetId}`,
	);
	if (sharedColumnsData) {
		const sharedColumns = JSON.parse(sharedColumnsData) as string[];
		const updated = sharedColumns.filter((id) => id !== columnId);
		await c.env.ACCOUNTS.put(
			`shared:${normalizedTargetId}`,
			JSON.stringify(updated),
		);
	}

	return c.json({ success: true, sharedWith: meta.sharedWith });
});

// ============================================
// Public Link Routes
// ============================================

/**
 * Enable public link for a column
 */
app.post("/api/column/:id/public", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Only owner can enable public link
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can enable public link" }, 403);
	}

	const publicId = generatePublicId();

	await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId }),
		}),
	);

	// Store reverse lookup
	await c.env.ACCOUNTS.put(`public:${publicId}`, columnId);

	const url = new URL(c.req.url);
	const publicUrl = `${url.origin}/p/${publicId}`;

	return c.json({ publicId, url: publicUrl });
});

/**
 * Disable public link for a column
 */
app.delete("/api/column/:id/public", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const columnId = c.req.param("id");
	const accountId = c.req.header("X-Account-ID");

	if (!accountId || !validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Only owner can disable public link
	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return c.json({ error: "Only owner can disable public link" }, 403);
	}

	// Delete reverse lookup
	if (meta.publicId) {
		await c.env.ACCOUNTS.delete(`public:${meta.publicId}`);
	}

	await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId: null }),
		}),
	);

	return c.json({ success: true });
});

/**
 * Get public column metadata
 */
app.get("/api/p/:publicId", async (c) => {
	const publicId = c.req.param("publicId");

	if (!shouldSkipRateLimit(c)) {
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			resourceRateLimitKey("public-view", publicId),
			RATE_LIMITS.publicView,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const columnId = await c.env.ACCOUNTS.get(`public:${publicId}`);
	if (!columnId) {
		return c.json({ error: "Public link not found" }, 404);
	}

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return c.json({ error: "Column not found" }, 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Verify public link is still valid
	if (meta.publicId !== publicId) {
		return c.json({ error: "Public link not found" }, 404);
	}

	return c.json({ column: meta, columnId });
});

/**
 * WebSocket connection for public column view
 */
app.get("/api/p/:publicId/ws", async (c) => {
	const publicId = c.req.param("publicId");

	const columnId = await c.env.ACCOUNTS.get(`public:${publicId}`);
	if (!columnId) {
		return c.json({ error: "Public link not found" }, 404);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	// Forward the original upgrade request as-is so the DO can route by pathname.
	return stub.fetch(c.req.raw);
});

/**
 * Restore all owned columns for an account from latest backups
 */
app.post("/api/admin/backups/account/:id/restore", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;

	const accountId = c.req.param("id");
	if (!validateAccountId(accountId)) {
		return c.json({ error: "Invalid account ID" }, 400);
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
	if (!accountData) {
		return c.json({ error: "Account not found" }, 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}

	const account = parsedAccount.value;
	const restoredColumns: string[] = [];
	const missingBackups: string[] = [];
	const failedColumns: string[] = [];
	const restoredMetas: ColumnMeta[] = [];

	for (const columnId of account.columnOrder) {
		const listed = await c.env.BACKUPS!.list({
			prefix: `columns/${columnId}/`,
			limit: 100,
		});
		const latestKey = listed.objects
			.map((obj) => obj.key)
			.sort((a, b) => b.localeCompare(a))[0];

		if (!latestKey) {
			missingBackups.push(columnId);
			continue;
		}

		const object = await c.env.BACKUPS!.get(latestKey);
		if (!object) {
			missingBackups.push(columnId);
			continue;
		}

		const raw = await object.text();
		const payload = JSON.parse(raw) as ColumnBackupPayload;
		if (
			payload.schemaVersion !== 1 ||
			payload.columnId !== columnId ||
			typeof payload.checksum !== "string"
		) {
			failedColumns.push(columnId);
			continue;
		}

		const restored = await restoreColumnFromBackupPayload(c.env, columnId, payload);
		if (!restored.ok) {
			failedColumns.push(columnId);
			continue;
		}

		restoredColumns.push(columnId);
		restoredMetas.push(restored.meta);
	}

	await rebuildSharedIndexesForColumns(c.env, restoredMetas);

	return c.json({
		success: failedColumns.length === 0,
		accountId: displayAccountId(accountId),
		restoredColumns,
		missingBackups,
		failedColumns,
	});
});

/**
 * List available backups for a column
 */
app.get("/api/admin/backups/column/:id", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;

	const columnId = c.req.param("id");
	const limit = Math.min(Number(c.req.query("limit") ?? "20") || 20, 100);
	const prefix = `columns/${columnId}/`;

	const listed = await c.env.BACKUPS!.list({
		prefix,
		limit,
	});

	const objects = listed.objects
		.map((obj) => ({
			key: obj.key,
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
		}))
		.sort((a, b) => b.key.localeCompare(a.key));

	return c.json({
		columnId,
		objects,
		truncated: listed.truncated,
	});
});

/**
 * Create a backup snapshot for a column
 */
app.post("/api/admin/backups/column/:id", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;

	const columnId = c.req.param("id");
	try {
		const { key, snapshotAt, checksum } = await createColumnBackupSnapshot(
			c.env,
			columnId,
		);

		return c.json({ success: true, key, snapshotAt, checksum });
	} catch (error) {
		if (error instanceof Error && error.message === "column_not_found") {
			return c.json({ error: "Column not found" }, 404);
		}

		return c.json({ error: "backup_failed" }, 500);
	}
});

/**
 * Restore a column from backup snapshot
 */
app.post("/api/admin/backups/column/:id/restore", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;

	const columnId = c.req.param("id");
	const body = await c.req
		.json<{ key?: string; mode?: "clone" | "in_place" }>()
		.catch(() => ({}) as { key?: string; mode?: "clone" | "in_place" });

	const mode = body.mode === "in_place" ? "in_place" : "clone";

	let key = body.key;
	if (!key) {
		const listed = await c.env.BACKUPS!.list({
			prefix: `columns/${columnId}/`,
			limit: 100,
		});
		const latest = listed.objects
			.map((obj) => obj.key)
			.sort((a, b) => b.localeCompare(a))[0];
		if (!latest) {
			return c.json({ error: "backup_not_found" }, 404);
		}
		key = latest;
	}

	const object = await c.env.BACKUPS!.get(key);
	if (!object) {
		return c.json({ error: "backup_not_found" }, 404);
	}

	const raw = await object.text();
	const parsed = JSON.parse(raw) as ColumnBackupPayload;

	if (parsed.schemaVersion !== 1 || parsed.columnId !== columnId) {
		return c.json({ error: "invalid_backup_payload" }, 400);
	}

	const expectedChecksum = await sha256Hex(
		JSON.stringify({
			schemaVersion: parsed.schemaVersion,
			columnId: parsed.columnId,
			snapshotAt: parsed.snapshotAt,
			meta: parsed.meta,
			yjs: parsed.yjs,
		}),
	);

	if (expectedChecksum !== parsed.checksum) {
		return c.json({ error: "backup_checksum_mismatch" }, 400);
	}

	const parsedBackupMeta = parseColumnMetaRecord(parsed.meta);
	if (!parsedBackupMeta.ok) {
		return schemaErrorResponse("column_meta", parsedBackupMeta);
	}
	const backupMeta = parsedBackupMeta.value;

	if (mode === "clone") {
		const restoredColumnId = crypto.randomUUID();
		const restoredMeta: ColumnMeta = {
			...backupMeta,
			id: restoredColumnId,
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		const restoredStub = c.env.COLUMN_ROOM.get(
			c.env.COLUMN_ROOM.idFromName(restoredColumnId),
		);

		await restoredStub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(restoredMeta),
			}),
		);

		const cloneImportResponse = await restoredStub.fetch(
			new Request("http://do/import", {
				method: "POST",
				body: JSON.stringify({ meta: restoredMeta, yjs: parsed.yjs }),
			}),
		);

		if (!cloneImportResponse.ok) {
			return c.json({ error: "restore_failed" }, 500);
		}

		const ownerId = normalizeAccountId(restoredMeta.ownerId);
		const ownerData = await c.env.ACCOUNTS.get(`account:${ownerId}`);
		if (ownerData) {
			const parsedOwner = parseAccountRecord(ownerData);
			if (!parsedOwner.ok) {
				return schemaErrorResponse("account", parsedOwner);
			}
			const ownerAccount = parsedOwner.value;
			if (!ownerAccount.columnOrder.includes(restoredColumnId)) {
				ownerAccount.columnOrder.push(restoredColumnId);
				await c.env.ACCOUNTS.put(
					`account:${ownerId}`,
					JSON.stringify(ownerAccount),
				);
			}
		}

		return c.json({
			success: true,
			mode,
			restoredFrom: key,
			snapshotAt: parsed.snapshotAt,
			originalColumnId: columnId,
			restoredColumnId,
		});
	}

	let preRestoreBackupKey: string | null = null;
	try {
		const preBackup = await createColumnBackupSnapshot(c.env, columnId);
		preRestoreBackupKey = preBackup.key;
	} catch {
		return c.json({ error: "pre_restore_backup_failed" }, 500);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	const currentMetaResponse = await stub.fetch(new Request("http://do/meta"));
	let currentMeta: ColumnMeta | null = null;
	if (currentMetaResponse.ok) {
		const parsedCurrentMeta = parseColumnMetaRecord(
			await currentMetaResponse.json(),
		);
		if (!parsedCurrentMeta.ok) {
			return schemaErrorResponse("column_meta", parsedCurrentMeta);
		}
		currentMeta = parsedCurrentMeta.value;
	}

	const importResponse = await stub.fetch(
		new Request("http://do/import", {
			method: "POST",
			body: JSON.stringify({ meta: backupMeta, yjs: parsed.yjs }),
		}),
	);

	if (!importResponse.ok) {
		return c.json({ error: "restore_failed" }, 500);
	}

	const ownerId = normalizeAccountId(backupMeta.ownerId);
	const ownerData = await c.env.ACCOUNTS.get(`account:${ownerId}`);
	if (ownerData) {
		const parsedOwner = parseAccountRecord(ownerData);
		if (!parsedOwner.ok) {
			return schemaErrorResponse("account", parsedOwner);
		}
		const ownerAccount = parsedOwner.value;
		if (!ownerAccount.columnOrder.includes(columnId)) {
			ownerAccount.columnOrder.push(columnId);
			await c.env.ACCOUNTS.put(`account:${ownerId}`, JSON.stringify(ownerAccount));
		}
	}

	for (const sharedAccountId of backupMeta.sharedWith) {
		const normalized = normalizeAccountId(sharedAccountId);
		const sharedColumnsData = await c.env.ACCOUNTS.get(`shared:${normalized}`);
		const sharedColumns: string[] = sharedColumnsData
			? JSON.parse(sharedColumnsData)
			: [];

		if (!sharedColumns.includes(columnId)) {
			sharedColumns.push(columnId);
			await c.env.ACCOUNTS.put(
				`shared:${normalized}`,
				JSON.stringify(sharedColumns),
			);
		}
	}

	if (currentMeta?.sharedWith) {
		for (const oldSharedAccountId of currentMeta.sharedWith) {
			const normalized = normalizeAccountId(oldSharedAccountId);
			const stillShared = backupMeta.sharedWith.some(
				(id) => normalizeAccountId(id) === normalized,
			);
			if (stillShared) continue;

			const sharedColumnsData = await c.env.ACCOUNTS.get(`shared:${normalized}`);
			if (!sharedColumnsData) continue;

			const sharedColumns = JSON.parse(sharedColumnsData) as string[];
			const filtered = sharedColumns.filter((id) => id !== columnId);
			await c.env.ACCOUNTS.put(`shared:${normalized}`, JSON.stringify(filtered));
		}
	}

	if (currentMeta?.publicId && currentMeta.publicId !== backupMeta.publicId) {
		await c.env.ACCOUNTS.delete(`public:${currentMeta.publicId}`);
	}
	if (backupMeta.publicId) {
		await c.env.ACCOUNTS.put(`public:${backupMeta.publicId}`, columnId);
	}

	return c.json({
		success: true,
		mode,
		restoredFrom: key,
		snapshotAt: parsed.snapshotAt,
		preRestoreBackupKey,
	});
});

// Keep the clock endpoint for testing
app.get("/api/clock", (c) => {
	return c.json({
		time: new Date().toLocaleTimeString(),
		readOnlyMode: isReadOnlyMode(c),
		autoBackupEnabled: isAutoBackupEnabled(c.env),
	});
});

export type AppType = typeof app;

export default {
	fetch: app.fetch,
	scheduled: async (
		controller: ScheduledController,
		env: Bindings,
		executionCtx: ExecutionContext,
	) => {
		if (!isAutoBackupEnabled(env)) return;

		executionCtx.waitUntil(
			runScheduledBackups(env).then((result) => {
				console.log(
					JSON.stringify({
						event: "scheduled_backup_run",
						cron: controller.cron,
						...result,
					}),
				);
			}),
		);
	},
};
