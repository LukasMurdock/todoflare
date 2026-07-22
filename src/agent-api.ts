import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as Y from "yjs";
import type { Account, ColumnMeta } from "./types/account";
import { checkRateLimit, getClientIP, ipRateLimitKey, RATE_LIMITS } from "./lib/rate-limit";
import { normalizeAccountId } from "./lib/account";
import { hasColumnAccess, isColumnOwner } from "./lib/column-access";
import { requireAccountCredential } from "./lib/http-account-auth";
import {
	parseAccountRecord,
	columnMetaRecordSchema,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
	TRASH_RETENTION_MS,
} from "./server/persistence-records";
import { accountRecordStore, mutateAccountRecord } from "./server/account-record-store";

type Bindings = {
	ACCOUNTS: KVNamespace;
	IDEMPOTENCY_COORDINATOR: DurableObjectNamespace;
	RATE_LIMIT_COORDINATOR: DurableObjectNamespace;
	COLUMN_ROOM: DurableObjectNamespace;
	ACCOUNT_COORDINATOR: DurableObjectNamespace;
	PUBLIC_ID_COORDINATOR: DurableObjectNamespace;
};

const columnIdPathSchema = z.object({
	columnId: z
		.string()
		.uuid()
		.openapi({
			param: {
				name: "columnId",
				in: "path",
			},
			example: "6e97b2fe-f33f-4f72-b12e-e8c354e1732d",
		}),
});

const accountHeaderSchema = z.object({
	authorization: z
		.string()
		.regex(/^Bearer \d{16}$/, "Invalid bearer credential")
		.openapi({
			example: "Bearer 4829104738562019",
		}),
});

const errorSchema = z.object({
	error: z.string(),
});

const agentColumnMetaSchema = columnMetaRecordSchema;

const agentColumnListItemSchema = z.object({
	id: z.string(),
	source: z.enum(["owned", "shared"]),
	visibility: z.enum(["visible", "hidden"]),
	state: z.enum(["active", "deleted"]),
	deletedAt: z.number().nullable(),
	meta: agentColumnMetaSchema.nullable(),
});

const listColumnsResponseSchema = z.object({
	accountId: z.string(),
	columns: z.array(agentColumnListItemSchema),
});

const capabilitiesSchema = z.object({
	canRead: z.boolean(),
	canEdit: z.boolean(),
	isOwner: z.boolean(),
	isShared: z.boolean(),
	isPublic: z.boolean(),
});

const columnDetailResponseSchema = z.object({
	columnId: z.string(),
	meta: agentColumnMetaSchema,
	capabilities: capabilitiesSchema,
	visibility: z.enum(["visible", "hidden"]),
	state: z.enum(["active", "deleted"]),
	deletedAt: z.number().nullable(),
});

const snapshotResponseSchema = z.object({
	columnId: z.string(),
	meta: agentColumnMetaSchema,
	capabilities: capabilitiesSchema,
	visibility: z.enum(["visible", "hidden"]),
	state: z.enum(["active", "deleted"]),
	deletedAt: z.number().nullable(),
	yjs: z.array(z.number()).nullable(),
	markdown: z.string().nullable(),
	markdownError: z.string().optional(),
});

function shouldApplyAgentRateLimit(url: string): boolean {
	const hostname = new URL(url).hostname;
	if (hostname === "localhost" || hostname === "127.0.0.1") return false;
	if (hostname === "example.com") return false;
	return true;
}

async function enforceAgentRateLimit(
	c: { env: Bindings; req: { raw: Request } },
	keySuffix: string,
): Promise<{ retryAfter: number } | null> {
	if (!shouldApplyAgentRateLimit(c.req.raw.url)) return null;

	const ip = getClientIP(c.req.raw);
	const rateLimit = await checkRateLimit(
		c.env.RATE_LIMIT_COORDINATOR,
		ipRateLimitKey(keySuffix, ip),
		RATE_LIMITS.accountLookup,
	);

	if (rateLimit.allowed) return null;

	return { retryAfter: rateLimit.retryAfter ?? 1 };
}

async function fetchAccount(
	env: Bindings,
	accountId: string,
): Promise<
	| { ok: true; account: Account; normalizedId: string }
	| { ok: false; status: 404 | 503; error: string }
