import { type Context } from "hono";
import { z } from "zod";
import { normalizeAccountId, validateAccountId } from "../../lib/account";
import { type Bindings } from "../bindings";
import { serverContractInvalidResponse } from "./responses";

export const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export const IDEMPOTENCY_CACHE_TTL_SECONDS = 24 * 60 * 60;

export const IDEMPOTENCY_PENDING_WAIT_MS = 1500;

export const IDEMPOTENCY_PENDING_POLL_MS = 50;

export function parseIdempotencyKey(value: string | null | undefined): string | null {
	if (!value) return null;
	const parsed = z
		.string()
		.trim()
		.min(1)
		.max(IDEMPOTENCY_KEY_MAX_LENGTH)
		.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function idempotencyCacheKey(
	scope: string,
	accountScope: string,
	idempotencyKey: string,
): string {
	return `idempotency:${scope}:${accountScope}:${idempotencyKey}`;
}

export function idempotencyKeyConflictResponse() {
	return Response.json(
		{
			error: "idempotency_key_conflict",
			code: "idempotency_conflict",
			message: "This idempotency key was already used for a different request.",
		},
		{ status: 409 },
	);
}

export function idempotencyRequestInProgressResponse() {
	return Response.json(
		{
			error: "idempotency_request_in_progress",
			code: "idempotency_in_progress",
			message:
				"A request with this idempotency key is still in progress. Retry shortly.",
		},
		{ status: 409 },
	);
}

export function idempotencyOutcomeUnknownResponse() {
	return Response.json(
		{
			error: "idempotency_outcome_unknown",
			code: "idempotency_in_progress",
			message:
				"A previous attempt may have executed, but its outcome could not be recorded. Retry with a new operation only after reconciling state.",
		},
		{ status: 409 },
	);
}

export function idempotencyCoordinatorUnavailableResponse() {
	return Response.json(
		{
			error: "idempotency_unavailable",
			code: "durable_object_unavailable",
			message: "Idempotency coordination is temporarily unavailable.",
		},
		{ status: 503 },
	);
}

export function toIdempotentReplayResponse(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
		headers: {
			"X-Idempotency-Replay": "1",
		},
	});
}

export function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export async function waitForPendingIdempotentCompletion(
	stub: DurableObjectStub,
	fingerprint: string,
): Promise<Response | null> {
	const deadline = Date.now() + IDEMPOTENCY_PENDING_WAIT_MS;

	while (Date.now() < deadline) {
		await wait(IDEMPOTENCY_PENDING_POLL_MS);
		const outcome = await beginIdempotentRequest(stub, fingerprint);
		if (outcome.kind === "conflict") return idempotencyKeyConflictResponse();
		if (outcome.kind === "completed") {
			return toIdempotentReplayResponse(outcome.status, outcome.body);
		}
		if (outcome.kind === "indeterminate") return idempotencyOutcomeUnknownResponse();
		if (outcome.kind === "acquired") {
			throw new Error("Idempotency coordinator unexpectedly released an active claim");
		}
	}

	return idempotencyRequestInProgressResponse();
}

export type IdempotencyBeginOutcome =
	| { kind: "acquired"; ownerToken: string }
	| { kind: "completed"; status: number; body: unknown }
	| { kind: "pending" }
	| { kind: "indeterminate" }
	| { kind: "conflict" };

export async function beginIdempotentRequest(
	stub: DurableObjectStub,
	fingerprint: string,
): Promise<IdempotencyBeginOutcome> {
	const response = await stub.fetch(
		new Request("http://idempotency/begin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fingerprint,
				pendingExpiresAt: Date.now() + IDEMPOTENCY_CACHE_TTL_SECONDS * 1000,
			}),
		}),
	);
	if (!response.ok) throw new Error(`Idempotency coordinator failed: ${response.status}`);
	return (await response.json()) as IdempotencyBeginOutcome;
}

