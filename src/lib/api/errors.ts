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