> {
	const normalizedId = normalizeAccountId(accountId);
	const accountData = await accountRecordStore(env).get(`account:${normalizedId}`);

	if (!accountData) {
		return { ok: false, status: 404, error: "Account not found" };
	}

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return { ok: false, status: 503, error: "Account record is invalid" };
	}

	return { ok: true, account: parsedAccount.value, normalizedId };
}

function buildCapabilities(meta: ColumnMeta, accountId: string) {
	const owner = isColumnOwner(meta, accountId);
	const isShared = !owner && hasColumnAccess(meta, accountId);

	return {
		canRead: owner || isShared,
		canEdit: owner || isShared,
		isOwner: owner,
		isShared,
		isPublic: meta.publicId !== null,
	};
}

function getColumnState(
	columnId: string,
	deletedMap: Map<string, number>,
): { state: "active" | "deleted"; deletedAt: number | null } {
	const deletedAt = deletedMap.get(columnId);
	if (typeof deletedAt === "number") {
		return { state: "deleted", deletedAt };
	}
	return { state: "active", deletedAt: null };
}

function toUtf8Message(err: unknown): string {
	if (err instanceof Error) return err.message;
	return "Failed to serialize markdown";
}

function serializeYjsSnapshotToMarkdown(yjs: number[] | null): {
	markdown: string | null;
	markdownError?: string;
} {
	try {
		const doc = new Y.Doc();
		if (yjs && yjs.length > 0) {
			Y.applyUpdate(doc, new Uint8Array(yjs));
		}

		const yContent = doc.get("content", Y.XmlText) as Y.XmlText;
		const markdown = yContent.toString();
		return { markdown };
	} catch (err) {
		return {
			markdown: null,
			markdownError: toUtf8Message(err),
		};
	}
}

