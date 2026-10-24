import { getRequestSession } from "../session";
import { isRecentSession, userVerified } from "../passkey-policy";
import { normalizeAccountId, validateAccountId } from "../../lib/account";
import { API_ROUTES, AUTH_BASE_PATH } from "../../lib/api/routes";
import { accountRecordStore } from "../account-record-store";
import { isReadOnlyMode, readOnlyModeResponse } from "../read-only-mode";
import { createAuth, sanitizedAuthResponse } from "../auth";
import type { App, AppContext } from "../bindings";

// Authentication remains available to validate recovery, while credential changes
// must not race with a frozen account restore. Unknown auth routes fail closed.
export const frozenAuthRoutes = new Set([
	"GET /api/auth/get-session",
	"GET /api/auth/passkey/list-user-passkeys",
	"GET /api/auth/passkey/generate-authenticate-options",
	"POST /api/auth/passkey/verify-authentication",
	"POST /api/auth/sign-out",
]);

const passkeyPath = (name: string) => `${AUTH_BASE_PATH}/passkey/${name}`;
const RECOVERY_CODE_GENERATE = `${AUTH_BASE_PATH}/recovery-code/generate`;

function recentAuthenticationRequired(c: AppContext) {
	return c.json({
		error: "recent_authentication_required",
		message: "Confirm it's you with a passkey, then try again",
	}, 401);
}

async function credentialCounts(c: AppContext, userId: string) {
	return await c.env.AUTH_DB.prepare(
		`SELECT
		   (SELECT COUNT(*) FROM "passkey" WHERE "userId" = ?1) AS passkeys,
		   (SELECT "recoveryCodeHash" IS NOT NULL FROM "user" WHERE "id" = ?1) AS recoveryCode`,
	)
		.bind(userId)
		.first<{ passkeys: number; recoveryCode: number | null }>();
}

// Requests that need a recent sign-in. verify-registration is not listed: it
// needs the single-use, short-lived challenge that generate-register-options
// issues, so gating the challenge gates it without failing a slow ceremony.
const RECENT_SIGN_IN_PATHS = new Set([
	passkeyPath("generate-register-options"),
	passkeyPath("delete-passkey"),
	RECOVERY_CODE_GENERATE,
	// Better Auth's own freshness check is off (auth.ts); keep it for the
	// other endpoints that had it. list-sessions returns every session token.
	`${AUTH_BASE_PATH}/unlink-account`,
	`${AUTH_BASE_PATH}/list-sessions`,
]);

// Changes bound to the account the client shows, when it says which one. A
// change queued for one account must not land on another a second tab
// signed in meanwhile.
const EXPECTED_ACCOUNT_PATHS = new Set([
	...RECENT_SIGN_IN_PATHS,
	passkeyPath("verify-registration"),
	passkeyPath("update-passkey"),
	`${AUTH_BASE_PATH}/revoke-other-sessions`,
]);

/**
 * Credential changes outlive the session that made them, so a stolen or stale
 * session must not add a passkey or mint a recovery code. Each change needs a
 * recent sign-in, except the first passkey of an account that has none.
 * Returns a response when the request is refused.
 */
async function credentialChangePolicy(c: AppContext, pathname: string): Promise<Response | null> {
	if (!EXPECTED_ACCOUNT_PATHS.has(pathname)) return null;
	const session = await getRequestSession(c.req.raw, c.env);
	if (!session) return c.json({ error: "unauthorized", message: "Sign in first" }, 401);
	const expected = c.req.header("X-Todoflare-Expected-Account");
	if (expected !== undefined && (!validateAccountId(expected) || normalizeAccountId(expected) !== normalizeAccountId(session.user.id))) {
		return c.json({
			error: "account_mismatch",
			message: "Another account signed in on this device. Reload to continue.",
		}, 401);
	}
	if (!RECENT_SIGN_IN_PATHS.has(pathname)) return null;
	const counts = await credentialCounts(c, session.user.id);
	const passkeys = counts?.passkeys ?? 0;
	const firstEnrollment = pathname === passkeyPath("generate-register-options") && passkeys === 0 && !counts?.recoveryCode;
	if (!firstEnrollment && !isRecentSession(session.session.createdAt)) {
		return recentAuthenticationRequired(c);
	}
	if (pathname === passkeyPath("delete-passkey") && passkeys <= 1 && !counts?.recoveryCode) {
		return c.json({
			error: "last_recovery_method",
			message: "Add another passkey or a recovery code before removing this one",
		}, 409);
	}
	return null;
}

async function userVerificationPolicy(request: Request, pathname: string): Promise<Response | null> {
	const ceremony =
		pathname === passkeyPath("verify-registration") ? "registration"
		: pathname === passkeyPath("verify-authentication") ? "authentication"
		: null;
	if (!ceremony) return null;
	const body = await request.clone().json().catch(() => null);
	if (userVerified(ceremony, body)) return null;
	return Response.json({
		error: "user_verification_required",
		message: "Your passkey must confirm it's you with a PIN, fingerprint or face",
	}, { status: 400 });
}

/** Ask authenticators for the verification the server will require. */
async function requireUserVerificationOption(response: Response): Promise<Response> {
	if (!response.ok) return response;
	const options = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
	if (!options || typeof options !== "object") return response;
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	return Response.json({ ...options, userVerification: "required" }, { status: response.status, headers });
}

export function registerAuthRoutes(app: App) {
	app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
		const pathname = new URL(c.req.url).pathname;
		if (isReadOnlyMode(c.env) && !frozenAuthRoutes.has(`${c.req.method} ${pathname}`)) {
			return readOnlyModeResponse();
		}
		const refused =
			(await credentialChangePolicy(c, pathname)) ??
			(await userVerificationPolicy(c.req.raw, pathname));
		if (refused) return refused;
		const auth = createAuth(c.env, new URL(c.req.url).origin);
		let response = await auth.handler(c.req.raw);
		if (pathname === passkeyPath("generate-authenticate-options")) {
			response = await requireUserVerificationOption(response);
		}
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
