import type { ColumnMeta } from "../../types/account";
import { hasColumnAccess } from "../../lib/column-access";
import type { ApiErrorCode } from "../../lib/api/errors";
import { type SchemaParseResult } from "../persistence-records";
import type { ColumnLifecycleFailure } from "../workflows/column-lifecycle";

export function apiErrorResponse(
	code: ApiErrorCode,
	message: string,
	status: number,
): Response {
	return Response.json({ error: message, code }, { status });
}

export function schemaErrorResponse(
	kind: "account" | "column_meta" | "shared_index" | "trash",
	result: Extract<SchemaParseResult<unknown>, { ok: false }>,
) {
	return Response.json(
		{
			error: "schema_guard_blocked",
			kind,
			code: result.code,
			message: result.message,
			expectedVersion: result.expectedVersion,
			foundVersion: result.foundVersion ?? null,
		},
		{ status: 503 },
	);
}

export function isDurableObjectDurationError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.message.includes("Exceeded allowed duration in Durable Objects free tier");
}

export function durableObjectUnavailableResponse() {
	return Response.json(
		{
			error: "realtime_unavailable",
			code: "durable_object_unavailable",
			message: "Realtime backend is temporarily unavailable. Falling back to local mode is recommended.",
		},
		{ status: 503 },
	);
}

export function serverContractInvalidResponse(): Response {
	return apiErrorResponse(
		"server_contract_invalid",
		"Mutation handler returned an invalid success response",
		503,
	);
}

export function columnOwnerError(
	meta: ColumnMeta,
	accountId: string,
	message: string,
): Response {
	const stillHasAccess = hasColumnAccess(meta, accountId);
	return apiErrorResponse(
		stillHasAccess ? "not_owner" : "access_revoked",
		message,
		403,
	);
}

export function columnLifecycleFailureResponse(
	failure: ColumnLifecycleFailure,
	accountId: string,
): Response {
	switch (failure.kind) {
		case "api":
			return apiErrorResponse(failure.code, failure.message, failure.status);
		case "schema":
			return schemaErrorResponse(failure.record, failure.result);
		case "owner":
			return columnOwnerError(failure.meta, accountId, failure.message);
	}
}
