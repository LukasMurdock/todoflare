import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
	basePath: "/api/auth",
	plugins: [anonymousClient(), passkeyClient()],
});

export interface AuthStatus {
	accountId: string | null;
	state: "signed_out" | "provisional" | "passkey" | "provisioning";
}

export async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
	const response = await fetch("/api/auth-status", {
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
	const response = await fetch("/api/auth/recovery-code/recover", {
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
