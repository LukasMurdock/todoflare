import { getRequestSession, sessionResponseCookies } from "./server/session";
import { restoreAccountBackup } from "./server/workflows/restore-account-backup";
import { createAccountBackup, readAccountBackup } from "./server/account-backup";
import { latestColumnBackupKey, listColumnBackups } from "./server/backup-catalog";
import { Hono, type Context } from "hono";
import { z } from "zod";
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
import { requireAccountCredential } from "./lib/http-account-auth";
import {
	checkRateLimit,
	getClientIP,
	ipRateLimitKey,
	resourceRateLimitKey,
	RATE_LIMITS,
} from "./lib/rate-limit";
import { ColumnRoomSql } from "./durable-objects/column-room";
import { IdempotencyCoordinatorSql } from "./durable-objects/idempotency-coordinator";
import { RateLimitCoordinatorSql } from "./durable-objects/rate-limit-coordinator";
import { AccountCoordinatorSql } from "./durable-objects/account-coordinator";
import { PublicIdCoordinatorSql } from "./durable-objects/public-id-coordinator";
import type { ApiErrorCode } from "./lib/api/errors";
import {
	accountContractSchema,
	accountIdContractSchema,
	columnIdContractSchema,
	columnMetaContractSchema,
	publicIdContractSchema,
} from "./lib/api/account-contract";
import {
	ACCOUNT_COMMAND_TYPES,
	ACCOUNT_COMMANDS,
	type AccountCommandType,
} from "./lib/api/account-commands";
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
import { mapWithConcurrency } from "./server/bounded-concurrency";
import { cloneColumnSnapshot } from "./server/workflows/clone-column-snapshot";
import { exportAccountColumns } from "./server/workflows/export-account-columns";
import {
	restoreColumnBackup,
	type ColumnBackupPayload,
} from "./server/workflows/restore-column-backup";
import {
	checksumColumnBackupPayload,
	MAX_YJS_UPDATE_BYTES,
	parseAndVerifyColumnBackup,
	yjsBytesSchema,
} from "./server/column-backup-payload";
import {
	accountRecordStore,
	mutateAccountRecord,
} from "./server/account-record-store";
import {
	beginLifecycleOperation,
	completeLifecycleOperation,
	registerColumn,
	type LifecycleOperation,
} from "./server/lifecycle-journal";
import { reconcileColumnLifecycle } from "./server/workflows/reconcile-column-lifecycle";
import { resolvePublicId } from "./server/public-id-registry";
import {
	isReadOnlyMode,
	readOnlyModeResponse,
} from "./server/read-only-mode";
import {
	cleanupAbandonedProvisionalUsers,
	createAuth,
	sanitizedAuthResponse,
} from "./server/auth";

declare const __TODOFLARE_E2E__: boolean;

// Re-export Durable Objects for Cloudflare
export {
	AccountCoordinatorSql,
	ColumnRoomSql,
	IdempotencyCoordinatorSql,
	PublicIdCoordinatorSql,
	RateLimitCoordinatorSql,
};

export type Bindings = {
	AUTH_DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	AUTH_ORIGIN?: string;
	AUTH_RP_ID?: string;
	AUTH_TEST_BYPASS?: string;
	ACCOUNTS: KVNamespace;
	COLUMN_ROOM: DurableObjectNamespace;
	IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
	RATE_LIMIT_COORDINATOR: DurableObjectNamespace;
	ACCOUNT_COORDINATOR: DurableObjectNamespace;
	PUBLIC_ID_COORDINATOR: DurableObjectNamespace;
	RATE_LIMIT_DISABLED?: string;
	READ_ONLY_MODE?: string;
	BACKUPS?: R2Bucket;
	BACKUP_ADMIN_TOKEN?: string;
	AUTO_BACKUP_ENABLED?: string;
	BACKUP_MAX_COLUMNS?: string;
	LIFECYCLE_METRICS?: {
		writeDataPoint(event: {
			blobs?: string[];
			doubles?: number[];
			indexes?: string[];
		}): void;
	};
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", async (c, next) => {
	await next();
	// Server-side getSession() can renew or expire cookies. Forward every cookie
	// individually, including on authentication failures; JSON alone loses them.
	for (const cookie of await sessionResponseCookies(c.req.raw)) {
		c.header("Set-Cookie", cookie, { append: true });
	}
});

// Authentication remains available to validate recovery, while credential changes
// must not race with a frozen account restore. Unknown auth routes fail closed.
const frozenAuthRoutes = new Set([
	"GET /api/auth/get-session",
	"GET /api/auth/passkey/list-user-passkeys",
	"GET /api/auth/passkey/generate-authenticate-options",
	"POST /api/auth/passkey/verify-authentication",
	"POST /api/auth/sign-out",
]);

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	if (isReadOnlyMode(c.env) && !frozenAuthRoutes.has(`${c.req.method} ${new URL(c.req.url).pathname}`)) {
		return readOnlyModeResponse();
	}
	const auth = createAuth(c.env, new URL(c.req.url).origin);
	if (new URL(c.req.url).pathname.endsWith("/passkey/delete-passkey")) {
		const session = await getRequestSession(c.req.raw, c.env);
		if (!session) return c.json({ error: "unauthorized" }, 401);
		const createdAt = new Date(session.session.createdAt).getTime();
		if (Date.now() - createdAt > 5 * 60 * 1000) {
			return c.json({ error: "recent_authentication_required" }, 401);
		}
		const passkeys = await c.env.AUTH_DB.prepare(
			'SELECT COUNT(*) AS count FROM "passkey" WHERE "userId" = ?',
		)
			.bind(session.user.id)
			.first<{ count: number }>();
		const recovery = await c.env.AUTH_DB.prepare(
			'SELECT "recoveryCodeHash" FROM "user" WHERE "id" = ?',
		)
			.bind(session.user.id)
			.first<{ recoveryCodeHash: string | null }>();
		if ((passkeys?.count ?? 0) <= 1 && !recovery?.recoveryCodeHash) {
			return c.json({ error: "last_recovery_method" }, 409);
		}
	}
	const response = await auth.handler(c.req.raw);
	return sanitizedAuthResponse(response);
});

app.use("/api/*", async (c, next) => {
	if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
	const origin = c.req.header("Origin");
	const fetchSite = c.req.header("Sec-Fetch-Site");
	if (
		(origin && origin !== new URL(c.req.url).origin) ||
		fetchSite === "cross-site"
	) {
		return c.json({ error: "cross_origin_request", code: "unauthorized" }, 403);
	}
	return next();
});

