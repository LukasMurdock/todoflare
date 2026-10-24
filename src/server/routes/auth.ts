import { getRequestSession } from "../session";
import {
	authEndpointPolicy,
	authError,
	credentialInventory,
	enforceAuthPolicy,
	withRequestedUserVerification,
} from "../auth-policy";
import { normalizeAccountId, validateAccountId } from "../../lib/account";
import { API_ROUTES, AUTH_BASE_PATH } from "../../lib/api/routes";
import { accountRecordStore } from "../account-record-store";
import { isReadOnlyMode, readOnlyModeResponse } from "../read-only-mode";
import { createAuth, sanitizedAuthResponse } from "../auth";
import type { App } from "../bindings";

/**
 * Serves better-auth under AUTH_BASE_PATH through the policy in auth-policy.ts.
 * Unlisted endpoints answer 404, and while frozen, 503 unless the row allows
 * them: authentication stays available to validate recovery, but credential
 * changes must not race with a frozen account restore.
 */
export function registerAuthRoutes(app: App) {
	app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
		const url = new URL(c.req.url);
		const policy = authEndpointPolicy(c.req.method, url.pathname.slice(AUTH_BASE_PATH.length));
		if (isReadOnlyMode(c.env) && !policy?.whileFrozen) return readOnlyModeResponse();
		if (!policy) return authError("not_found", 404, "Not found");
		const refused = await enforceAuthPolicy(c.req.raw, c.env.AUTH_DB, policy, () =>
			getRequestSession(c.req.raw, c.env),
		);
		if (refused) return refused;
		const response = await createAuth(c.env, url.origin).handler(c.req.raw);
		return sanitizedAuthResponse(
			policy.requestsUserVerification ? await withRequestedUserVerification(response) : response,
		);
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
		if ((await credentialInventory(c.env.AUTH_DB, accountId)).passkeys === 0) {
			return c.json({ accountId, state: "provisional" as const });
		}
		const domainAccount = await accountRecordStore(c.env).get(`account:${accountId}`);
		return c.json({
			accountId,
			state: domainAccount ? ("passkey" as const) : ("provisioning" as const),
		});
	});
}
