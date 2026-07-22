import type { ApiErrorEnvelope } from "../lib/api/errors";

export interface ReadOnlyModeEnv {
	READ_ONLY_MODE?: string;
}

const READ_ONLY_MESSAGE =
	"Writes are temporarily disabled while we protect data. Please try again later.";

export function isReadOnlyMode(env: ReadOnlyModeEnv): boolean {
	return env.READ_ONLY_MODE === "true" || env.READ_ONLY_MODE === "1";
}

export function readOnlyModeResponse(): Response {
	const body: ApiErrorEnvelope = {
		error: "read_only_mode",
		code: "read_only_mode",
		message: READ_ONLY_MESSAGE,
	};

	return Response.json(body, {
		status: 503,
		headers: {
			"Cache-Control": "no-store",
			"Retry-After": "60",
		},
	});
}

export function readOnlyModeWebSocketMessage(): string {
	return READ_ONLY_MESSAGE;
}
