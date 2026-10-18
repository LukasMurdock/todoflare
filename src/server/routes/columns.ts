import { hasColumnAccess } from "../../lib/column-access";
import { requireAccountCredential } from "../../lib/http-account-auth";
import { API_ROUTES } from "../../lib/api/routes";
import { parseColumnMetaRecord } from "../persistence-records";
import { apiErrorResponse, schemaErrorResponse } from "../http/responses";
import { columnPathSchema, validateRequestInput } from "../http/request-validation";
import { blockWritesIfReadOnly } from "../http/guards";
import type { App } from "../bindings";

export function registerColumnRoutes(app: App) {
	/**
	 * Get column metadata
	 */
	app.on(API_ROUTES.getColumn.method, API_ROUTES.getColumn.path, async (c) => {
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
	app.on(API_ROUTES.columnWsTicket.method, API_ROUTES.columnWsTicket.path, async (c) => {
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

	app.on(API_ROUTES.columnWs.method, API_ROUTES.columnWs.path, async (c) => {
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
}
