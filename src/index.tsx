import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type {
	Account,
	AccountExportPayload,
	ColumnMeta,
} from "./types/account";
import {
	allocateGeneratedId,
	generateAccountId,
	normalizeAccountId,
	displayAccountId,
	validateAccountId,
} from "./lib/account";
import { hasColumnAccess } from "./lib/column-access";
import {
	checkRateLimit,
	getClientIP,
	ipRateLimitKey,
	resourceRateLimitKey,
	RATE_LIMITS,
} from "./lib/rate-limit";
import { ColumnRoomSql } from "./durable-objects/column-room";
import { registerAgentApi } from "./agent-api";
import type { ApiErrorCode } from "./lib/api/errors";
import {
	ACCOUNT_SCHEMA_VERSION,
	COLUMN_META_SCHEMA_VERSION,
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
	TRASH_RETENTION_MS,
	type SchemaParseResult,
} from "./server/persistence-records";
import type { ColumnLifecycleFailure } from "./server/workflows/column-lifecycle";
import { deleteColumn } from "./server/workflows/delete-column";
import { restoreColumn } from "./server/workflows/restore-column";
import { shareColumn } from "./server/workflows/share-column";
import { enablePublicColumn } from "./server/workflows/enable-public-column";
import { purgeExpiredTrashedColumns } from "./server/workflows/purge-expired-trashed-columns";
import { revokeColumnShare } from "./server/workflows/revoke-column-share";
import { disablePublicColumn } from "./server/workflows/disable-public-column";
import { cloneColumnSnapshot } from "./server/workflows/clone-column-snapshot";
import {
	restoreColumnBackup,
	type ColumnBackupPayload,
} from "./server/workflows/restore-column-backup";

// Re-export Durable Objects for Cloudflare
export { ColumnRoomSql };

