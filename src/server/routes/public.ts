import { checkRateLimit, resourceRateLimitKey, RATE_LIMITS } from "../../lib/rate-limit";
import { API_ROUTES } from "../../lib/api/routes";
import { parseColumnMetaRecord } from "../persistence-records";
import { resolvePublicId } from "../public-id-registry";
import { apiErrorResponse, schemaErrorResponse } from "../http/responses";
import { publicPathSchema, validateRequestInput } from "../http/request-validation";
import { shouldSkipRateLimit } from "../http/guards";
import type { App } from "../bindings";

export function registerPublicRoutes(app: App) {
	/**
	 * Get public column metadata
	 */
	app.on(API_ROUTES.publicColumn.method, API_ROUTES.publicColumn.path, async (c) => {
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
	app.on(API_ROUTES.publicColumnWs.method, API_ROUTES.publicColumnWs.path, async (c) => {
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
}
