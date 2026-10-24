import { normalizeAccountId, validateAccountId } from "./account";
import { e2eAccountHeaders } from "./e2e-auth";

export const EXPECTED_ACCOUNT_HEADER = "X-Todoflare-Expected-Account";

// This is an expected identity, never a credential. Bind work queued for one
// account to its cookie session, including when another tab changes that cookie.
export function accountRequestHeaders(accountId: string): Record<string, string> {
	return {
		[EXPECTED_ACCOUNT_HEADER]: normalizeAccountId(accountId),
		...e2eAccountHeaders(accountId),
	};
}

/**
 * Whether a request is addressed to an account other than its session's. A
 * request without the header makes no claim and is not refused for it.
 */
export function namesAnotherAccount(headers: Headers, sessionAccountId: string): boolean {
	const expected = headers.get(EXPECTED_ACCOUNT_HEADER);
	if (expected === null) return false;
	return !validateAccountId(expected) || normalizeAccountId(expected) !== normalizeAccountId(sessionAccountId);
}