export type Bindings = {
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

const app = new OpenAPIHono<{ Bindings: Bindings }>();

const COLUMN_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_HEADER = "X-Idempotency-Key";
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_PENDING_TTL_SECONDS = 5 * 60;
const IDEMPOTENCY_PENDING_WAIT_MS = 1500;
const IDEMPOTENCY_PENDING_POLL_MS = 50;
const IDEMPOTENCY_SCHEMA_VERSION = 1;

interface IdempotencyCacheBaseRecord {
	schemaVersion: number;
	fingerprint: string;
}

interface IdempotencyPendingRecord extends IdempotencyCacheBaseRecord {
	state: "pending";
}

interface IdempotencyCompletedRecord extends IdempotencyCacheBaseRecord {
	state: "completed";
	status: number;
	body: unknown;
}

type IdempotencyCacheRecord =
	| IdempotencyPendingRecord
	| IdempotencyCompletedRecord;

registerAgentApi(app);

app.doc("/openapi.json", {
	openapi: "3.0.0",
	info: {
		title: "Todoflare Agent API",
		version: "1.0.0",
		description: "Read-only agent endpoints for column discovery and snapshots.",
	},
});

function apiErrorResponse(
	code: ApiErrorCode,
	message: string,
	status: number,
): Response {
	return Response.json({ error: message, code }, { status });
}

function schemaErrorResponse(
	kind: "account" | "column_meta" | "shared_index",
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

function isDurableObjectDurationError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.includes("Exceeded allowed duration in Durable Objects free tier");
}

function durableObjectUnavailableResponse() {
	return Response.json(
		{
			error: "realtime_unavailable",
			code: "durable_object_unavailable",
			message: "Realtime backend is temporarily unavailable. Falling back to local mode is recommended.",
		},
		{ status: 503 },
	);
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

function parseIdempotencyKey(value: string | null | undefined): string | null {
	if (!value) return null;
	const parsed = z
		.string()
		.trim()
		.min(1)
		.max(IDEMPOTENCY_KEY_MAX_LENGTH)
		.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function idempotencyCacheKey(
	scope: string,
	accountScope: string,
	idempotencyKey: string,
): string {
	return `idempotency:${scope}:${accountScope}:${idempotencyKey}`;
}

function parseIdempotencyCacheRecord(
	raw: string | null,
): IdempotencyCacheRecord | null {
	if (!raw) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;

	const record = parsed as {
		schemaVersion?: number;
		state?: unknown;
		fingerprint?: unknown;
		body?: unknown;
		status?: number;
	};

	if (record.schemaVersion !== IDEMPOTENCY_SCHEMA_VERSION) return null;
	if (typeof record.fingerprint !== "string" || record.fingerprint.length === 0) {
		return null;
	}

	if (record.state === "pending") {
		return {
			schemaVersion: record.schemaVersion,
			state: "pending",
			fingerprint: record.fingerprint,
		};
	}

	if (record.state === "completed") {
		if (typeof record.status !== "number") return null;
		if (!("body" in record)) return null;

		return {
			schemaVersion: record.schemaVersion,
			state: "completed",
			fingerprint: record.fingerprint,
			status: record.status,
			body: record.body,
		};
	}

	return null;
}

async function loadIdempotencyRecord(
	env: Bindings,
	cacheKey: string,
): Promise<IdempotencyCacheRecord | null> {
	const raw = await env.ACCOUNTS.get(cacheKey);
	return parseIdempotencyCacheRecord(raw);
}

function idempotencyKeyConflictResponse() {
	return Response.json(
		{
			error: "idempotency_key_conflict",
			code: "idempotency_conflict",
			message: "This idempotency key was already used for a different request.",
		},
		{ status: 409 },
	);
}

function idempotencyRequestInProgressResponse() {
	return Response.json(
		{
			error: "idempotency_request_in_progress",
			code: "idempotency_in_progress",
			message:
				"A request with this idempotency key is still in progress. Retry shortly.",
		},
		{ status: 409 },
	);
}

function toIdempotentReplayResponse(record: IdempotencyCompletedRecord): Response {
	return Response.json(record.body, {
		status: record.status,
		headers: {
			"X-Idempotency-Replay": "1",
		},
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForPendingIdempotentCompletion(
	env: Bindings,
	cacheKey: string,
	fingerprint: string,
): Promise<Response | null> {
	const deadline = Date.now() + IDEMPOTENCY_PENDING_WAIT_MS;

	while (Date.now() < deadline) {
		await wait(IDEMPOTENCY_PENDING_POLL_MS);
		const record = await loadIdempotencyRecord(env, cacheKey);
		if (!record) return null;
		if (record.fingerprint !== fingerprint) {
			return idempotencyKeyConflictResponse();
		}
		if (record.state === "completed") {
			return toIdempotentReplayResponse(record);
		}
	}

	return idempotencyRequestInProgressResponse();
}

async function markIdempotencyPending(
	env: Bindings,
	cacheKey: string,
	fingerprint: string,
): Promise<void> {
	const record: IdempotencyPendingRecord = {
		schemaVersion: IDEMPOTENCY_SCHEMA_VERSION,
		state: "pending",
		fingerprint,
	};

	await env.ACCOUNTS.put(cacheKey, JSON.stringify(record), {
		expirationTtl: IDEMPOTENCY_PENDING_TTL_SECONDS,
	});
}

async function clearPendingIdempotencyIfNeeded(
	env: Bindings,
	cacheKey: string,
	fingerprint: string,
): Promise<void> {
	const record = await loadIdempotencyRecord(env, cacheKey);
	if (!record) return;
	if (record.fingerprint !== fingerprint) return;
	if (record.state !== "pending") return;

	await env.ACCOUNTS.delete(cacheKey);
}

async function idempotencyRequestFingerprint(
	request: Request,
	requestFingerprintSource?: string,
): Promise<string> {
	const url = new URL(request.url);
	const body =
		typeof requestFingerprintSource === "string"
			? requestFingerprintSource
			: await request
					.clone()
					.text()
					.catch(() => "__BODY_UNAVAILABLE__");
	const source = `${request.method.toUpperCase()} ${url.pathname}${url.search}\n${body}`;

	return sha256Hex(source);
}

interface IdempotentWriteOptions {
	scope: string;
	accountId?: string | null;
	requestFingerprintSource?: string;
}

async function cacheIdempotentResponse(
	env: Bindings,
	cacheKey: string,
	fingerprint: string,
	response: Response,
): Promise<boolean> {
	if (response.status < 200 || response.status >= 300) return false;

	const body = await response.clone().json().catch(() => undefined);
	if (typeof body === "undefined") return false;

	const record: IdempotencyCompletedRecord = {
		schemaVersion: IDEMPOTENCY_SCHEMA_VERSION,
		state: "completed",
		fingerprint,
		status: response.status,
		body,
	};

	await env.ACCOUNTS.put(cacheKey, JSON.stringify(record), {
		expirationTtl: IDEMPOTENCY_CACHE_TTL_SECONDS,
	});

	return true;
}

async function withIdempotentWrite(
	c: Context<{ Bindings: Bindings }>,
	options: IdempotentWriteOptions,
	handler: () => Promise<Response>,
): Promise<Response> {
	const idempotencyKey = parseIdempotencyKey(c.req.header(IDEMPOTENCY_HEADER));
	if (!idempotencyKey) {
		return handler();
	}

	const accountScope =
		typeof options.accountId === "string" && validateAccountId(options.accountId)
			? normalizeAccountId(options.accountId)
			: "guest";
	const cacheKey = idempotencyCacheKey(
		options.scope,
		accountScope,
		idempotencyKey,
	);
	const fingerprint = await idempotencyRequestFingerprint(
		c.req.raw,
		options.requestFingerprintSource,
	);

	const existingRecord = await loadIdempotencyRecord(c.env, cacheKey);
	if (existingRecord) {
		if (existingRecord.fingerprint !== fingerprint) {
			return idempotencyKeyConflictResponse();
		}

		if (existingRecord.state === "completed") {
			return toIdempotentReplayResponse(existingRecord);
		}

		const pendingResolution = await waitForPendingIdempotentCompletion(
			c.env,
			cacheKey,
			fingerprint,
		);
		if (pendingResolution) {
			return pendingResolution;
		}
	}

	await markIdempotencyPending(c.env, cacheKey, fingerprint);

	try {
		const response = await handler();
		const didCache = await cacheIdempotentResponse(
			c.env,
			cacheKey,
			fingerprint,
			response,
		);

		if (!didCache) {
			await clearPendingIdempotencyIfNeeded(c.env, cacheKey, fingerprint);
		}

		return response;
	} catch (err) {
		await clearPendingIdempotencyIfNeeded(c.env, cacheKey, fingerprint);
		throw err;
	}
}

function blockWritesIfReadOnly(c: Context<{ Bindings: Bindings }>): Response | null {
	if (!isReadOnlyMode(c)) return null;

	return c.json(
		{
			error: "read_only_mode",
			code: "read_only_mode",
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

	const parsedAuthHeader = z
		.string()
		.regex(/^Bearer .+$/)
		.safeParse(c.req.header("Authorization"));
	const token = parsedAuthHeader.success
		? parsedAuthHeader.data.slice("Bearer ".length)
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

const accountIdValueSchema = z
	.string()
	.refine(validateAccountId, "Invalid account ID");
const columnIdValueSchema = z
	.string()
	.regex(COLUMN_ID_PATTERN, "Invalid column ID");
const publicIdValueSchema = z
	.string()
	.regex(/^[0-9A-Za-z]{8}$/, "Invalid public ID");
const yjsBytesSchema = z.array(z.number().int().min(0).max(255)).nullable();
const columnMetaInputSchema = z
	.object({
		schemaVersion: z.literal(COLUMN_META_SCHEMA_VERSION),
		id: columnIdValueSchema,
		ownerId: accountIdValueSchema,
		sharedWith: z.array(accountIdValueSchema).max(100),
		publicId: publicIdValueSchema.nullable(),
		createdAt: z.number().finite().nonnegative(),
	})
	.strict();
const accountInputSchema = z
	.object({
		schemaVersion: z.literal(ACCOUNT_SCHEMA_VERSION),
		id: accountIdValueSchema,
		columnOrder: z.array(columnIdValueSchema).max(100),
		hiddenSharedColumns: z.array(columnIdValueSchema).max(100),
		createdAt: z.number().finite().nonnegative(),
	})
	.strict();

const accountPathSchema = z.object({ id: accountIdValueSchema }).strict();
const columnPathSchema = z.object({ id: columnIdValueSchema }).strict();
const publicPathSchema = z.object({ publicId: publicIdValueSchema }).strict();
const columnSharePathSchema = z
	.object({ id: columnIdValueSchema, targetId: accountIdValueSchema })
	.strict();
const accountHeaderSchema = z.object({ accountId: accountIdValueSchema }).strict();
const optionalAccountHeaderSchema = z
	.object({ accountId: accountIdValueSchema.optional() })
	.strict();
const columnSocketQuerySchema = z
	.object({ accountId: accountIdValueSchema })
	.strict();
const backupListQuerySchema = z
	.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
	.strict();

const columnOrderBodySchema = z
	.object({ columnOrder: z.array(columnIdValueSchema).max(100) })
	.strict();
const hiddenColumnsBodySchema = z
	.object({ hiddenSharedColumns: z.array(columnIdValueSchema).max(100) })
	.strict();
const createColumnBodySchema = z
	.object({
		accountId: accountIdValueSchema,
		columnId: columnIdValueSchema.optional(),
	})
	.strict();
const shareColumnBodySchema = z
	.object({ targetAccountId: accountIdValueSchema })
	.strict();
const accountImportBodySchema = z
	.object({
		schemaVersion: z.literal(1),
		exportedAt: z.number().finite().nonnegative(),
		account: accountInputSchema,
		ownedColumns: z
			.array(
				z
					.object({ meta: columnMetaInputSchema, yjs: yjsBytesSchema })
					.strict(),
			)
			.max(100),
	})
	.strict();
const backupRestoreBodySchema = z
	.object({
		key: z.string().min(1).max(1024).optional(),
		mode: z.enum(["clone", "in_place"]).optional(),
	})
	.strict();

type RequestValidationResult<T> =
	| { ok: true; data: T }
	| { ok: false; response: Response };

function invalidRequestResponse(
	c: Context<{ Bindings: Bindings }>,
	error: z.ZodError,
): Response {
	return c.json(
		{
			error: "invalid_request",
			code: "invalid_request",
			issues: error.issues.map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			})),
		},
		400,
	);
}

function validateRequestInput<TSchema extends z.ZodType>(
	c: Context<{ Bindings: Bindings }>,
	schema: TSchema,
	input: unknown,
): RequestValidationResult<z.output<TSchema>> {
	const parsed = schema.safeParse(input);
	if (!parsed.success) {
		return { ok: false, response: invalidRequestResponse(c, parsed.error) };
	}
	return { ok: true, data: parsed.data };
}

function columnOwnerError(
	meta: ColumnMeta,
	accountId: string,
	message: string,
): Response {
	const stillHasAccess = hasColumnAccess(meta, accountId);
	return apiErrorResponse(
		stillHasAccess ? "not_owner" : "access_revoked",
		message,
		403,
	);
}

function columnLifecycleFailureResponse(
	failure: ColumnLifecycleFailure,
	accountId: string,
): Response {
	switch (failure.kind) {
		case "api":
			return apiErrorResponse(failure.code, failure.message, failure.status);
		case "schema":
			return schemaErrorResponse(failure.record, failure.result);
		case "owner":
			return columnOwnerError(failure.meta, accountId, failure.message);
	}
}

async function validateJsonBody<TSchema extends z.ZodType>(
	c: Context<{ Bindings: Bindings }>,
	schema: TSchema,
	options?: { optional?: boolean },
): Promise<RequestValidationResult<z.output<TSchema>>> {
	let input: unknown;
	try {
		const raw = await c.req.raw.clone().text();
		input = options?.optional && raw.trim() === "" ? {} : JSON.parse(raw);
	} catch {
		return validateRequestInput(c, schema, undefined);
	}
	return validateRequestInput(c, schema, input);
}

async function restoreColumnFromBackupPayload(
	env: Bindings,
	columnId: string,
	payload: ColumnBackupPayload,
) {
	return restoreColumnBackup({
		env,
		columnId,
		payload,
		createPreRestoreBackup: () => createColumnBackupSnapshot(env, columnId),
	});
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
		const parsedExistingColumns = parseSharedColumnIndex(sharedColumnsData);
		if (!parsedExistingColumns.ok) {
			throw new Error(
				`Invalid shared index for account ${normalizedAccountId}`,
			);
		}
		const existingColumns = parsedExistingColumns.value;

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
				{ error: "rate_limited", code: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const accountId = await allocateGeneratedId({
		createId: generateAccountId,
		isInUse: async (candidate) =>
			(await c.env.ACCOUNTS.get(`account:${normalizeAccountId(candidate)}`)) !== null,
	});
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
	const request = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!request.ok) return request.response;
	const accountId = request.data.id;

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			ipRateLimitKey("account-lookup", ip),
			RATE_LIMITS.accountLookup,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", code: "rate_limited", retryAfter: rateLimit.retryAfter },
				429,
			);
		}
	}

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

	if (!accountData) {
		return apiErrorResponse("not_found", "Account not found", 404);
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
	const parsedSharedColumnIds = parseSharedColumnIndex(sharedColumnsData);
	if (!parsedSharedColumnIds.ok) {
		return schemaErrorResponse("shared_index", parsedSharedColumnIds);
	}
	const sharedColumnIds = parsedSharedColumnIds.value;

	// Fetch metadata for shared columns
	const sharedColumns: ColumnMeta[] = [];
	const reconciledSharedColumnIds: string[] = [];
	for (const columnId of sharedColumnIds) {
		const stub = c.env.COLUMN_ROOM.get(
			c.env.COLUMN_ROOM.idFromName(columnId),
		);
		try {
			const response = await stub.fetch(new Request("http://do/meta"));
			if (response.ok) {
				const parsedMeta = parseColumnMetaRecord(await response.json());
				if (parsedMeta.ok) {
					const stillShared = hasColumnAccess(parsedMeta.value, accountId);
					if (stillShared) {
						sharedColumns.push(parsedMeta.value);
						reconciledSharedColumnIds.push(columnId);
					}
				} else {
					reconciledSharedColumnIds.push(columnId);
				}
			} else if (response.status !== 404) {
				reconciledSharedColumnIds.push(columnId);
			}
		} catch (err) {
			if (isDurableObjectDurationError(err)) {
				console.warn("Skipping shared column metadata due to DO duration limit", {
					columnId,
				});
				reconciledSharedColumnIds.push(columnId);
				continue;
			}
			throw err;
		}
	}
	if (
		!isReadOnlyMode(c) &&
		JSON.stringify(reconciledSharedColumnIds) !== JSON.stringify(sharedColumnIds)
	) {
		await c.env.ACCOUNTS.put(
			`shared:${normalizedId}`,
			JSON.stringify(reconciledSharedColumnIds),
		);
	}

	const now = Date.now();
	const trashKey = `trash:${normalizedId}`;
	const deletedColumnsRaw = await c.env.ACCOUNTS.get(trashKey);
	const deletedColumns = parseDeletedColumnRecords(deletedColumnsRaw)
		.filter((entry) => now - entry.deletedAt < TRASH_RETENTION_MS)
		.sort((a, b) => b.deletedAt - a.deletedAt);

	const originalDeleted = parseDeletedColumnRecords(deletedColumnsRaw);
	if (deletedColumns.length !== originalDeleted.length) {
		await c.env.ACCOUNTS.put(trashKey, JSON.stringify(deletedColumns));
	}

	return c.json({ account, sharedColumns, deletedColumns });
});

/**
 * Update column order for an account
 */
app.put("/api/account/:id/columns", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const request = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!request.ok) return request.response;
	const body = await validateJsonBody(c, columnOrderBodySchema);
	if (!body.ok) return body.response;
	const accountId = request.data.id;

	return withIdempotentWrite(
		c,
		{ scope: `account:${normalizeAccountId(accountId)}:columns`, accountId },
		async () => {
			const normalizedId = normalizeAccountId(accountId);
			const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

			if (!accountData) {
				return apiErrorResponse("not_found", "Account not found", 404);
			}

			const parsedAccount = parseAccountRecord(accountData);
			if (!parsedAccount.ok) {
				return schemaErrorResponse("account", parsedAccount);
			}
			const account = parsedAccount.value;
			account.columnOrder = body.data.columnOrder;
			await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

			return c.json({ success: true });
		},
	);
});

/**
 * Update hidden shared columns for an account
 */
app.put("/api/account/:id/hidden", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const request = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!request.ok) return request.response;
	const body = await validateJsonBody(c, hiddenColumnsBodySchema);
	if (!body.ok) return body.response;
	const accountId = request.data.id;

	return withIdempotentWrite(
		c,
		{ scope: `account:${normalizeAccountId(accountId)}:hidden`, accountId },
		async () => {
			const normalizedId = normalizeAccountId(accountId);
			const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);

			if (!accountData) {
				return apiErrorResponse("not_found", "Account not found", 404);
			}

			const parsedAccount = parseAccountRecord(accountData);
			if (!parsedAccount.ok) {
				return schemaErrorResponse("account", parsedAccount);
			}
			const account = parsedAccount.value;
			account.hiddenSharedColumns = body.data.hiddenSharedColumns;
			await c.env.ACCOUNTS.put(`account:${normalizedId}`, JSON.stringify(account));

			return c.json({ success: true });
		},
	);
});

