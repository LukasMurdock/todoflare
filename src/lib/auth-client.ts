import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { API_ROUTES, AUTH_BASE_PATH } from "./api/routes";
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
	const response = await fetch(`${AUTH_BASE_PATH}/recovery-code/recover`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accountId: accountId.replace(/\D/g, ""), recoveryCode }),
	});
	const body = (await response.json()) as {
		accountId?: string;
		recoveryCode?: string;
		message?: string;
	};
	if (!response.ok || !body.accountId || !body.recoveryCode) {
		throw new Error(body.message ?? "Recovery failed");
	}
	return { accountId: body.accountId, recoveryCode: body.recoveryCode };
}

/** A credential change refused because the session is not a recent sign-in. */
export class RecentAuthenticationRequiredError extends Error {}

export function authFailure(
	body: { error?: unknown; message?: unknown } | null | undefined,
	fallback: string,
): Error {
	const message = typeof body?.message === "string" && body.message ? body.message : fallback;
	return body?.error === "recent_authentication_required"
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