const IDEMPOTENCY_HEADER = "X-Idempotency-Key";
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const IDEMPOTENCY_CACHE_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_PENDING_WAIT_MS = 1500;
const IDEMPOTENCY_PENDING_POLL_MS = 50;
const ACCOUNT_METADATA_CONCURRENCY = 6;
const MAX_BACKUP_OBJECT_BYTES = MAX_YJS_UPDATE_BYTES * 4 + 1_000_000;

async function runJournaledLifecycle<T extends { ok: boolean }>(
	env: Bindings,
	operation: LifecycleOperation,
	handler: () => Promise<T>,
): Promise<T> {
	await beginLifecycleOperation(env.ACCOUNTS, operation);
	try {
		const result = await handler();
		await completeLifecycleOperation(env.ACCOUNTS, operation.operationId);
		return result;
	} catch (error) {
		console.error("Lifecycle operation retained for scheduled retry", {
			operationId: operation.operationId,
			kind: operation.kind,
			columnId: operation.kind === "create" ? operation.meta.id : operation.columnId,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

type ColumnMetadataFetchResult =
	| { columnId: string; response: Response }
	| { columnId: string; error: unknown };

async function fetchColumnMetadataBatch(
	columnRooms: DurableObjectNamespace,
	columnIds: readonly string[],
): Promise<ColumnMetadataFetchResult[]> {
	return mapWithConcurrency(
		columnIds,
		ACCOUNT_METADATA_CONCURRENCY,
		async (columnId) => {
			const stub = columnRooms.get(columnRooms.idFromName(columnId));
			try {
				return {
					columnId,
					response: await stub.fetch(new Request("http://do/meta")),
				};
			} catch (error) {
				return { columnId, error };
			}
		},
	);
}

function apiErrorResponse(
	code: ApiErrorCode,
	message: string,
	status: number,
): Response {
	return Response.json({ error: message, code }, { status });
}

function schemaErrorResponse(
	kind: "account" | "column_meta" | "shared_index" | "trash",
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

function idempotencyOutcomeUnknownResponse() {
	return Response.json(
		{
			error: "idempotency_outcome_unknown",
			code: "idempotency_in_progress",
			message:
				"A previous attempt may have executed, but its outcome could not be recorded. Retry with a new operation only after reconciling state.",
		},
		{ status: 409 },
	);
}

function idempotencyCoordinatorUnavailableResponse() {
	return Response.json(
		{
			error: "idempotency_unavailable",
			code: "durable_object_unavailable",
			message: "Idempotency coordination is temporarily unavailable.",
		},
		{ status: 503 },
	);
}

function toIdempotentReplayResponse(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
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
	stub: DurableObjectStub,
	fingerprint: string,
): Promise<Response | null> {
	const deadline = Date.now() + IDEMPOTENCY_PENDING_WAIT_MS;

	while (Date.now() < deadline) {
		await wait(IDEMPOTENCY_PENDING_POLL_MS);
		const outcome = await beginIdempotentRequest(stub, fingerprint);
		if (outcome.kind === "conflict") return idempotencyKeyConflictResponse();
		if (outcome.kind === "completed") {
			return toIdempotentReplayResponse(outcome.status, outcome.body);
		}
		if (outcome.kind === "indeterminate") return idempotencyOutcomeUnknownResponse();
		if (outcome.kind === "acquired") {
			throw new Error("Idempotency coordinator unexpectedly released an active claim");
		}
	}

	return idempotencyRequestInProgressResponse();
}

type IdempotencyBeginOutcome =
	| { kind: "acquired"; ownerToken: string }
	| { kind: "completed"; status: number; body: unknown }
	| { kind: "pending" }
	| { kind: "indeterminate" }
	| { kind: "conflict" };

async function beginIdempotentRequest(
	stub: DurableObjectStub,
	fingerprint: string,
): Promise<IdempotencyBeginOutcome> {
	const response = await stub.fetch(
		new Request("http://idempotency/begin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fingerprint,
				pendingExpiresAt: Date.now() + IDEMPOTENCY_CACHE_TTL_SECONDS * 1000,
			}),
		}),
	);
	if (!response.ok) throw new Error(`Idempotency coordinator failed: ${response.status}`);
	return (await response.json()) as IdempotencyBeginOutcome;
}

async function finishIdempotentRequest(
	stub: DurableObjectStub,
	path: "complete" | "indeterminate",
	payload: Record<string, unknown>,
): Promise<void> {
	const response = await stub.fetch(
		new Request(`http://idempotency/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...payload,
				expiresAt: Date.now() + IDEMPOTENCY_CACHE_TTL_SECONDS * 1000,
			}),
		}),
	);
	if (!response.ok) throw new Error(`Idempotency coordinator failed: ${response.status}`);
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
	successSchema?: z.ZodType;
}

function serverContractInvalidResponse(): Response {
	return apiErrorResponse(
		"server_contract_invalid",
		"Mutation handler returned an invalid success response",
		503,
	);
}

async function validateSuccessfulWriteResponse(
	response: Response,
	schema?: z.ZodType,
): Promise<Response> {
	if (!response.ok || !schema) return response;
	const body = await response
		.clone()
		.json()
		.catch(() => null);
	return schema.safeParse(body).success
		? response
		: serverContractInvalidResponse();
}

async function withIdempotentWrite(
	c: Context<{ Bindings: Bindings }>,
	options: IdempotentWriteOptions,
	handler: () => Promise<Response>,
): Promise<Response> {
	const idempotencyKey = parseIdempotencyKey(c.req.header(IDEMPOTENCY_HEADER));
	if (!idempotencyKey) {
		return validateSuccessfulWriteResponse(await handler(), options.successSchema);
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
	const stub = c.env.IDEMPOTENCY_COORDINATOR.get(
		c.env.IDEMPOTENCY_COORDINATOR.idFromName(cacheKey),
	);
	let outcome: IdempotencyBeginOutcome;
	try {
		outcome = await beginIdempotentRequest(stub, fingerprint);
	} catch (error) {
		console.error("Idempotency coordinator unavailable", error);
		return idempotencyCoordinatorUnavailableResponse();
	}
	if (outcome.kind === "conflict") return idempotencyKeyConflictResponse();
	if (outcome.kind === "completed") {
		return validateSuccessfulWriteResponse(
			toIdempotentReplayResponse(outcome.status, outcome.body),
			options.successSchema,
		);
	}
	if (outcome.kind === "indeterminate") return idempotencyOutcomeUnknownResponse();
	if (outcome.kind === "pending") {
		try {
			const response =
				(await waitForPendingIdempotentCompletion(stub, fingerprint)) ??
				idempotencyRequestInProgressResponse();
			return validateSuccessfulWriteResponse(
				response,
				options.successSchema,
			);
		} catch (error) {
			console.error("Idempotency coordinator unavailable while waiting", error);
			return idempotencyCoordinatorUnavailableResponse();
		}
	}

	try {
		const response = await validateSuccessfulWriteResponse(
			await handler(),
			options.successSchema,
		);
		const body = await response.clone().json().catch(() => undefined);
		if (response.status < 500 && typeof body !== "undefined") {
			await finishIdempotentRequest(stub, "complete", {
				ownerToken: outcome.ownerToken,
				status: response.status,
				body,
			});
		} else {
			await finishIdempotentRequest(stub, "indeterminate", {
				ownerToken: outcome.ownerToken,
			});
		}

		return response;
	} catch (err) {
		await finishIdempotentRequest(stub, "indeterminate", {
			ownerToken: outcome.ownerToken,
		}).catch((markError) => {
			console.error("Failed to mark idempotency outcome indeterminate", markError);
		});
		throw err;
	}
}

function blockWritesIfReadOnly(c: Context<{ Bindings: Bindings }>): Response | null {
	return isReadOnlyMode(c.env) ? readOnlyModeResponse() : null;
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

/** Imports accept only server-issued UUID column IDs. */
const columnMetaInputSchema = columnMetaContractSchema.extend({
	id: columnIdContractSchema,
});
const accountInputSchema = accountContractSchema.extend({
	columnOrder: z.array(columnIdContractSchema).max(100),
	hiddenSharedColumns: z.array(columnIdContractSchema).max(100),
});

const columnPathSchema = z.object({ id: columnIdContractSchema }).strict();
const publicPathSchema = z.object({ publicId: publicIdContractSchema }).strict();
const backupListQuerySchema = z
	.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
	.strict();

const accountExportColumnInputSchema = z
	.object({
		meta: columnMetaInputSchema,
		yjs: yjsBytesSchema,
	})
	.strict();

function validateAccountImportCompleteness(
	payload: {
		account: z.output<typeof accountInputSchema>;
		ownedColumns: Array<z.output<typeof accountExportColumnInputSchema>>;
		expectedColumnIds?: string[];
	},
	context: z.RefinementCtx,
) {
	const orderedIds = payload.account.columnOrder;
	const exportedIds = payload.ownedColumns.map((column) => column.meta.id);
	const expectedIds = payload.expectedColumnIds ?? orderedIds;
	const accountId = normalizeAccountId(payload.account.id);

	if (new Set(orderedIds).size !== orderedIds.length) {
		context.addIssue({
			code: "custom",
			path: ["account", "columnOrder"],
			message: "Account column order must not contain duplicate IDs",
		});
	}
	if (new Set(exportedIds).size !== exportedIds.length) {
		context.addIssue({
			code: "custom",
			path: ["ownedColumns"],
			message: "Exported columns must not contain duplicate IDs",
		});
	}
	if (JSON.stringify(expectedIds) !== JSON.stringify(orderedIds)) {
		context.addIssue({
			code: "custom",
			path: ["expectedColumnIds"],
			message: "Expected columns must match the account column order",
		});
	}
	if (JSON.stringify(exportedIds) !== JSON.stringify(expectedIds)) {
		context.addIssue({
			code: "custom",
			path: ["ownedColumns"],
			message: "Export must contain every expected column in account order",
		});
	}
	for (const [index, column] of payload.ownedColumns.entries()) {
		if (normalizeAccountId(column.meta.ownerId) !== accountId) {
			context.addIssue({
				code: "custom",
				path: ["ownedColumns", index, "meta", "ownerId"],
				message: "Exported column owner does not match the exported account",
			});
		}
	}
}

const accountImportV1BodySchema = z
	.object({
		schemaVersion: z.literal(1),
		exportedAt: z.number().finite().nonnegative(),
		account: accountInputSchema,
		ownedColumns: z.array(accountExportColumnInputSchema).max(100),
	})
	.strict()
	.superRefine(validateAccountImportCompleteness);

const accountImportV2BodySchema = z
	.object({
		schemaVersion: z.literal(2),
		exportedAt: z.number().finite().nonnegative(),
		complete: z.literal(true),
		expectedColumnIds: z.array(columnIdContractSchema).max(100),
		account: accountInputSchema,
		ownedColumns: z.array(accountExportColumnInputSchema).max(100),
	})
	.strict()
	.superRefine(validateAccountImportCompleteness);

const accountImportBodySchema = z.union([
	accountImportV1BodySchema,
	accountImportV2BodySchema,
]);
const backupRestoreBodySchema = z
	.object({
		key: z.string().min(1).max(1024).optional(),
		mode: z.enum(["clone", "in_place"]).optional(),
	})
	.strict();
const accountAdminBodySchema = z.object({ accountId: accountIdContractSchema, key: z.string().optional() }).strict();

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
		createPreRestoreBackup: () => createPreRestoreColumnBackup(env, columnId),
	});
}

async function readAndVerifyColumnBackup(
	object: R2ObjectBody,
	columnId: string,
) {
	if (object.size > MAX_BACKUP_OBJECT_BYTES) {
		return { ok: false as const, code: "invalid_backup_payload" as const };
	}
	return parseAndVerifyColumnBackup(await object.text(), columnId);
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
		const sharedColumnsData = await accountRecordStore(env).get(`shared:${normalizedAccountId}`);
		const parsedExistingColumns = parseSharedColumnIndex(sharedColumnsData);
		if (!parsedExistingColumns.ok) {
			throw new Error(
				`Invalid shared index for account ${normalizedAccountId}`,
			);
		}
		const existingColumns = parsedExistingColumns.value;

		for (const columnId of expectedColumnsSet) {
			if (!existingColumns.includes(columnId)) {
				await mutateAccountRecord(env, `shared:${normalizedAccountId}`, {
					kind: "shared-add",
					columnId,
				});
			}
		}
	}
}

async function createColumnBackupSnapshot(env: Bindings, columnId: string, prefix = "columns") {
	if (!env.BACKUPS) {
		throw new Error("backup_not_configured");
	}

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const exportResponse = await stub.fetch(new Request("http://do/export"));

	if (exportResponse.status === 503) {
		// Keep an independent copy of undecodable storage before any recovery
		// replaces it. It is diagnostic data, never a valid document snapshot.
		const raw = await stub.fetch(new Request("http://do/export-raw"));
		if (!raw.ok) throw new Error("raw_column_backup_failed");
		const snapshotAt = Date.now();
		const key = `raw-columns/${columnId}/${snapshotAt}.json`;
		const bytes = await raw.text();
		await env.BACKUPS.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
		return { key, snapshotAt, checksum: "raw-recovery-source" };
	}
	if (!exportResponse.ok) {
		throw new Error("column_not_found");
	}

	const exported = (await exportResponse.json()) as {
		meta: unknown;
		yjs: unknown;
	};
	const parsedMeta = parseColumnMetaRecord(exported.meta);
	if (!parsedMeta.ok || parsedMeta.value.id !== columnId) {
		throw new Error("column_meta_invalid");
	}
	const parsedYjs = yjsBytesSchema.safeParse(exported.yjs);
	if (!parsedYjs.success) {
		throw new Error("column_yjs_invalid");
	}

	const snapshotAt = Date.now();
	const key = prefix === "columns" ? backupObjectKey(columnId, snapshotAt) : `${prefix}/${columnId}/${snapshotAt}-${crypto.randomUUID()}.json`;

	const basePayload = {
		schemaVersion: 1 as const,
		columnId,
		snapshotAt,
		meta: parsedMeta.value,
		yjs: parsedYjs.data,
	};

	const checksum = await checksumColumnBackupPayload(basePayload);
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

async function createPreRestoreColumnBackup(env: Bindings, columnId: string) {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const current = await stub.fetch(new Request("http://do/meta"));
	if (current.status === 404) return { key: null };
	return createColumnBackupSnapshot(env, columnId, "pre-restore/columns");
}

async function collectBackupInventory(env: Bindings) {
	const columnIds = new Set<string>();
	const columnsByOwner = new Map<string, string[]>();
	const accountIds: string[] = [];
	let invalidAccounts = 0;
	for (const prefix of ["account:", "column-registry:"]) {
		let cursor: string | undefined;
		do {
			const page = await env.ACCOUNTS.list({ prefix, cursor, limit: 1000 });
			for (const key of page.keys) {
				if (prefix === "account:") {
					const raw = await accountRecordStore(env).get(key.name);
					const account = raw === null ? null : parseAccountRecord(raw);
					const id = key.name.slice(prefix.length);
					const trash = parseDeletedColumnRecords(await accountRecordStore(env).get(`trash:${id}`));
					if (!account?.ok || !trash.ok) { invalidAccounts++; continue; }
					accountIds.push(id);
					for (const columnId of [...account.value.columnOrder, ...trash.value.map(row => row.columnId)]) columnIds.add(columnId);
				} else {
					const raw = await env.ACCOUNTS.get(key.name);
					if (!raw) continue;
					try {
						const meta = parseColumnMetaRecord(JSON.parse(raw));
						if (!meta.ok) { invalidAccounts++; continue; }
						columnIds.add(meta.value.id);
						const ownerId = normalizeAccountId(meta.value.ownerId);
						columnsByOwner.set(ownerId, [...(columnsByOwner.get(ownerId) ?? []), meta.value.id]);
					} catch { invalidAccounts++; }
				}
			}
			if (page.list_complete) break;
			cursor = page.cursor;
		} while (cursor);
	}
	return { columnIds: Array.from(columnIds).sort(), columnsByOwner, accountIds, invalidAccounts };
}

export async function runScheduledBackups(env: Bindings) {
	if (!env.BACKUPS) return { skipped: true, reason: "backup_not_configured" as const };
	const inventory = await collectBackupInventory(env);
	const stateObject = await env.BACKUPS.get("backup-state.json");
	const state = stateObject ? await stateObject.json<{ afterColumnId?: string }>() : {};
	const after = state.afterColumnId ?? "";
	const split = inventory.columnIds.findIndex(id => id > after);
	const ordered = split < 0 ? inventory.columnIds : [...inventory.columnIds.slice(split), ...inventory.columnIds.slice(0, split)];
	const selected = ordered.slice(0, parseBackupMaxColumns(env));
	let backedUp = 0, failed = 0, accountsBackedUp = 0, rawCopies = 0;
	for (const accountId of inventory.accountIds) {
		try { await createAccountBackup(env, accountId, inventory.columnsByOwner.get(accountId)); accountsBackedUp++; }
		catch { failed++; }
	}
	for (const columnId of selected) {
		try {
			const snapshot = await createColumnBackupSnapshot(env, columnId);
			if (snapshot.checksum === "raw-recovery-source") { rawCopies++; failed++; } else backedUp++;
		}
		catch { failed++; }
	}
	const result = {
		skipped: false, completedAt: Date.now(),
		columnsDiscovered: inventory.columnIds.length, columnsSelected: selected.length,
		backedUp, accountsBackedUp, rawCopies, failed, invalidAccounts: inventory.invalidAccounts,
		afterColumnId: selected.at(-1) ?? after,
	};
	await env.BACKUPS.put("backup-state.json", JSON.stringify(result));
	env.LIFECYCLE_METRICS?.writeDataPoint({ indexes: ["scheduled-backups"], doubles: [result.columnsDiscovered, backedUp, accountsBackedUp, failed, result.invalidAccounts] });
	return result;
}

// ============================================
// Account Routes
// ============================================

app.get("/api/auth-status", async (c) => {
	c.header("Cache-Control", "private, no-store");
	const session = await getRequestSession(c.req.raw, c.env);
	if (!session || !validateAccountId(session.user.id)) {
		return c.json({ accountId: null, state: "signed_out" as const });
	}

	const accountId = normalizeAccountId(session.user.id);
	const credential = await c.env.AUTH_DB.prepare(
		'SELECT 1 AS present FROM "passkey" WHERE "userId" = ? LIMIT 1',
	)
		.bind(accountId)
		.first<{ present: number }>();
	if (!credential) {
		return c.json({ accountId, state: "provisional" as const });
	}
	const domainAccount = await accountRecordStore(c.env).get(`account:${accountId}`);
	return c.json({
		accountId,
		state: domainAccount ? ("passkey" as const) : ("provisioning" as const),
	});
});

/**
 * Create a new account
 * Rate limited: 5 per IP per hour
 */
app.post("/api/account", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;
	const compiledE2E =
		typeof __TODOFLARE_E2E__ !== "undefined" && __TODOFLARE_E2E__;
	const allowTestBootstrap =
		(c.env.AUTH_TEST_BYPASS === "true" || compiledE2E) &&
		c.req.header("X-Test-Disable-Auth-Bypass") !== "1";
	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok && !allowTestBootstrap) return auth.response;

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT_COORDINATOR,
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

	const normalizedId = auth.ok
		? auth.accountId
		: normalizeAccountId(
				await allocateGeneratedId({
					createId: generateAccountId,
					isInUse: async (candidate) =>
						(await accountRecordStore(c.env).get(
							`account:${normalizeAccountId(candidate)}`,
						)) !== null,
				}),
			);
	const existing = await accountRecordStore(c.env).get(`account:${normalizedId}`);
	if (existing) {
		const parsed = parseAccountRecord(existing);
		return parsed.ok
			? c.json({ account: parsed.value })
			: schemaErrorResponse("account", parsed);
	}

	const account: Account = {
		schemaVersion: ACCOUNT_SCHEMA_VERSION,
		id: displayAccountId(normalizedId),
		columnOrder: [],
		hiddenSharedColumns: [],
		createdAt: Date.now(),
	};

	await accountRecordStore(c.env).put(`account:${normalizedId}`, JSON.stringify(account));

	return c.json({ account });
});

/**
 * Get account metadata
 * Rate limited: 20 per IP per minute
 */
app.get("/api/account", async (c) => {
	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const accountId = auth.accountId;

	if (!shouldSkipRateLimit(c)) {
		const ip = getClientIP(c.req.raw);
		const rateLimit = await checkRateLimit(
			c.env.RATE_LIMIT_COORDINATOR,
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
	const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);

	if (!accountData) {
		return apiErrorResponse("not_found", "Account not found", 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}
	const account = parsedAccount.value;
	const trashKey = `trash:${normalizedId}`;
	const deletedColumnsRaw = await accountRecordStore(c.env).get(trashKey);
	const parsedDeletedColumns = parseDeletedColumnRecords(deletedColumnsRaw);
	if (!parsedDeletedColumns.ok) {
		console.error("Trash schema guard blocked account hydration", {
			accountId: normalizedId,
			code: parsedDeletedColumns.code,
			expectedVersion: parsedDeletedColumns.expectedVersion,
			foundVersion: parsedDeletedColumns.foundVersion ?? null,
		});
		return schemaErrorResponse("trash", parsedDeletedColumns);
	}

	// Fetch authoritative metadata for owned columns so account convergence can
	// confirm sharing and public-link state rather than retaining client effects.
	const ownedColumns: ColumnMeta[] = [];
	const ownedMetadataResults = await fetchColumnMetadataBatch(
		c.env.COLUMN_ROOM,
		account.columnOrder,
	);
	for (const result of ownedMetadataResults) {
		if ("error" in result) {
			if (isDurableObjectDurationError(result.error)) {
				return apiErrorResponse(
					"durable_object_unavailable",
					"Owned column metadata is temporarily unavailable",
					503,
				);
			}
			throw result.error;
		}
		if (result.response.status === 404) continue;
		if (!result.response.ok) {
			return apiErrorResponse(
				"durable_object_unavailable",
				"Failed to load owned column metadata",
				503,
			);
		}
		const parsedMeta = parseColumnMetaRecord(await result.response.json());
		if (!parsedMeta.ok) {
			return schemaErrorResponse("column_meta", parsedMeta);
		}
		ownedColumns.push(parsedMeta.value);
	}

	// Get shared columns (columns where this account is in sharedWith)
	const sharedColumnsData = await accountRecordStore(c.env).get(
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
	const sharedMetadataResults = await fetchColumnMetadataBatch(
		c.env.COLUMN_ROOM,
		sharedColumnIds,
	);
	for (const result of sharedMetadataResults) {
		if ("response" in result) {
			if (result.response.ok) {
				const parsedMeta = parseColumnMetaRecord(await result.response.json());
				if (parsedMeta.ok) {
					const stillShared = hasColumnAccess(parsedMeta.value, accountId);
					if (stillShared) {
						sharedColumns.push(parsedMeta.value);
						reconciledSharedColumnIds.push(result.columnId);
					}
				} else {
					reconciledSharedColumnIds.push(result.columnId);
				}
			} else if (result.response.status !== 404) {
				reconciledSharedColumnIds.push(result.columnId);
			}
		} else {
			if (isDurableObjectDurationError(result.error)) {
				console.warn("Skipping shared column metadata due to DO duration limit", {
					columnId: result.columnId,
				});
				reconciledSharedColumnIds.push(result.columnId);
				continue;
			}
			throw result.error;
		}
	}
	if (
		!isReadOnlyMode(c.env) &&
		JSON.stringify(reconciledSharedColumnIds) !== JSON.stringify(sharedColumnIds)
	) {
		const reconciled = new Set(reconciledSharedColumnIds);
		for (const columnId of sharedColumnIds) {
			if (!reconciled.has(columnId)) {
				await mutateAccountRecord(c.env, `shared:${normalizedId}`, {
					kind: "shared-remove",
					columnId,
				});
			}
		}
	}

	const now = Date.now();
	const originalDeleted = parsedDeletedColumns.value;
	const deletedColumns = originalDeleted
		.filter((entry) => now - entry.deletedAt < TRASH_RETENTION_MS)
		.sort((a, b) => b.deletedAt - a.deletedAt);

	if (!isReadOnlyMode(c.env) && deletedColumns.length !== originalDeleted.length) {
		const retained = new Set(deletedColumns.map((entry) => entry.columnId));
		for (const entry of originalDeleted) {
			if (!retained.has(entry.columnId)) {
				await mutateAccountRecord(c.env, trashKey, {
					kind: "trash-remove",
					columnId: entry.columnId,
				});
			}
		}
	}

	return c.json(
		{ account, ownedColumns, sharedColumns, deletedColumns },
		200,
		{ "Cache-Control": "private, no-store" },
	);
});

/**
 * Routes for offline-capable account commands. The method, path and body
 * contract come from ACCOUNT_COMMANDS; the mapped type makes a command without
 * a server handler a compile error.
 */
const accountCommandHandlers: {
	[T in AccountCommandType]: (c: Context<{ Bindings: Bindings }>) => Promise<Response>;
} = {
	/**
	 * Update column order for an account
	 */
	"column.reorder": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, ACCOUNT_COMMANDS["column.reorder"].body);
		if (!body.ok) return body.response;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:columns`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.reorder"].response,
			},
			async () => {
				const normalizedId = normalizeAccountId(accountId);
				const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);

				if (!accountData) {
					return apiErrorResponse("not_found", "Account not found", 404);
				}

				const parsedAccount = parseAccountRecord(accountData);
				if (!parsedAccount.ok) {
					return schemaErrorResponse("account", parsedAccount);
				}
				await mutateAccountRecord(c.env, `account:${normalizedId}`, {
					kind: "account-reorder",
					columnOrder: body.data.columnOrder,
				});

				return c.json({ success: true });
			},
		);
	},

	/**
	 * Update hidden shared columns for an account
	 */
	"column.hide_shared": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, ACCOUNT_COMMANDS["column.hide_shared"].body);
		if (!body.ok) return body.response;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:hidden`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.hide_shared"].response,
			},
			async () => {
				const normalizedId = normalizeAccountId(accountId);
				const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);

				if (!accountData) {
					return apiErrorResponse("not_found", "Account not found", 404);
				}

				const parsedAccount = parseAccountRecord(accountData);
				if (!parsedAccount.ok) {
					return schemaErrorResponse("account", parsedAccount);
				}
				await mutateAccountRecord(c.env, `account:${normalizedId}`, {
					kind: "account-set-hidden",
					hiddenSharedColumns: body.data.hiddenSharedColumns,
				});

				return c.json({ success: true });
			},
		);
	},

	/**
	 * Create a new column
	 */
	"column.create": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, ACCOUNT_COMMANDS["column.create"].body);
		if (!body.ok) return body.response;
		const accountId = auth.accountId;
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
				successSchema: ACCOUNT_COMMANDS["column.create"].response,
			},
			async () => {
				const accountData = await accountRecordStore(c.env).get(
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
						try {
							await mutateAccountRecord(c.env, `account:${normalizedAccountId}`, {
								kind: "account-add-column",
								columnId,
								maxColumns: 100,
							});
						} catch (error) {
							if (error instanceof Error && error.message === "Column limit reached") {
								return apiErrorResponse(
									"invalid_request",
									"Column limit reached (100)",
									400,
								);
							}
							throw error;
						}
					}
					await registerColumn(c.env.ACCOUNTS, existingMeta);

					return c.json({ column: existingMeta });
				}

				const meta: ColumnMeta = {
					schemaVersion: COLUMN_META_SCHEMA_VERSION,
					id: columnId,
					ownerId: displayAccountId(accountId),
					sharedWith: [],
					publicId: null,
					createdAt: Date.now(),
				};
				const createOperation: LifecycleOperation = {
					kind: "create",
					operationId: crypto.randomUUID(),
					createdAt: Date.now(),
					meta,
				};
				await beginLifecycleOperation(c.env.ACCOUNTS, createOperation);
				await registerColumn(c.env.ACCOUNTS, meta);
				if (!alreadyInOrder) {
					try {
						await mutateAccountRecord(c.env, `account:${normalizedAccountId}`, {
							kind: "account-add-column",
							columnId,
							maxColumns: 100,
						});
					} catch (error) {
						await completeLifecycleOperation(c.env.ACCOUNTS, createOperation.operationId);
						await c.env.ACCOUNTS.delete(`column-registry:${columnId}`);
						if (error instanceof Error && error.message === "Column limit reached") {
							return apiErrorResponse(
								"invalid_request",
								"Column limit reached (100)",
								400,
							);
						}
						throw error;
					}
				}

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

				await completeLifecycleOperation(c.env.ACCOUNTS, createOperation.operationId);

				return c.json({ column: meta });
			},
		);
	},

	/**
	 * Delete a column
	 */
	"column.delete": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const columnId = path.data.id;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:delete`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.delete"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "delete",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
					},
					() => deleteColumn({ env: c.env, columnId, accountId }),
				);
				return result.ok
					? c.json(result.value)
					: columnLifecycleFailureResponse(result.failure, accountId);
			},
		);
	},

	/**
	 * Restore a column from owner's garbage can
	 */
	"column.restore": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const columnId = path.data.id;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:restore`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.restore"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "restore",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
					},
					() => restoreColumn({ env: c.env, columnId, accountId }),
				);
				return result.ok
					? c.json(result.value)
					: columnLifecycleFailureResponse(result.failure, accountId);
			},
		);
	},

	/**
	 * Share a column with another account
	 */
	"column.share": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, ACCOUNT_COMMANDS["column.share"].body);
		if (!body.ok) return body.response;
		const columnId = path.data.id;
		const accountId = auth.accountId;
		const targetAccountId = body.data.targetAccountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:share:${normalizeAccountId(targetAccountId)}`,
				accountId,
				requestFingerprintSource: JSON.stringify({ targetAccountId }),
				successSchema: ACCOUNT_COMMANDS["column.share"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "share",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
						targetAccountId,
					},
					() =>
						shareColumn({
							env: c.env,
							columnId,
							accountId,
							targetAccountId,
						}),
				);
				return result.ok
					? c.json(result.value)
					: columnLifecycleFailureResponse(result.failure, accountId);
			},
		);
	},

	/**
	 * Revoke sharing for a column
	 */
	"column.revoke": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const body = await validateJsonBody(c, ACCOUNT_COMMANDS["column.revoke"].body);
		if (!body.ok) return body.response;
		const columnId = path.data.id;
		const targetAccountId = body.data.targetAccountId;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:revoke:${normalizeAccountId(targetAccountId)}`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.revoke"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "revoke",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
						targetAccountId,
					},
					() =>
						revokeColumnShare({
							env: c.env,
							columnId,
							accountId,
							targetAccountId,
						}),
				);
				return result.ok
					? c.json(result.value)
					: columnLifecycleFailureResponse(result.failure, accountId);
			},
		);
	},

	/**
	 * Enable public link for a column
	 */
	"column.public.enable": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const columnId = path.data.id;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:public:enable`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.public.enable"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "enable-public",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
					},
					() => enablePublicColumn({ env: c.env, columnId, accountId }),
				);
				if (!result.ok) {
					return columnLifecycleFailureResponse(result.failure, accountId);
				}

				const url = new URL(c.req.url);
				const publicUrl = `${url.origin}/p/${result.value.publicId}`;

				return c.json({ publicId: result.value.publicId, url: publicUrl });
			},
		);
	},

	/**
	 * Disable public link for a column
	 */
	"column.public.disable": async (c) => {
		const readOnlyResponse = blockWritesIfReadOnly(c);
		if (readOnlyResponse) return readOnlyResponse;

		const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
		if (!path.ok) return path.response;
		const auth = await requireAccountCredential(c.req.raw, c.env);
		if (!auth.ok) return auth.response;
		const columnId = path.data.id;
		const accountId = auth.accountId;

		return withIdempotentWrite(
			c,
			{
				scope: `account:${normalizeAccountId(accountId)}:column:${columnId}:public:disable`,
				accountId,
				successSchema: ACCOUNT_COMMANDS["column.public.disable"].response,
			},
			async () => {
				const result = await runJournaledLifecycle(
					c.env,
					{
						kind: "disable-public",
						operationId: crypto.randomUUID(),
						createdAt: Date.now(),
						columnId,
						accountId,
					},
					() => disablePublicColumn({ env: c.env, columnId, accountId }),
				);
				return result.ok
					? c.json(result.value)
					: columnLifecycleFailureResponse(result.failure, accountId);
			},
		);
	},
};