/**
 * Export account-owned columns as JSON (self-serve)
 */
app.get("/api/account/:id/export", async (c) => {
	const path = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const accountIdParam = path.data.id;
	const requesterAccountId = headers.data.accountId;

	if (
		normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountIdParam)
	) {
		return apiErrorResponse("access_revoked", "Access denied", 403);
	}

	const normalizedId = normalizeAccountId(accountIdParam);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
	if (!accountData) {
		return apiErrorResponse("not_found", "Account not found", 404);
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

	const path = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const body = await validateJsonBody(c, accountImportBodySchema);
	if (!body.ok) return body.response;
	const accountIdParam = path.data.id;
	const requesterAccountId = headers.data.accountId;

	if (
		normalizeAccountId(requesterAccountId) !== normalizeAccountId(accountIdParam)
	) {
		return apiErrorResponse("access_revoked", "Access denied", 403);
	}

	return withIdempotentWrite(
		c,
		{ scope: `account:${normalizeAccountId(accountIdParam)}:import`, accountId: requesterAccountId },
		async () => {
			const normalizedId = normalizeAccountId(accountIdParam);
			const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
			if (!accountData) {
				return apiErrorResponse("not_found", "Account not found", 404);
			}

			const parsedAccount = parseAccountRecord(accountData);
			if (!parsedAccount.ok) {
				return schemaErrorResponse("account", parsedAccount);
			}

			const importedColumnIds: string[] = [];

			for (const column of body.data.ownedColumns) {
				const cloned = await cloneColumnSnapshot({
					env: c.env,
					ownerId: accountIdParam,
					snapshot: { meta: column.meta, yjs: column.yjs ?? null },
				});
				if (!cloned.ok) {
					return c.json({ error: cloned.code }, 503);
				}
				importedColumnIds.push(cloned.column.id);
			}

			return c.json({ success: true, importedColumns: importedColumnIds.length });
		},
	);
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

	const body = await validateJsonBody(c, createColumnBodySchema);
	if (!body.ok) return body.response;
	const accountId = body.data.accountId;
	const requestedColumnId = body.data.columnId;

	const normalizedAccountId = normalizeAccountId(accountId);

	return withIdempotentWrite(
		c,
		{
			scope: requestedColumnId
				? `account:${normalizedAccountId}:column:create:${requestedColumnId}`
				: `account:${normalizedAccountId}:column:create`,
			accountId,
			requestFingerprintSource: JSON.stringify(body.data),
		},
		async () => {
			const accountData = await c.env.ACCOUNTS.get(
				`account:${normalizedAccountId}`,
			);

			if (!accountData) {
				return apiErrorResponse("not_found", "Account not found", 404);
			}

			const parsedAccount = parseAccountRecord(accountData);
			if (!parsedAccount.ok) {
				return schemaErrorResponse("account", parsedAccount);
			}
			const account = parsedAccount.value;
			const columnId = requestedColumnId ?? crypto.randomUUID();
			const alreadyInOrder = account.columnOrder.includes(columnId);
			const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

			let existingMetaResponse: Response;
			try {
				existingMetaResponse = await stub.fetch(new Request("http://do/meta"));
			} catch (err) {
				if (isDurableObjectDurationError(err)) {
					console.error("Durable object unavailable during metadata check", {
						columnId,
					});
					return durableObjectUnavailableResponse();
				}
				throw err;
			}

			if (!existingMetaResponse.ok && existingMetaResponse.status >= 500) {
				console.error("Durable object metadata check failed", {
					columnId,
					status: existingMetaResponse.status,
				});
				return durableObjectUnavailableResponse();
			}

			if (existingMetaResponse.ok) {
				const parsedExisting = parseColumnMetaRecord(await existingMetaResponse.json());
				if (!parsedExisting.ok) {
					return schemaErrorResponse("column_meta", parsedExisting);
				}

				const existingMeta = parsedExisting.value;
				if (normalizeAccountId(existingMeta.ownerId) !== normalizedAccountId) {
					return c.json({ error: "Column already exists" }, 409);
				}

				if (!alreadyInOrder) {
					if (account.columnOrder.length >= 100) {
						return apiErrorResponse(
							"invalid_request",
							"Column limit reached (100)",
							400,
						);
					}

					account.columnOrder.push(columnId);
					await c.env.ACCOUNTS.put(
						`account:${normalizedAccountId}`,
						JSON.stringify(account),
					);
				}

				return c.json({ column: existingMeta });
			}

			// Check column limit (100 per account)
			if (!alreadyInOrder && account.columnOrder.length >= 100) {
				return apiErrorResponse(
					"invalid_request",
					"Column limit reached (100)",
					400,
				);
			}

			const meta: ColumnMeta = {
				schemaVersion: COLUMN_META_SCHEMA_VERSION,
				id: columnId,
				ownerId: displayAccountId(accountId),
				sharedWith: [],
				publicId: null,
				createdAt: Date.now(),
			};

			// Initialize the Durable Object
			try {
				const initResponse = await stub.fetch(
					new Request("http://do/init", {
						method: "POST",
						body: JSON.stringify(meta),
					}),
				);

				if (!initResponse.ok) {
					console.error("Failed to initialize column durable object", {
						columnId,
						status: initResponse.status,
					});
					return durableObjectUnavailableResponse();
				}
			} catch (err) {
				if (isDurableObjectDurationError(err)) {
					console.error("Durable object unavailable during column creation", {
						columnId,
					});
					return durableObjectUnavailableResponse();
				}
				throw err;
			}

			if (!alreadyInOrder) {
				// Add to account's column order
				account.columnOrder.push(columnId);
				await c.env.ACCOUNTS.put(
					`account:${normalizedAccountId}`,
					JSON.stringify(account),
				);
			}

			return c.json({ column: meta });
		},
	);
});

