import { isApiErrorCode, type ApiErrorCode } from "../api/errors";
import type { TerminalReplayReason } from "./contracts";
import type { MutationReplayResult } from "./mutation-queue-service";

const terminalReasonByCode: Partial<Record<ApiErrorCode, TerminalReplayReason>> = {
	access_revoked: "revoked",
	not_owner: "not_owner",
	not_found: "not_found",
	invalid_request: "validation_failed",
	idempotency_conflict: "validation_failed",
};

interface ErrorPayload {
	code?: unknown;
	error?: unknown;
	message?: unknown;
}

function errorMessage(payload: ErrorPayload | null, fallback: string): string {
	if (typeof payload?.message === "string" && payload.message) {
		return payload.message;
	}
	if (typeof payload?.error === "string" && payload.error) {
		return payload.error;
	}
	return fallback;
}

export async function mutationResultFromResponse(
	response: Response,
): Promise<MutationReplayResult> {
	if (response.status === 401) return { kind: "authentication_required" };
	if (response.ok) {
		return { kind: "ack" };
	}

	const payload = (await response
		.clone()
		.json()
		.catch(() => null)) as ErrorPayload | null;
	const code = isApiErrorCode(payload?.code) ? payload.code : null;
	const hasExplicitCode = typeof payload?.code === "string";

	const detail = {
		status: response.status,
		code: typeof payload?.code === "string" ? payload.code : null,
		message: errorMessage(payload, "") || null,
	};

	if (code) {
		const terminalReason = terminalReasonByCode[code];
		if (terminalReason) {
			return {
				kind: "drop",
				reason: terminalReason,
				error: errorMessage(payload, code),
				detail,
			};
		}

		return {
			kind: "retry",
			error: errorMessage(payload, code),
		};
	}
	if (hasExplicitCode) {
		return {
			kind: "retry",
			error: errorMessage(payload, String(payload?.code)),
		};
	}

	// Compatibility fallback for responses from older deployments.
	if (response.status === 403) {
		return { kind: "drop", reason: "revoked", detail };
	}
	if (response.status === 404 || response.status === 410) {
		return { kind: "drop", reason: "not_found", detail };
	}
	if (response.status === 400 || response.status === 422) {
		return { kind: "drop", reason: "validation_failed", detail };
	}

	return {
		kind: "retry",
		error: await response.text(),
	};
}

export function shouldApplyAccessLossPolicy(
	reason: TerminalReplayReason,
): boolean {
	return reason === "revoked";
}