for (const type of ACCOUNT_COMMAND_TYPES) {
	const { method, path } = ACCOUNT_COMMANDS[type];
	app.on(method, path, accountCommandHandlers[type]);
}

/**
 * Export account-owned columns as JSON (self-serve)
 */
app.get("/api/account/export", async (c) => {
	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const accountId = auth.accountId;
	const normalizedId = normalizeAccountId(accountId);
	const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);
	if (!accountData) {
		return apiErrorResponse("not_found", "Account not found", 404);
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return schemaErrorResponse("account", parsedAccount);
	}

	const exportedColumns = await exportAccountColumns({
		columnRooms: c.env.COLUMN_ROOM,
		columnIds: parsedAccount.value.columnOrder,
		accountId,
		concurrency: ACCOUNT_METADATA_CONCURRENCY,
	});
	if (!exportedColumns.ok) {
		console.error("Account export incomplete", {
			accountId: normalizedId,
			failures: exportedColumns.failures,
		});
		return c.json(
			{
				error: "Account export could not include every owned column",
				code: "account_export_incomplete" as const,
				message: "Account export could not include every owned column",
				failedColumns: exportedColumns.failures,
			},
			503,
			{ "Cache-Control": "private, no-store" },
		);
	}

	const payload: AccountExportPayload = {
		schemaVersion: 2,
		exportedAt: Date.now(),
		complete: true,
		expectedColumnIds: [...parsedAccount.value.columnOrder],
		account: parsedAccount.value,
		ownedColumns: exportedColumns.columns,
	};

	return c.json(payload, 200, { "Cache-Control": "private, no-store" });
});