/**
 * Delete a column
 */
app.delete("/api/column/:id", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:delete`,
			accountId,
		},
		async () => {
			const result = await deleteColumn({ env: c.env, columnId, accountId });
			return result.ok
				? c.json(result.value)
				: columnLifecycleFailureResponse(result.failure, accountId);
		},
	);
});

/**
 * Restore a column from owner's garbage can
 */
app.post("/api/column/:id/restore", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:restore`,
			accountId,
		},
		async () => {
			const result = await restoreColumn({ env: c.env, columnId, accountId });
			return result.ok
				? c.json(result.value)
				: columnLifecycleFailureResponse(result.failure, accountId);
		},
	);
});

/**
 * Get column metadata
 */
app.get("/api/column/:id", async (c) => {
	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, optionalAccountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) {
		return apiErrorResponse("not_found", "Column not found", 404);
	}

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return schemaErrorResponse("column_meta", parsedMeta);
	}
	const meta = parsedMeta.value;

	// Check access
	if (accountId) {
		if (!hasColumnAccess(meta, accountId)) {
			return apiErrorResponse("access_revoked", "Access denied", 403);
		}
	} else {
		return apiErrorResponse("access_revoked", "Access denied", 403);
	}

	return c.json({ column: meta });
});

/**
 * WebSocket connection for column sync
 */
