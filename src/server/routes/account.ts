import { z } from "zod";
import type { Account, AccountExportPayload, ColumnMeta } from "../../types/account";
import {
	allocateGeneratedId,
	generateAccountId,
	normalizeAccountId,
	displayAccountId,
} from "../../lib/account";
import { hasColumnAccess } from "../../lib/column-access";
import { requireAccountCredential } from "../../lib/http-account-auth";
import {
	checkRateLimit,
	getClientIP,
	ipRateLimitKey,
	RATE_LIMITS,
} from "../../lib/rate-limit";
import { accountContractSchema, columnIdContractSchema, columnMetaContractSchema } from "../../lib/api/account-contract";
import { API_ROUTES } from "../../lib/api/routes";
import {
	ACCOUNT_SCHEMA_VERSION,
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
	TRASH_RETENTION_MS,
} from "../persistence-records";
import { mapWithConcurrency } from "../bounded-concurrency";
import { cloneColumnSnapshot } from "../workflows/clone-column-snapshot";
import { exportAccountColumns } from "../workflows/export-account-columns";
import { yjsBytesSchema } from "../column-backup-payload";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import { isReadOnlyMode } from "../read-only-mode";
import { apiErrorResponse, isDurableObjectDurationError, schemaErrorResponse } from "../http/responses";
import { validateJsonBody } from "../http/request-validation";
import { withIdempotentWrite } from "../http/idempotency";
import { blockWritesIfReadOnly, shouldSkipRateLimit } from "../http/guards";
import type { App } from "../bindings";

declare const __TODOFLARE_E2E__: boolean;

export const ACCOUNT_METADATA_CONCURRENCY = 6;

export type ColumnMetadataFetchResult =
	| { columnId: string; response: Response }
	| { columnId: string; error: unknown };

export async function fetchColumnMetadataBatch(
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

export const accountExportColumnInputSchema = z
	.object({
		meta: columnMetaContractSchema,
		yjs: yjsBytesSchema,
	})
	.strict();

export function validateAccountImportCompleteness(
	payload: {
		account: z.output<typeof accountContractSchema>;
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

export const accountImportV1BodySchema = z
	.object({
		schemaVersion: z.literal(1),
		exportedAt: z.number().finite().nonnegative(),
		account: accountContractSchema,
		ownedColumns: z.array(accountExportColumnInputSchema).max(100),
	})
	.strict()
	.superRefine(validateAccountImportCompleteness);

export const accountImportV2BodySchema = z
	.object({
		schemaVersion: z.literal(2),
		exportedAt: z.number().finite().nonnegative(),
		complete: z.literal(true),
		expectedColumnIds: z.array(columnIdContractSchema).max(100),
		account: accountContractSchema,
		ownedColumns: z.array(accountExportColumnInputSchema).max(100),
	})
	.strict()
	.superRefine(validateAccountImportCompleteness);

export const accountImportBodySchema = z.union([
	accountImportV1BodySchema,
	accountImportV2BodySchema,
]);

export function registerAccountRoutes(app: App) {
	/**
	 * Create a new account
	 * Rate limited: 5 per IP per hour
	 */
	app.on(API_ROUTES.createAccount.method, API_ROUTES.createAccount.path, async (c) => {
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
	app.on(API_ROUTES.getAccount.method, API_ROUTES.getAccount.path, async (c) => {
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
	 * Export account-owned columns as JSON (self-serve)
	 */
	app.on(API_ROUTES.exportAccount.method, API_ROUTES.exportAccount.path, async (c) => {
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
	app.on(API_ROUTES.importAccount.method, API_ROUTES.importAccount.path, async (c) => {
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
}
