import { normalizeAccountId, validateAccountId } from "./account";
import type { AuthBindings } from "../server/auth";
import { getRequestSession } from "../server/session";
import { credentialInventory, isProvisional, isRecentSession, recentSignInRequired } from "../server/auth-policy";
import { namesAnotherAccount } from "./account-request-headers";

export type AccountCredentialResult =
	| { ok: true; accountId: string }
	| { ok: false; response: Response };

function unauthorized(): AccountCredentialResult {
	return {
		ok: false,
		response: Response.json(
			{ error: "unauthorized", code: "unauthorized" },
			{ status: 401, headers: { "Cache-Control": "private, no-store" } },
		),
	};
}

/** The Vitest and E2E-build fixture: an Account ID header stands in for a session. */
function usesTestFixture(request: Request, env: { AUTH_TEST_BYPASS?: string }): boolean {
	const compiledE2E =
		typeof __TODOFLARE_E2E__ !== "undefined" && __TODOFLARE_E2E__;
	if (!(env.AUTH_TEST_BYPASS === "true" || compiledE2E)) return false;
	if (request.headers.get("X-Test-Disable-Auth-Bypass") === "1") return false;
	const credential = request.headers.get("X-Todoflare-Test-Account");
	return credential !== null && validateAccountId(credential);
}

/** Resolve a permanent account exclusively from a Better Auth session cookie. */
export async function requireAccountCredential(
	request: Request,
	env: AuthBindings & { AUTH_TEST_BYPASS?: string },
): Promise<AccountCredentialResult> {
	if (usesTestFixture(request, env)) {
		return { ok: true, accountId: normalizeAccountId(request.headers.get("X-Todoflare-Test-Account")!) };
	}
	const session = await getRequestSession(request, env);
	if (!session || !validateAccountId(session.user.id)) {
		return unauthorized();
	}

	if (namesAnotherAccount(request.headers, session.user.id)) return unauthorized();

	if (isProvisional(await credentialInventory(env.AUTH_DB, session.user.id))) return unauthorized();

	return { ok: true, accountId: normalizeAccountId(session.user.id) };
}

/**
 * Refuses a change that hands out a credential outliving the session (an
 * agent connection or a wider grant) unless the session is a recent sign-in.
 * Call after requireAccountCredential. The test fixture transport has no
 * session and is not checked.
 */
export async function requireRecentSignIn(
	request: Request,
	env: AuthBindings & { AUTH_TEST_BYPASS?: string },
): Promise<Response | null> {
	if (usesTestFixture(request, env)) return null;
	const session = await getRequestSession(request, env);
	return session && isRecentSession(session.session.createdAt) ? null : recentSignInRequired();
}

declare const __TODOFLARE_E2E__: boolean;
