import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { API_ROUTES, AUTH_BASE_PATH, AUTH_ROUTES } from "./api/routes";
import type { AuthErrorCode } from "./api/errors";
import { normalizeAccountId } from "./account";
import { accountRequestHeaders } from "./account-request-headers";

export const authClient = createAuthClient({
	basePath: AUTH_BASE_PATH,
	plugins: [anonymousClient(), passkeyClient()],
});

export interface AuthStatus {
	accountId: string | null;
	state: "signed_out" | "provisional" | "passkey" | "provisioning";
}

export async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
	const response = await fetch(API_ROUTES.authStatus.path, {
		method: API_ROUTES.authStatus.method,
		signal,
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) return { accountId: null, state: "signed_out" };
	return (await response.json()) as AuthStatus;
}

export async function recoverAccount(
	accountId: string,
	recoveryCode: string,
): Promise<{ accountId: string; recoveryCode: string }> {
	const { data, error } = await authClient.$fetch<{ accountId: string; recoveryCode: string }>(
		AUTH_ROUTES.recoverAccount.path,
		{
			method: AUTH_ROUTES.recoverAccount.method,
			body: { accountId: accountId.replace(/\D/g, ""), recoveryCode },
		},
	);
	if (error || !data?.accountId || !data.recoveryCode) throw authFailure(error, "Recovery failed");
	return data;
}

/** A credential change refused because the session is not a recent sign-in. */
export class RecentAuthenticationRequiredError extends Error {}

const RECENT_AUTHENTICATION_REQUIRED: AuthErrorCode = "recent_authentication_required";

/**
 * Turns a refused auth call into an error the account UI can act on. Without
 * a fallback, an error the server did not explain has an empty message.
 */
export function authFailure(
	body: { code?: unknown; message?: unknown } | null | undefined,
	fallback = "",
): Error {
	const message = typeof body?.message === "string" && body.message ? body.message : fallback;
	return body?.code === RECENT_AUTHENTICATION_REQUIRED
		? new RecentAuthenticationRequiredError(message)
		: new Error(message);
}

interface AuthResult<T> {
	data: T | null;
	error: { code?: unknown; message?: unknown } | null;
}

async function settled<T>(call: Promise<AuthResult<T>>): Promise<T> {
	const { data, error } = await call;
	if (error || data === null) throw authFailure(error);
	return data;
}

export interface ListedPasskey {
	id: string;
	name?: string | null;
	createdAt?: Date | string | null;
}

/**
 * Credential calls for one account. Each names that account, so the server
 * refuses it (`account_mismatch`) if another tab has since signed in as
 * someone else. better-auth's client sends the header only on the final
 * request of addPasskey (verify-registration), which is where the passkey is
 * stored. Every refusal throws: RecentAuthenticationRequiredError
 * when the user must first `reauthenticate`, otherwise an Error carrying the
 * server's message (possibly empty, for the caller's fallback).
 */
export function accountCredentials(accountId: string) {
	const headers = accountRequestHeaders(accountId);
	const fetchOptions = { headers };
	return {
		accountId,
		listPasskeys: () => settled(authClient.passkey.listUserPasskeys({ fetchOptions })) as Promise<ListedPasskey[]>,
		addPasskey: (name: string) => settled(authClient.passkey.addPasskey({ name, fetchOptions })),
		deletePasskey: (id: string) => settled(authClient.passkey.deletePasskey({ id, fetchOptions })),
		revokeOtherSessions: () => settled(authClient.revokeOtherSessions({ fetchOptions })),
		/** Creates or replaces the recovery code; it is shown only once. */
		generateRecoveryCode: async () => {
			const { recoveryCode } = await settled(authClient.$fetch<{ recoveryCode?: string }>(
				AUTH_ROUTES.generateRecoveryCode.path,
				// better-auth refuses a POST without a JSON body (415).
				{ method: AUTH_ROUTES.generateRecoveryCode.method, headers, body: {} },
			));
			if (!recoveryCode) throw new Error("");
			return recoveryCode;
		},
		/**
		 * Starts a fresh session for this account. With a session, Better Auth
		 * offers only its passkeys; if another tab switched accounts meanwhile,
		 * the confirmation is for the wrong account and the change it guards
		 * must not run.
		 */
		reauthenticate: async () => {
			await settled(authClient.signIn.passkey());
			const status = await fetchAuthStatus();
			if (!status.accountId || normalizeAccountId(status.accountId) !== normalizeAccountId(accountId)) {
				throw new Error("Another account is signed in on this device. Reload to continue.");
			}
		},
	};
}

export type AccountCredentials = ReturnType<typeof accountCredentials>;