app.get("/api/column/:id/ws", async (c) => {
	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const query = validateRequestInput(c, columnSocketQuerySchema, {
		accountId: c.req.query("accountId"),
	});
	if (!query.ok) return query.response;
	const columnId = path.data.id;

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

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const body = await validateJsonBody(c, shareColumnBodySchema);
	if (!body.ok) return body.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;
	const targetAccountId = body.data.targetAccountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:share:${normalizeAccountId(targetAccountId)}`,
			accountId,
			requestFingerprintSource: JSON.stringify({ targetAccountId }),
		},
		async () => {
			const result = await shareColumn({
				env: c.env,
				columnId,
				accountId,
				targetAccountId,
			});
			return result.ok
				? c.json(result.value)
				: columnLifecycleFailureResponse(result.failure, accountId);
		},
	);
});

/**
 * Revoke sharing for a column
 */
app.delete("/api/column/:id/share/:targetId", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnSharePathSchema, {
		id: c.req.param("id"),
		targetId: c.req.param("targetId"),
	});
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const targetAccountId = path.data.targetId;
	const accountId = headers.data.accountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:revoke:${normalizeAccountId(targetAccountId)}`,
			accountId,
		},
		async () => {
			const result = await revokeColumnShare({
				env: c.env,
				columnId,
				accountId,
				targetAccountId,
			});
			return result.ok
				? c.json(result.value)
				: columnLifecycleFailureResponse(result.failure, accountId);
		},
	);
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

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:public:enable`,
			accountId,
		},
		async () => {
			const result = await enablePublicColumn({
				env: c.env,
				columnId,
				accountId,
			});
			if (!result.ok) {
				return columnLifecycleFailureResponse(result.failure, accountId);
			}

			const url = new URL(c.req.url);
			const publicUrl = `${url.origin}/p/${result.value.publicId}`;

			return c.json({ publicId: result.value.publicId, url: publicUrl });
		},
	);
});

/**
 * Disable public link for a column
 */
app.delete("/api/column/:id/public", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const headers = validateRequestInput(c, accountHeaderSchema, {
		accountId: c.req.header("X-Account-ID"),
	});
	if (!headers.ok) return headers.response;
	const columnId = path.data.id;
	const accountId = headers.data.accountId;

	return withIdempotentWrite(
		c,
		{
			scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:public:disable`,
			accountId,
		},
		async () => {
			const result = await disablePublicColumn({
				env: c.env,
				columnId,
				accountId,
			});
			return result.ok
				? c.json(result.value)
				: columnLifecycleFailureResponse(result.failure, accountId);
		},
	);
});

