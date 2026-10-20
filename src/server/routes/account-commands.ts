import { type Context } from "hono";
import type { ColumnMeta } from "../../types/account";
import { normalizeAccountId, displayAccountId } from "../../lib/account";
import { requireAccountCredential } from "../../lib/http-account-auth";
import { ACCOUNT_COMMAND_TYPES, ACCOUNT_COMMANDS, type AccountCommandType } from "../../lib/api/account-commands";
import { publicPageUrl } from "../../lib/api/routes";
import { COLUMN_META_SCHEMA_VERSION, parseAccountRecord, parseColumnMetaRecord } from "../persistence-records";
import { deleteColumn } from "../workflows/delete-column";
import { restoreColumn } from "../workflows/restore-column";
import { shareColumn } from "../workflows/share-column";
import { enablePublicColumn } from "../workflows/enable-public-column";
import { revokeColumnShare } from "../workflows/revoke-column-share";
import { disablePublicColumn } from "../workflows/disable-public-column";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import {
	beginLifecycleOperation,
	completeLifecycleOperation,
	registerColumn,
	type LifecycleOperation,
} from "../lifecycle-journal";
import { type Bindings } from "../bindings";
import {
	apiErrorResponse,
	columnLifecycleFailureResponse,
	durableObjectUnavailableResponse,
	isDurableObjectDurationError,
	schemaErrorResponse,
} from "../http/responses";
import { columnPathSchema, validateJsonBody, validateRequestInput } from "../http/request-validation";
import { withIdempotentWrite } from "../http/idempotency";
import { blockWritesIfReadOnly } from "../http/guards";
import type { App } from "../bindings";

export async function runJournaledLifecycle<T extends { ok: boolean }>(
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

/**
 * Routes for offline-capable account commands. The method, path and body
 * contract come from ACCOUNT_COMMANDS; the mapped type makes a command without
 * a server handler a compile error. Every handler is safe to repeat, so each
 * is a rerunnable idempotent write (decision 0015).
 */
export const accountCommandHandlers: {
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				rerunnable: true,
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
				const publicUrl = publicPageUrl(url.origin, result.value.publicId);

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
				rerunnable: true,
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

export function registerAccountCommandRoutes(app: App) {
	for (const type of ACCOUNT_COMMAND_TYPES) {
		const { method, path } = ACCOUNT_COMMANDS[type];
		app.on(method, path, accountCommandHandlers[type]);
	}
}
