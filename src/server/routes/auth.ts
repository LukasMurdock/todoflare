import { getRequestSession } from "../session";
import { normalizeAccountId, validateAccountId } from "../../lib/account";
import { API_ROUTES, AUTH_BASE_PATH } from "../../lib/api/routes";
import { accountRecordStore } from "../account-record-store";
import { isReadOnlyMode, readOnlyModeResponse } from "../read-only-mode";
import { createAuth, sanitizedAuthResponse } from "../auth";
import type { App } from "../bindings";

// Authentication remains available to validate recovery, while credential changes
// must not race with a frozen account restore. Unknown auth routes fail closed.
export const frozenAuthRoutes = new Set([
	"GET /api/auth/get-session",
	"GET /api/auth/passkey/list-user-passkeys",
	"GET /api/auth/passkey/generate-authenticate-options",
	"POST /api/auth/passkey/verify-authentication",
	"POST /api/auth/sign-out",
]);

export function registerAuthRoutes(app: App) {
	app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
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
}

/** Registered after the cross-origin guard, unlike the better-auth handler. */
export function registerAuthStatusRoute(app: App) {
	app.on(API_ROUTES.authStatus.method, API_ROUTES.authStatus.path, async (c) => {
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
}