export function registerAgentApi(app: OpenAPIHono<{ Bindings: Bindings }>) {
	const listColumnsRoute = createRoute({
		method: "get",
		path: "/api/agent/v1/account/columns",
		request: {
			headers: accountHeaderSchema,
		},
		responses: {
			200: {
				description: "List account columns for agent discovery",
				content: {
					"application/json": {
						schema: listColumnsResponseSchema,
					},
				},
			},
			400: { description: "Invalid account id", content: { "application/json": { schema: errorSchema } } },
			403: { description: "Access denied", content: { "application/json": { schema: errorSchema } } },
			404: { description: "Account not found", content: { "application/json": { schema: errorSchema } } },
			503: { description: "Schema invalid", content: { "application/json": { schema: errorSchema } } },
			429: { description: "Rate limited", content: { "application/json": { schema: errorSchema.extend({ retryAfter: z.number() }) } } },
		},
		tags: ["agent-read"],
		operationId: "listAgentColumns",
	});

	app.openapi(listColumnsRoute, async (c) => {
		const rateLimited = await enforceAgentRateLimit(c, "agent-list-columns");
		if (rateLimited) {
			return c.json({ error: "rate_limited", retryAfter: rateLimited.retryAfter }, 429);
		}

		const auth = requireAccountCredential(c.req.raw);
		if (!auth.ok) return c.json({ error: "Unauthorized" }, 403);
		const accountId = auth.accountId;

		const fetched = await fetchAccount(c.env, accountId);
		if (!fetched.ok) {
			return fetched.status === 404
				? c.json({ error: fetched.error }, 404)
				: c.json({ error: fetched.error }, 503);
		}

		const { account, normalizedId } = fetched;

		const sharedColumnsData = await accountRecordStore(c.env).get(`shared:${normalizedId}`);
		const parsedSharedColumnIds = parseSharedColumnIndex(sharedColumnsData);
		if (!parsedSharedColumnIds.ok) {
			return c.json({ error: "Shared column index is invalid" }, 503);
		}
		const sharedColumnIds = parsedSharedColumnIds.value;

		const sharedMetas: ColumnMeta[] = [];
		for (const columnId of sharedColumnIds) {
			const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
			const response = await stub.fetch(new Request("http://do/meta"));
			if (!response.ok) continue;
			const parsedMeta = parseColumnMetaRecord(await response.json());
			if (parsedMeta.ok) sharedMetas.push(parsedMeta.value);
		}

		const now = Date.now();
		const trashKey = `trash:${normalizedId}`;
		const deletedColumnsRaw = await accountRecordStore(c.env).get(trashKey);
		const deletedColumns = parseDeletedColumnRecords(deletedColumnsRaw)
			.filter((entry) => now - entry.deletedAt < TRASH_RETENTION_MS)
			.sort((a, b) => b.deletedAt - a.deletedAt);

		const originalDeleted = parseDeletedColumnRecords(deletedColumnsRaw);
		if (deletedColumns.length !== originalDeleted.length) {
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

		const hiddenSet = new Set(account.hiddenSharedColumns);
		const deletedMap = new Map<string, number>();
		for (const entry of deletedColumns) {
			deletedMap.set(entry.columnId, entry.deletedAt);
		}

		const columns: z.infer<typeof agentColumnListItemSchema>[] = [];

		for (const columnId of account.columnOrder) {
			const state = getColumnState(columnId, deletedMap);
			columns.push({
				id: columnId,
				source: "owned",
				visibility: "visible",
				state: state.state,
				deletedAt: state.deletedAt,
				meta: null,
			});
		}

		for (const sharedMeta of sharedMetas) {
			columns.push({
				id: sharedMeta.id,
				source: "shared",
				visibility: hiddenSet.has(sharedMeta.id) ? "hidden" : "visible",
				state: "active",
				deletedAt: null,
				meta: sharedMeta,
			});
		}

		for (const deleted of deletedColumns) {
			if (account.columnOrder.includes(deleted.columnId)) continue;
			columns.push({
				id: deleted.columnId,
				source: "owned",
				visibility: "hidden",
				state: "deleted",
				deletedAt: deleted.deletedAt,
				meta: null,
			});
		}

		return c.json({
			accountId: account.id,
			columns,
		}, 200);
	});

	const getColumnRoute = createRoute({
		method: "get",
		path: "/api/agent/v1/columns/{columnId}",
		request: {
			params: columnIdPathSchema,
			headers: accountHeaderSchema,
		},
		responses: {
			200: {
				description: "Get agent-focused metadata and capabilities for a column",
				content: {
					"application/json": {
						schema: columnDetailResponseSchema,
					},
				},
			},
			400: { description: "Invalid account id", content: { "application/json": { schema: errorSchema } } },
			403: { description: "Access denied", content: { "application/json": { schema: errorSchema } } },
			404: { description: "Not found", content: { "application/json": { schema: errorSchema } } },
			503: { description: "Schema invalid", content: { "application/json": { schema: errorSchema } } },
			429: { description: "Rate limited", content: { "application/json": { schema: errorSchema.extend({ retryAfter: z.number() }) } } },
		},
		tags: ["agent-read"],
		operationId: "getAgentColumn",
	});

	app.openapi(getColumnRoute, async (c) => {
		const rateLimited = await enforceAgentRateLimit(c, "agent-get-column");
		if (rateLimited) {
			return c.json({ error: "rate_limited", retryAfter: rateLimited.retryAfter }, 429);
		}

		const { columnId } = c.req.valid("param");
		const auth = requireAccountCredential(c.req.raw);
		if (!auth.ok) return c.json({ error: "Unauthorized" }, 403);
		const requesterAccountId = auth.accountId;

		const fetched = await fetchAccount(c.env, requesterAccountId);
		if (!fetched.ok) {
			return fetched.status === 404
				? c.json({ error: fetched.error }, 404)
				: c.json({ error: fetched.error }, 503);
		}

		const { account, normalizedId } = fetched;

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
		const metaResponse = await stub.fetch(new Request("http://do/meta"));
		if (!metaResponse.ok) {
			return c.json({ error: "Column not found" }, 404);
		}

		const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
		if (!parsedMeta.ok) {
			return c.json({ error: "Column metadata is invalid" }, 503);
		}
		const meta = parsedMeta.value;

		const capabilities = buildCapabilities(meta, account.id);
		if (!capabilities.canRead) {
			return c.json({ error: "Access denied" }, 403);
		}

		const hiddenSet = new Set(account.hiddenSharedColumns);
		const trashRaw = await accountRecordStore(c.env).get(`trash:${normalizedId}`);
		const deletedMap = new Map<string, number>();
		for (const entry of parseDeletedColumnRecords(trashRaw)) {
			if (Date.now() - entry.deletedAt < TRASH_RETENTION_MS) {
				deletedMap.set(entry.columnId, entry.deletedAt);
			}
		}

		const state = getColumnState(columnId, deletedMap);
		const visibility: "visible" | "hidden" = capabilities.isShared
			? hiddenSet.has(columnId)
				? "hidden"
				: "visible"
			: "visible";

		return c.json({
			columnId,
			meta,
			capabilities,
			visibility,
			state: state.state,
			deletedAt: state.deletedAt,
		}, 200);
	});

	const getSnapshotRoute = createRoute({
		method: "get",
		path: "/api/agent/v1/columns/{columnId}/snapshot",
		request: {
			params: columnIdPathSchema,
			headers: accountHeaderSchema,
		},
		responses: {
			200: {
				description: "Get canonical Yjs snapshot and markdown projection",
				content: {
					"application/json": {
						schema: snapshotResponseSchema,
					},
				},
			},
			400: { description: "Invalid account id", content: { "application/json": { schema: errorSchema } } },
			403: { description: "Access denied", content: { "application/json": { schema: errorSchema } } },
			404: { description: "Not found", content: { "application/json": { schema: errorSchema } } },
			503: { description: "Schema invalid", content: { "application/json": { schema: errorSchema } } },
			429: { description: "Rate limited", content: { "application/json": { schema: errorSchema.extend({ retryAfter: z.number() }) } } },
		},
		tags: ["agent-read"],
		operationId: "getAgentColumnSnapshot",
	});

	app.openapi(getSnapshotRoute, async (c) => {
		const rateLimited = await enforceAgentRateLimit(c, "agent-get-snapshot");
		if (rateLimited) {
			return c.json({ error: "rate_limited", retryAfter: rateLimited.retryAfter }, 429);
		}

		const { columnId } = c.req.valid("param");
		const auth = requireAccountCredential(c.req.raw);
		if (!auth.ok) return c.json({ error: "Unauthorized" }, 403);
		const requesterAccountId = auth.accountId;

		const fetched = await fetchAccount(c.env, requesterAccountId);
		if (!fetched.ok) {
			return fetched.status === 404
				? c.json({ error: fetched.error }, 404)
				: c.json({ error: fetched.error }, 503);
		}
		const { account, normalizedId } = fetched;

		const stub = c.env.COLUMN_ROOM.get(c.env.COLUMN_ROOM.idFromName(columnId));
		const exportResponse = await stub.fetch(new Request("http://do/export"));
		if (!exportResponse.ok) {
			return c.json({ error: "Column not found" }, 404);
		}

		const exported = (await exportResponse.json()) as {
			meta: unknown;
			yjs: number[] | null;
		};
		const parsedMeta = parseColumnMetaRecord(exported.meta);
		if (!parsedMeta.ok) {
			return c.json({ error: "Column metadata is invalid" }, 503);
		}
		const meta = parsedMeta.value;

		const capabilities = buildCapabilities(meta, account.id);
		if (!capabilities.canRead) {
			return c.json({ error: "Access denied" }, 403);
		}

		const hiddenSet = new Set(account.hiddenSharedColumns);
		const trashRaw = await accountRecordStore(c.env).get(`trash:${normalizedId}`);
		const deletedMap = new Map<string, number>();
		for (const entry of parseDeletedColumnRecords(trashRaw)) {
			if (Date.now() - entry.deletedAt < TRASH_RETENTION_MS) {
				deletedMap.set(entry.columnId, entry.deletedAt);
			}
		}

		const state = getColumnState(columnId, deletedMap);
		const visibility: "visible" | "hidden" = capabilities.isShared
			? hiddenSet.has(columnId)
				? "hidden"
				: "visible"
			: "visible";

		const markdownPayload = serializeYjsSnapshotToMarkdown(exported.yjs);

		return c.json({
			columnId,
			meta,
			capabilities,
			visibility,
			state: state.state,
			deletedAt: state.deletedAt,
			yjs: exported.yjs,
			markdown: markdownPayload.markdown,
			...(markdownPayload.markdownError
				? { markdownError: markdownPayload.markdownError }
				: {}),
		}, 200);
	});
}