/**
 * Import account data from self-serve export JSON
 */
app.post("/api/account/import", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const body = await validateJsonBody(c, accountImportBodySchema);
	if (!body.ok) return body.response;
	const accountId = auth.accountId;

	return withIdempotentWrite(
		c,
		{ scope: `account:${normalizeAccountId(accountId)}:import`, accountId },
		async () => {
			const normalizedId = normalizeAccountId(accountId);
			const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);
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
					ownerId: accountId,
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
 * Get column metadata
 */
app.get("/api/column/:id", async (c) => {
	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const columnId = path.data.id;
	const accountId = auth.accountId;

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

	if (!hasColumnAccess(meta, accountId)) {
		return apiErrorResponse("access_revoked", "Access denied", 403);
	}

	return c.json({ column: meta });
});

/**
 * WebSocket connection for column sync
 */
app.post("/api/column/:id/ws-ticket", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const auth = await requireAccountCredential(c.req.raw, c.env);
	if (!auth.ok) return auth.response;
	const columnId = path.data.id;
	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
	return stub.fetch("http://do/ws-ticket", {
		method: "POST",
		headers: { "X-Authenticated-Account-ID": auth.accountId },
	});
});

app.get("/api/column/:id/ws", async (c) => {
	const readOnlyResponse = blockWritesIfReadOnly(c);
	if (readOnlyResponse) return readOnlyResponse;

	const path = validateRequestInput(c, columnPathSchema, { id: c.req.param("id") });
	if (!path.ok) return path.response;
	const ticket = c.req.query("ticket");
	if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
		return apiErrorResponse("access_revoked", "Invalid WebSocket ticket", 403);
	}
	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(path.data.id));

	// Important: forward the original upgrade request as-is.
	// Rewriting/cloning upgrade requests can break WebSocket upgrades in local dev.
	return stub.fetch(c.req.raw);
});

