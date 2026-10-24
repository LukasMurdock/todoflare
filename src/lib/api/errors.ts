export const API_ERROR_CODES = [
	"access_revoked",
	"not_owner",
	"not_found",
	"invalid_request",
	"read_only_mode",
	"rate_limited",
	"durable_object_unavailable",
	"account_export_incomplete",
	"server_contract_invalid",
	"idempotency_conflict",
	"idempotency_in_progress",
	"idempotency_outcome_unknown",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorEnvelope {
	error: string;
	code: ApiErrorCode;
	message?: string;
}

const apiErrorCodeSet = new Set<string>(API_ERROR_CODES);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
	return typeof value === "string" && apiErrorCodeSet.has(value);
}

/**
 * Codes the auth routes refuse with. They are not replayed (auth calls never
 * enter the outbox), so they stay out of API_ERROR_CODES; the client acts on
 * `recent_authentication_required` by asking for a passkey confirmation.
 */
export const AUTH_ERROR_CODES = [
	"unauthorized",
	"not_found",
	"recent_authentication_required",
	"account_mismatch",
	"user_verification_required",
	"last_recovery_method",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface AuthErrorEnvelope {
	error: AuthErrorCode;
	code: AuthErrorCode;
	message: string;
}
