import {
	normalizeAccountId,
	validateAccountId,
} from "../account";
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
	const response = await fetch(`/api/account/${normalizeAccountId(id)}`, { signal });
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
	return projectionFromServer(
		parseGetAccountResponse(await response.json()),
		window.location.origin,
	);
}

export async function createAccountProjection(
	signal: AbortSignal,
): Promise<AccountProjection> {
	const response = await fetch("/api/account", { method: "POST", signal });
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