// ============================================
// Sharing Routes
// ============================================

// ============================================
// Public Link Routes
// ============================================

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
			c.env.RATE_LIMIT_COORDINATOR,
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

	const columnId = await resolvePublicId(c.env, publicId);
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

	const columnId = await resolvePublicId(c.env, publicId);
	if (!columnId) {
		return c.json({ error: "Public link not found" }, 404);
	}

	const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));

	// Forward the original upgrade request as-is so the DO can route by pathname.
	return stub.fetch(c.req.raw);
});

app.get("/api/admin/backups/status", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const state = await c.env.BACKUPS!.get("backup-state.json");
	return c.json({ automaticBackupsEnabled: isAutoBackupEnabled(c.env), lastRun: state ? await state.json() : null });
});

// Private export endpoints let an independent machine retain verified copies
// without relying on continued access to the Cloudflare account.
app.get("/api/admin/backups/objects", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const page = await c.env.BACKUPS!.list({ limit: 1000, cursor: c.req.query("cursor") });
	return c.json({ objects: page.objects.map(object => ({ key: object.key, size: object.size })), truncated: page.truncated, cursor: page.truncated ? page.cursor : null }, 200, { "Cache-Control": "private, no-store" });
});
app.get("/api/admin/backups/download", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const key = c.req.query("key");
	if (!key) return c.json({ error: "missing_key" }, 400);
	const object = await c.env.BACKUPS!.get(key);
	if (!object) return c.json({ error: "not_found" }, 404);
	return new Response(object.body, { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
});

// Authenticated manual execution provides a verifiable first backup immediately
// after a release. It copies data only; scheduled maintenance remains frozen.
app.post("/api/admin/backups/run", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	return c.json(await runScheduledBackups(c.env));
});

