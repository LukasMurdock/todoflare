import { describe, expect, it } from "vitest";
import {
	mutationResultFromResponse,
	shouldApplyAccessLossPolicy,
} from "../src/lib/sync/replay-response";

function errorResponse(status: number, code?: string): Response {
	return Response.json(
		code
			? { error: `error:${code}`, code }
			: { error: "legacy error" },
		{ status },
	);
}

describe("replay response contract", () => {
	it("acknowledges successful responses", async () => {
		expect(await mutationResultFromResponse(Response.json({ ok: true }))).toEqual({
			kind: "ack",
		});
	});

	it("applies access-loss policy only to explicit revocation", async () => {
		const revoked = await mutationResultFromResponse(
			errorResponse(403, "access_revoked"),
		);
		const notOwner = await mutationResultFromResponse(
			errorResponse(403, "not_owner"),
		);

		expect(revoked).toMatchObject({ kind: "drop", reason: "revoked" });
		expect(notOwner).toMatchObject({ kind: "drop", reason: "not_owner" });
		if (revoked.kind !== "drop" || notOwner.kind !== "drop") {
			throw new Error("Expected terminal replay results");
		}
		expect(shouldApplyAccessLossPolicy(revoked.reason)).toBe(true);
		expect(shouldApplyAccessLossPolicy(notOwner.reason)).toBe(false);
	});

	it.each([
		["not_found", 404, "not_found"],
		["invalid_request", 400, "validation_failed"],
	] as const)("maps %s to its terminal outcome", async (code, status, reason) => {
		expect(await mutationResultFromResponse(errorResponse(status, code))).toMatchObject({
			kind: "drop",
			reason,
		});
	});

	it.each([
		["read_only_mode", 503],
		["rate_limited", 429],
		["durable_object_unavailable", 503],
	] as const)("retries the transient %s response", async (code, status) => {
		expect(await mutationResultFromResponse(errorResponse(status, code))).toMatchObject({
			kind: "retry",
		});
	});

	it("retries unknown explicit codes instead of inferring revocation", async () => {
		expect(
			await mutationResultFromResponse(errorResponse(403, "future_forbidden_code")),
		).toMatchObject({ kind: "retry" });
	});

	it("retains status fallback for older deployments", async () => {
		expect(await mutationResultFromResponse(errorResponse(403))).toMatchObject({
			kind: "drop",
			reason: "revoked",
		});
		expect(await mutationResultFromResponse(errorResponse(404))).toMatchObject({
			kind: "drop",
			reason: "not_found",
		});
		expect(await mutationResultFromResponse(errorResponse(422))).toMatchObject({
			kind: "drop",
			reason: "validation_failed",
		});
	});

	it("retries uncoded transient failures", async () => {
		expect(
			await mutationResultFromResponse(new Response("unavailable", { status: 503 })),
		).toEqual({ kind: "retry", error: "unavailable" });
	});
});
