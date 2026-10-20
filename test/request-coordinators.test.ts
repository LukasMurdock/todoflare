import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkRateLimit } from "../src/lib/rate-limit";

describe("request coordinators", () => {
	it("atomically admits one idempotency owner", async () => {
		const stub = env.IDEMPOTENCY_COORDINATOR.get(
			env.IDEMPOTENCY_COORDINATOR.idFromName(`test:${crypto.randomUUID()}`),
		);
		const begin = () =>
			stub.fetch(
				new Request("http://idempotency/begin", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						fingerprint: "same-request",
						pendingExpiresAt: Date.now() + 60_000,
					}),
				}),
			);

		const responses: Response[] = await Promise.all(
			Array.from({ length: 50 }, begin),
		);
		const outcomes = (await Promise.all(
			responses.map((response) => response.json()),
		)) as Array<{ kind: string }>;
		expect(outcomes.filter((outcome) => outcome.kind === "acquired")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.kind === "pending")).toHaveLength(49);
	});

	it("does not reopen an indeterminate idempotency outcome", async () => {
		const stub = env.IDEMPOTENCY_COORDINATOR.get(
			env.IDEMPOTENCY_COORDINATOR.idFromName(`test:${crypto.randomUUID()}`),
		);
		const begin = (fingerprint: string) =>
			stub.fetch(
				new Request("http://idempotency/begin", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						fingerprint,
						pendingExpiresAt: Date.now() + 60_000,
					}),
				}),
			);

		const claim = (await (await begin("same-request")).json()) as {
			kind: string;
			ownerToken: string;
		};
		expect(claim.kind).toBe("acquired");

		const marked = await stub.fetch(
			new Request("http://idempotency/indeterminate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ownerToken: claim.ownerToken,
					expiresAt: Date.now() + 60_000,
				}),
			}),
		);
		expect(marked.ok).toBe(true);
		expect(await (await begin("same-request")).json()).toMatchObject({
			kind: "indeterminate",
		});
		expect(await (await begin("different-request")).json()).toMatchObject({
			kind: "conflict",
		});
	});

	it("reports an unknown outcome once a pending claim outlives its lease", async () => {
		const stub = env.IDEMPOTENCY_COORDINATOR.get(
			env.IDEMPOTENCY_COORDINATOR.idFromName(`test:${crypto.randomUUID()}`),
		);
		const begin = (pendingLeaseMs?: number) =>
			stub.fetch(
				new Request("http://idempotency/begin", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						fingerprint: "same-request",
						pendingExpiresAt: Date.now() + 60_000,
						pendingLeaseMs,
					}),
				}),
			);

		const claim = (await (await begin()).json()) as { kind: string; ownerToken: string };
		expect(claim.kind).toBe("acquired");
		expect(await (await begin()).json()).toEqual({ kind: "pending" });
		// The owner died mid-request: past the lease, nobody may re-run it.
		expect(await (await begin(0)).json()).toEqual({ kind: "indeterminate" });
		expect(await (await begin()).json()).toEqual({ kind: "indeterminate" });

		// An owner that was only slow still records its real result.
		const completed = await stub.fetch(
			new Request("http://idempotency/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					ownerToken: claim.ownerToken,
					status: 200,
					body: { success: true },
					expiresAt: Date.now() + 60_000,
				}),
			}),
		);
		expect(completed.ok).toBe(true);
		expect(await (await begin()).json()).toEqual({
			kind: "completed",
			status: 200,
			body: { success: true },
		});
	});

	it("hands an unknown outcome to a rerunnable request and rejects the old owner", async () => {
		const stub = env.IDEMPOTENCY_COORDINATOR.get(
			env.IDEMPOTENCY_COORDINATOR.idFromName(`test:${crypto.randomUUID()}`),
		);
		const post = (path: string, body: unknown) =>
			stub.fetch(new Request(`http://idempotency/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}));
		const begin = async (options: { rerunnable?: boolean; pendingLeaseMs?: number } = {}) =>
			(await (await post("begin", { fingerprint: "same-request", pendingExpiresAt: Date.now() + 60_000, ...options })).json()) as { kind: string; ownerToken?: string };

		const first = await begin();
		expect(first.kind).toBe("acquired");
		// A live claim is never taken over.
		expect(await begin({ rerunnable: true })).toEqual({ kind: "pending" });
		// Past its lease, the rerunnable request owns it.
		const second = await begin({ rerunnable: true, pendingLeaseMs: 0 });
		expect(second.kind).toBe("acquired");
		expect(second.ownerToken).not.toBe(first.ownerToken);
		expect(await begin({ rerunnable: true })).toEqual({ kind: "pending" });

		expect((await post("indeterminate", { ownerToken: second.ownerToken, expiresAt: Date.now() + 60_000 })).ok).toBe(true);
		expect(await begin()).toEqual({ kind: "indeterminate" });
		const third = await begin({ rerunnable: true });
		expect(third.kind).toBe("acquired");

		const stale = await post("complete", { ownerToken: first.ownerToken, status: 200, body: { stale: true }, expiresAt: Date.now() + 60_000 });
		expect(stale.status).toBe(409);
		expect((await post("complete", { ownerToken: third.ownerToken, status: 200, body: { success: true }, expiresAt: Date.now() + 60_000 })).ok).toBe(true);
		expect(await begin({ rerunnable: true })).toEqual({ kind: "completed", status: 200, body: { success: true } });
	});

	it("atomically enforces the configured rate limit under concurrency", async () => {
		const key = `concurrent:${crypto.randomUUID()}`;
		const results = await Promise.all(
			Array.from({ length: 50 }, () =>
				checkRateLimit(env.RATE_LIMIT_COORDINATOR, key, {
					limit: 7,
					windowSeconds: 60,
				}),
			),
		);

		expect(results.filter((result) => result.allowed)).toHaveLength(7);
		expect(results.filter((result) => !result.allowed)).toHaveLength(43);
		expect(
			results.filter((result) => result.allowed).map((result) => result.remaining).sort(),
		).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(results.filter((result) => !result.allowed).every((result) => result.retryAfter)).toBe(
			true,
		);
	});
});