app.post("/api/admin/backups/account", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	const body = await validateJsonBody(c, accountAdminBodySchema);
	if (!body.ok) return body.response;
	const accountId = normalizeAccountId(body.data.accountId);
	const inventory = await collectBackupInventory(c.env);
	const record = await accountRecordStore(c.env).get(`account:${accountId}`);
	if (!record) return c.json({ error: "account_not_found" }, 404);
	const parsed = parseAccountRecord(record);
	const trash = parseDeletedColumnRecords(await accountRecordStore(c.env).get(`trash:${accountId}`));
	if (!parsed.ok || !trash.ok) return c.json({ error: "account_invalid" }, 400);
	for (const columnId of new Set([...parsed.value.columnOrder, ...trash.value.map(row => row.columnId), ...(inventory.columnsByOwner.get(accountId) ?? [])])) {
		const column = await createColumnBackupSnapshot(c.env, columnId);
		if (column.checksum === "raw-recovery-source") return c.json({ error: "column_corrupt", columnId }, 503);
	}
	const snapshot = await createAccountBackup(c.env, accountId, inventory.columnsByOwner.get(accountId));
	if (!snapshot) return c.json({ error: "account_not_found" }, 404);
	return c.json({ success: true, key: snapshot.key, columnIds: snapshot.payload.columnIds });
});