/**
 * Get public column metadata
 */
app.get("/api/p/:publicId", async (c) => {
	const request = validateRequestInput(c, publicPathSchema, {
		publicId: c.req.param("publicId"),
	});
	if (!request.ok) return request.response;
	const publicId = request.data.publicId;

	if (!shouldSkipRateLimit(c)) {
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT,
			resourceRateLimitKey("public-view", publicId),
			RATE_LIMITS.publicView,
		);

		if (!rateLimit.allowed) {
			return c.json(
				{ error: "rate_limited", code: "rate_limited", retryAfter: rateLimit.retryAfter },
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
		return apiErrorResponse("not_found", "Column not found", 404);
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
	const request = validateRequestInput(c, publicPathSchema, {
		publicId: c.req.param("publicId"),
	});
	if (!request.ok) return request.response;
	const publicId = request.data.publicId;

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
	const request = validateRequestInput(c, accountPathSchema, {
		id: c.req.param("id"),
	});
	if (!request.ok) return request.response;
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const accountId = request.data.id;

	const normalizedId = normalizeAccountId(accountId);
	const accountData = await c.env.ACCOUNTS.get(`account:${normalizedId}`);
	if (!accountData) {
		return apiErrorResponse("not_found", "Account not found", 404);
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
	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const query = validateRequestInput(c, backupListQuerySchema, {
		limit: c.req.query("limit"),
	});
	if (!query.ok) return query.response;
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const columnId = path.data.id;
	const limit = query.data.limit;
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
	const request = validateRequestInput(c, columnPathSchema, {
		id: c.req.param("id"),
	});
	if (!request.ok) return request.response;
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const columnId = request.data.id;
	try {
		const { key, snapshotAt, checksum } = await createColumnBackupSnapshot(
			c.env,
			columnId,
		);

		return c.json({ success: true, key, snapshotAt, checksum });
	} catch (error) {
		if (error instanceof Error && error.message === "column_not_found") {
			return apiErrorResponse("not_found", "Column not found", 404);
		}

		return c.json({ error: "backup_failed" }, 500);
	}
});

/**
 * Restore a column from backup snapshot
 */
app.post("/api/admin/backups/column/:id/restore", async (c) => {
	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const body = await validateJsonBody(c, backupRestoreBodySchema, {
		optional: true,
	});
	if (!body.ok) return body.response;
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const columnId = path.data.id;
	const mode = body.data.mode ?? "clone";

	let key = body.data.key;
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
		const cloned = await cloneColumnSnapshot({
			env: c.env,
			ownerId: backupMeta.ownerId,
			snapshot: { meta: backupMeta, yjs: parsed.yjs },
		});
		if (!cloned.ok) {
			return c.json({ error: cloned.code }, 500);
		}

		return c.json({
			success: true,
			mode,
			restoredFrom: key,
			snapshotAt: parsed.snapshotAt,
			originalColumnId: columnId,
			restoredColumnId: cloned.column.id,
		});
	}

	const restored = await restoreColumnBackup({
		env: c.env,
		columnId,
		payload: parsed,
		createPreRestoreBackup: () => createColumnBackupSnapshot(c.env, columnId),
	});
	if (!restored.ok) {
		const status =
			restored.code === "backup_checksum_mismatch" ||
			restored.code === "invalid_backup_payload" ||
			restored.code === "column_meta_invalid"
				? 400
				: 500;
		return c.json({ error: restored.code }, status);
	}

	return c.json({
		success: true,
		mode,
		restoredFrom: key,
		snapshotAt: parsed.snapshotAt,
		preRestoreBackupKey: restored.preRestoreBackupKey,
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

export default {
	fetch: app.fetch,
	scheduled: async (
		controller: ScheduledController,
		env: Bindings,
		executionCtx: ExecutionContext,
	) => {
		executionCtx.waitUntil(
			(async () => {
				const purgeResult = await purgeExpiredTrashedColumns({ env });
				console.log(
					JSON.stringify({
						event: "scheduled_trash_purge_run",
						cron: controller.cron,
						...purgeResult,
					}),
				);

				if (!isAutoBackupEnabled(env)) return;
				const backupResult = await runScheduledBackups(env);
				console.log(
					JSON.stringify({
						event: "scheduled_backup_run",
						cron: controller.cron,
						...backupResult,
					}),
				);
			})(),
		);
	},
};
