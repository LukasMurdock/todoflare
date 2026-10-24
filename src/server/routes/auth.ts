import { getRequestSession } from "../session";
import { credentialInventory, isProvisional, serveAuthEndpoint } from "../auth-policy";
import { normalizeAccountId, validateAccountId } from "../../lib/account";
import { API_ROUTES, AUTH_BASE_PATH } from "../../lib/api/routes";
import { accountRecordStore } from "../account-record-store";
import { isReadOnlyMode } from "../read-only-mode";
import { createAuth, sanitizedAuthResponse } from "../auth";
import type { App } from "../bindings";

/** Serves better-auth under AUTH_BASE_PATH, by the policy in auth-policy.ts. */
export function registerAuthRoutes(app: App) {
	app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
		const url = new URL(c.req.url);
		return sanitizedAuthResponse(await serveAuthEndpoint({
			request: c.req.raw,
			path: url.pathname.slice(AUTH_BASE_PATH.length),
			db: c.env.AUTH_DB,
			frozen: isReadOnlyMode(c.env),
			session: () => getRequestSession(c.req.raw, c.env),
			handle: () => createAuth(c.env, url.origin).handler(c.req.raw),
		}));
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
		if (isProvisional(await credentialInventory(c.env.AUTH_DB, accountId))) {
			return c.json({ accountId, state: "provisional" as const });
		}
		const domainAccount = await accountRecordStore(c.env).get(`account:${accountId}`);
		return c.json({
			accountId,
			state: domainAccount ? ("passkey" as const) : ("provisioning" as const),
		});
	});
}
