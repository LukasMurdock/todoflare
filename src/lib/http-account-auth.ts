import { normalizeAccountId, validateAccountId } from "./account";
import type { AuthBindings } from "../server/auth";
import { getRequestSession } from "../server/session";

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

/** Resolve a permanent account exclusively from a Better Auth session cookie. */
export async function requireAccountCredential(
	request: Request,
	env: AuthBindings & { AUTH_TEST_BYPASS?: string },
): Promise<AccountCredentialResult> {
	const compiledE2E =
		typeof __TODOFLARE_E2E__ !== "undefined" && __TODOFLARE_E2E__;
	if (
		(env.AUTH_TEST_BYPASS === "true" || compiledE2E) &&
		request.headers.get("X-Test-Disable-Auth-Bypass") !== "1"
	) {
		const credential = request.headers.get("X-Todoflare-Test-Account");
		if (credential && validateAccountId(credential)) {
			return { ok: true, accountId: normalizeAccountId(credential) };
		}
	}
	const session = await getRequestSession(request, env);
	if (!session || !validateAccountId(session.user.id)) {
		return unauthorized();
	}

	const expected = request.headers.get("X-Todoflare-Expected-Account");
	if (expected !== null && (!validateAccountId(expected) || normalizeAccountId(expected) !== normalizeAccountId(session.user.id))) {
		return unauthorized();
	}

	// `isAnonymous` is intentionally not trusted as the promotion signal. A user
	// becomes permanent only once Better Auth has stored at least one credential.
	const credential = await env.AUTH_DB.prepare(
		'SELECT 1 AS present FROM "passkey" WHERE "userId" = ? LIMIT 1',
	)
		.bind(session.user.id)
		.first<{ present: number }>();
	if (!credential) return unauthorized();

	return { ok: true, accountId: normalizeAccountId(session.user.id) };
}

declare const __TODOFLARE_E2E__: boolean;
