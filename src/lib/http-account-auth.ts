import { normalizeAccountId, validateAccountId } from "./account";

export const ACCOUNT_AUTH_SCHEME = "Bearer";

export type AccountCredentialResult =
	| { ok: true; accountId: string }
	| { ok: false; response: Response };

export function accountAuthorizationHeader(accountId: string): string {
	return `${ACCOUNT_AUTH_SCHEME} ${normalizeAccountId(accountId)}`;
}

/**
 * Resolve the current account from a credential carried outside the URL.
 *
 * The 16-digit account number is still the application's bearer credential.
 * Keeping parsing in one place prevents routes from accidentally accepting it
 * through a path, query parameter, or request body.
 */
export function requireAccountCredential(request: Request): AccountCredentialResult {
	const authorization = request.headers.get("Authorization");
	const match = authorization?.match(/^Bearer ([^\s]+)$/);
	const credential = match?.[1];
	if (!credential || !validateAccountId(credential)) {
		return {
			ok: false,
			response: Response.json(
				{ error: "unauthorized", code: "unauthorized" },
				{ status: 401, headers: { "Cache-Control": "private, no-store" } },
			),
		};
	}

	return { ok: true, accountId: normalizeAccountId(credential) };
}