export async function finishIdempotentRequest(
	stub: DurableObjectStub,
	path: "complete" | "indeterminate",
	payload: Record<string, unknown>,
): Promise<void> {
	const response = await stub.fetch(
		new Request(`http://idempotency/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...payload,
				expiresAt: Date.now() + IDEMPOTENCY_CACHE_TTL_SECONDS * 1000,
			}),
		}),
	);
	if (!response.ok) throw new Error(`Idempotency coordinator failed: ${response.status}`);
}

export async function idempotencyRequestFingerprint(
	request: Request,
	requestFingerprintSource?: string,
): Promise<string> {
	const url = new URL(request.url);
	const body =
		typeof requestFingerprintSource === "string"
			? requestFingerprintSource
			: await request
					.clone()
					.text()
					.catch(() => "__BODY_UNAVAILABLE__");
	const source = `${request.method.toUpperCase()} ${url.pathname}${url.search}\n${body}`;

	return sha256Hex(source);
}

export interface IdempotentWriteOptions {
	scope: string;
	accountId?: string | null;
	requestFingerprintSource?: string;
	successSchema?: z.ZodType;
}

export async function validateSuccessfulWriteResponse(
	response: Response,
	schema?: z.ZodType,
): Promise<Response> {
	if (!response.ok || !schema) return response;
	const body = await response
		.clone()
		.json()
		.catch(() => null);
	return schema.safeParse(body).success
		? response
		: serverContractInvalidResponse();
}

export async function withIdempotentWrite(
	c: Context<{ Bindings: Bindings }>,
	options: IdempotentWriteOptions,
	handler: () => Promise<Response>,
): Promise<Response> {
	const idempotencyKey = parseIdempotencyKey(c.req.header(IDEMPOTENCY_HEADER));
	if (!idempotencyKey) {
		return validateSuccessfulWriteResponse(await handler(), options.successSchema);
	}

	const accountScope =
		typeof options.accountId === "string" && validateAccountId(options.accountId)
			? normalizeAccountId(options.accountId)
			: "guest";
	const cacheKey = idempotencyCacheKey(
		options.scope,
		accountScope,
		idempotencyKey,
	);
	const fingerprint = await idempotencyRequestFingerprint(
		c.req.raw,
		options.requestFingerprintSource,
	);
	const stub = c.env.IDEMPOTENCY_COORDINATOR.get(
		c.env.IDEMPOTENCY_COORDINATOR.idFromName(cacheKey),
	);
	let outcome: IdempotencyBeginOutcome;
	try {
		outcome = await beginIdempotentRequest(stub, fingerprint);
	} catch (error) {
		console.error("Idempotency coordinator unavailable", error);
		return idempotencyCoordinatorUnavailableResponse();
	}
	if (outcome.kind === "conflict") return idempotencyKeyConflictResponse();
	if (outcome.kind === "completed") {
		return validateSuccessfulWriteResponse(
			toIdempotentReplayResponse(outcome.status, outcome.body),
			options.successSchema,
		);
	}
	if (outcome.kind === "indeterminate") return idempotencyOutcomeUnknownResponse();
	if (outcome.kind === "pending") {
		try {
			const response =
				(await waitForPendingIdempotentCompletion(stub, fingerprint)) ??
				idempotencyRequestInProgressResponse();
			return validateSuccessfulWriteResponse(
				response,
				options.successSchema,
			);
		} catch (error) {
			console.error("Idempotency coordinator unavailable while waiting", error);
			return idempotencyCoordinatorUnavailableResponse();
		}
	}

	try {
		const response = await validateSuccessfulWriteResponse(
			await handler(),
			options.successSchema,
		);
		const body = await response.clone().json().catch(() => undefined);
		if (response.status < 500 && typeof body !== "undefined") {
			await finishIdempotentRequest(stub, "complete", {
				ownerToken: outcome.ownerToken,
				status: response.status,
				body,
			});
		} else {
			await finishIdempotentRequest(stub, "indeterminate", {
				ownerToken: outcome.ownerToken,
			});
		}

		return response;
	} catch (err) {
		await finishIdempotentRequest(stub, "indeterminate", {
			ownerToken: outcome.ownerToken,
		}).catch((markError) => {
			console.error("Failed to mark idempotency outcome indeterminate", markError);
		});
		throw err;
	}
}

export function toHex(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return toHex(digest);
}
