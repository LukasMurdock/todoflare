import { normalizeAccountId } from "./account";
import { e2eAccountHeaders } from "./e2e-auth";

// This is an expected identity, never a credential. Bind work queued for one
// account to its cookie session, including when another tab changes that cookie.
export function accountRequestHeaders(accountId: string): Record<string, string> {
	return {
		"X-Todoflare-Expected-Account": normalizeAccountId(accountId),
		...e2eAccountHeaders(accountId),
	};
}