/**
 * Restore all owned columns for an account from latest backups
 */
app.post("/api/admin/backups/account/restore", async (c) => {
	const authError = requireBackupAdmin(c);
	if (authError) return authError;
	if (!isReadOnlyMode(c.env)) return c.json({ error: "maintenance_mode_required" }, 409);
	const body = await validateJsonBody(c, accountAdminBodySchema);
	if (!body.ok) return body.response;
	const accountId = body.data.accountId;

	const normalizedId = normalizeAccountId(accountId);
	try {
		const backup = await readAccountBackup(c.env, normalizedId, body.data.key);
		if (backup) return c.json(await restoreAccountBackup(c.env, backup,
			columnId => createPreRestoreColumnBackup(c.env, columnId)));
	} catch (error) {
		return c.json({ error: "account_recovery_failed", detail: error instanceof Error ? error.message : "unknown" }, 500);
	}
	const accountData = await accountRecordStore(c.env).get(`account:${normalizedId}`);
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
	const failures: Array<{ columnId: string; key: string; code: string }> = [];

	for (const columnId of account.columnOrder) {
		let latestKey = "";
		try {
			latestKey = (await latestColumnBackupKey(c.env.BACKUPS!, columnId)) ?? "";

			if (!latestKey) {
				missingBackups.push(columnId);
				continue;
			}

			const object = await c.env.BACKUPS!.get(latestKey);
			if (!object) {
				missingBackups.push(columnId);
				continue;
			}

			const parsed = await readAndVerifyColumnBackup(object, columnId);
			if (!parsed.ok) {
				failedColumns.push(columnId);
				failures.push({ columnId, key: latestKey, code: parsed.code });
				continue;
			}

			const restored = await restoreColumnFromBackupPayload(
				c.env,
				columnId,
				parsed.payload,
			);
			if (!restored.ok) {
				failedColumns.push(columnId);
				failures.push({ columnId, key: latestKey, code: restored.code });
				continue;
			}

			restoredColumns.push(columnId);
			restoredMetas.push(restored.meta);
		} catch (error) {
			console.error("Account backup restore failed for column", { columnId, error });
			failedColumns.push(columnId);
			failures.push({ columnId, key: latestKey, code: "backup_read_failed" });
		}
	}

	await rebuildSharedIndexesForColumns(c.env, restoredMetas);

	return c.json({
		success:
			failedColumns.length === 0 &&
			missingBackups.length === 0 &&
			restoredColumns.length === account.columnOrder.length,
		accountId: displayAccountId(accountId),
		restoredColumns,
		missingBackups,
		failedColumns,
		failures,
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
	const listed = await listColumnBackups(c.env.BACKUPS!, columnId);

	const objects = listed.slice(0, limit)
		.map((obj) => ({
			key: obj.key,
			size: obj.size,
			uploaded: obj.uploaded.toISOString(),
		}))
		.sort((a, b) => b.key.localeCompare(a.key));

	return c.json({
		columnId,
		objects,
		truncated: listed.length > limit,
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
	if (mode === "in_place" && !isReadOnlyMode(c.env)) return c.json({ error: "maintenance_mode_required" }, 409);

	let key = body.data.key;
	if (!key) {
		const latest = await latestColumnBackupKey(c.env.BACKUPS!, columnId);
		if (!latest) {
			return c.json({ error: "backup_not_found" }, 404);
		}
		key = latest;
	}

	const object = await c.env.BACKUPS!.get(key);
	if (!object) {
		return c.json({ error: "backup_not_found" }, 404);
	}

	const verified = await readAndVerifyColumnBackup(object, columnId);
	if (!verified.ok) {
		return c.json({ error: verified.code }, 400);
	}
	const parsed = verified.payload;

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
			return c.json(
				{ error: cloned.code },
				cloned.code === "invalid_yjs_update" ? 422 : 500,
			);
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
		createPreRestoreBackup: () => createPreRestoreColumnBackup(c.env, columnId),
	});
	if (!restored.ok) {
		const status =
			restored.code === "backup_checksum_mismatch" ||
				restored.code === "invalid_backup_payload" ||
				restored.code === "column_meta_invalid"
					? 400
					: restored.code === "invalid_yjs_update"
						? 422
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
	return c.json(
		{
			time: new Date().toLocaleTimeString(),
			readOnlyMode: isReadOnlyMode(c.env),
			autoBackupEnabled: isAutoBackupEnabled(c.env),
		},
		200,
		{ "Cache-Control": "no-store" },
	);
});

export default {
	fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, env, ctx),
	scheduled: async (
		controller: ScheduledController,
		env: Bindings,
		executionCtx: ExecutionContext,
	) => {
			executionCtx.waitUntil(
			(async () => {
				// Emergency read-only mode freezes scheduled maintenance as well as
				// user writes. Backups remain available while incidents are investigated.
				if (isReadOnlyMode(env)) return;
				await cleanupAbandonedProvisionalUsers(env);
				const reconciliationResult = await reconcileColumnLifecycle(env);
				env.LIFECYCLE_METRICS?.writeDataPoint({
					indexes: ["scheduled-reconciliation"],
					blobs: [controller.cron],
					doubles: [
						reconciliationResult.registryScanned,
						reconciliationResult.operationsRetried,
						reconciliationResult.operationsCompleted,
						reconciliationResult.operationsFailed,
						reconciliationResult.columnsInitialized,
						reconciliationResult.ownerMembershipRepaired,
						reconciliationResult.ownerMembershipRemoved,
						reconciliationResult.sharedMembershipRepaired,
						reconciliationResult.sharedMembershipRemoved,
						reconciliationResult.publicMappingsRepaired,
						reconciliationResult.publicMappingsRemoved,
						reconciliationResult.publicMappingConflicts,
						reconciliationResult.invalidRecords,
						reconciliationResult.trashRecordsInvalid,
					],
				});
				console.log(
					JSON.stringify({
						event: "scheduled_column_lifecycle_reconciliation",
						cron: controller.cron,
						...reconciliationResult,
					}),
				);
				const backupResult = isAutoBackupEnabled(env) ? await runScheduledBackups(env) : null;
				const purgeResult = await purgeExpiredTrashedColumns({
					env, beforeDelete: async (columnId) => { await createColumnBackupSnapshot(env, columnId); },
				});
				console.log(
					JSON.stringify({
						event: "scheduled_trash_purge_run",
						cron: controller.cron,
						...purgeResult,
					}),
				);

				if (!backupResult) return;
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
