import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { API_ROUTES, AUTH_BASE_PATH, AUTH_ROUTES } from "./api/routes";
import type { AuthErrorCode } from "./api/errors";
import { normalizeAccountId } from "./account";

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

/** Creates or replaces the account's recovery code; it is shown only once. */
export async function generateRecoveryCode(headers: Record<string, string>): Promise<string> {
	const { data, error } = await authClient.$fetch<{ recoveryCode: string }>(
		AUTH_ROUTES.generateRecoveryCode.path,
		{ method: AUTH_ROUTES.generateRecoveryCode.method, headers },
	);
	if (error || !data?.recoveryCode) throw authFailure(error, "Recovery code creation failed");
	return data.recoveryCode;
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

/**
 * Starts a fresh session for the account the caller expects to be signed in.
 * With a session, Better Auth offers only that account's passkeys; if another
 * tab switched accounts meanwhile, the confirmation is for the wrong account
 * and the change it guards must not run.
 */
export async function reauthenticate(expectedAccountId: string): Promise<void> {
	const result = await authClient.signIn.passkey();
	if (result.error) throw authFailure(result.error, "Passkey confirmation failed");
	const status = await fetchAuthStatus();
	if (!status.accountId || normalizeAccountId(status.accountId) !== normalizeAccountId(expectedAccountId)) {
		throw new Error("Another account is signed in on this device. Reload to continue.");
	}
}
