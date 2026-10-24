import {
	normalizeAccountId,
	validateAccountId,
} from "../account";
import { accountCredentials, authClient, fetchAuthStatus, signalPasskeyAccount } from "../auth-client";
import { usingE2EAuthFixture } from "../e2e-auth";
import { accountRequestHeaders } from "../account-request-headers";
import {
	createAccountResponseSchema,
	getAccountResponseSchema,
} from "../api/account-contract";
import type {
	CreateAccountResponse,
	GetAccountResponse,
} from "../../types/account";
import {
	AccountConvergenceFailure,
	type AccountConvergenceError,
} from "./account-convergence-machine";
import { projectionFromServer, type AccountProjection } from "./account-projection";
import { API_ROUTES } from "../api/routes";

function malformedResponse(message: string): AccountConvergenceFailure {
	return new AccountConvergenceFailure(
		{ scope: "hydrate", kind: "server" },
		message,
	);
}

export function parseGetAccountResponse(value: unknown): GetAccountResponse {
	const parsed = getAccountResponseSchema.safeParse(value);
	if (!parsed.success) throw malformedResponse("Account response has invalid shape");
	return parsed.data satisfies GetAccountResponse;
}

function parseCreateAccountResponse(value: unknown): CreateAccountResponse {
	const parsed = createAccountResponseSchema.safeParse(value);
	if (!parsed.success) {
		throw malformedResponse("Create-account response has invalid shape");
	}
	return parsed.data satisfies CreateAccountResponse;
}

async function retryAfterMs(response: Response): Promise<number | null> {
	const retryAfterHeader = response.headers.get("Retry-After");
	if (retryAfterHeader !== null) {
		const headerSeconds = Number(retryAfterHeader);
		if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
			return headerSeconds * 1_000;
		}
	}
	try {
		const body = (await response.clone().json()) as { retryAfter?: unknown };
		return typeof body.retryAfter === "number" &&
			Number.isFinite(body.retryAfter) &&
			body.retryAfter >= 0
			? body.retryAfter * 1_000
			: null;
	} catch {
		return null;
	}
}

async function throwResponseFailure(
	response: Response,
	error: AccountConvergenceError,
	message: string,
): Promise<never> {
	throw new AccountConvergenceFailure(
		error,
		message,
		response.status === 429 ? await retryAfterMs(response) : null,
	);
}

export async function fetchAccountProjection(
	id: string,
	signal: AbortSignal,
	scope: "auth" | "hydrate",
): Promise<AccountProjection> {
	if (!validateAccountId(id)) {
		throw new AccountConvergenceFailure(
			{ scope: "auth", kind: "invalid" },
			"Invalid account ID format",
		);
	}
	const response = await fetch(API_ROUTES.getAccount.path, {
		method: API_ROUTES.getAccount.method,
		signal,
		credentials: "same-origin",
		headers: accountRequestHeaders(id),
	});
	if (response.status === 401) {
		await throwResponseFailure(
			response,
			{ scope: "auth", kind: "reauth_required" },
			"Sign in with a passkey to resume syncing",
		);
	}
	if (response.status === 404) {
		await throwResponseFailure(
			response,
			{ scope: "auth", kind: "not_found" },
			"Account not found",
		);
	}
	if (response.status === 429) {
		await throwResponseFailure(
			response,
			{ scope: "hydrate", kind: "rate_limited" },
			"Account request was rate limited",
		);
	}
	if (!response.ok) {
		await throwResponseFailure(
			response,
			{ scope: "hydrate", kind: "server" },
			`Failed to ${scope === "auth" ? "authenticate" : "hydrate"} account`,
		);
	}
	const data = parseGetAccountResponse(await response.json());
	if (normalizeAccountId(data.account.id) !== normalizeAccountId(id)) {
		throw new AccountConvergenceFailure(
			{ scope: "auth", kind: "reauth_required" },
			"Reconnect with the passkey for this account",
		);
	}
	return projectionFromServer(
		data,
		window.location.origin,
	);
}

export async function createAccountProjection(
	signal: AbortSignal,
): Promise<AccountProjection> {
	let response: Response;
	if (usingE2EAuthFixture()) {
		response = await fetch(API_ROUTES.createAccount.path, { method: API_ROUTES.createAccount.method, signal });
	} else {
		let status = await fetchAuthStatus(signal);
		if (status.state === "signed_out") {
			const anonymousResult = await authClient.signIn.anonymous();
			if (anonymousResult.error) {
				throw malformedResponse(anonymousResult.error.message ?? "Failed to start account creation");
			}
			status = await fetchAuthStatus(signal);
		}
		if (!status.accountId) throw malformedResponse("Account creation did not start a session");
		// Bind the rest of sign-up to this account: if another tab signs in as
		// someone else meanwhile, the server refuses instead of enrolling them.
		const headers = accountRequestHeaders(status.accountId);
		if (status.state === "provisional") {
			await accountCredentials(status.accountId).addPasskey("Primary passkey").catch((cause: unknown) => {
				throw malformedResponse(cause instanceof Error && cause.message ? cause.message : "Passkey registration failed");
			});
		}

		response = await fetch(API_ROUTES.createAccount.path, {
			method: API_ROUTES.createAccount.method,
			signal,
			credentials: "same-origin",
			headers,
		});
	}
	if (response.status === 429) {
		await throwResponseFailure(
			response,
			{ scope: "hydrate", kind: "rate_limited" },
			"Account creation was rate limited",
		);
	}
	if (!response.ok) {
		await throwResponseFailure(
			response,
			{ scope: "hydrate", kind: "server" },
			"Failed to create account",
		);
	}
	const { account } = parseCreateAccountResponse(await response.json());
	return projectionFromServer({
		account,
		ownedColumns: [],
		sharedColumns: [],
		deletedColumns: [],
	});
}

export async function signInWithPasskey(autoFill = false): Promise<string> {
	const result = await authClient.signIn.passkey({ autoFill });
	if (result.error) {
		throw malformedResponse(result.error.message ?? "Passkey sign-in failed");
	}
	const status = await fetchAuthStatus();
	if (!status.accountId || !["passkey", "provisioning"].includes(status.state)) {
		throw malformedResponse("Passkey session did not resolve an account");
	}
	signalPasskeyAccount(status.accountId);
	if (status.state === "provisioning") {
		const response = await fetch(API_ROUTES.createAccount.path, {
			method: API_ROUTES.createAccount.method,
			credentials: "same-origin",
		});
		if (!response.ok) throw malformedResponse("Account provisioning failed");
	}
	return normalizeAccountId(status.accountId);
}
