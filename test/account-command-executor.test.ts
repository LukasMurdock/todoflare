import { describe, expect, it } from "vitest";
import { createAccountCommandExecutor } from "../src/lib/sync/account-command-executor";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
	QueuedMutation,
} from "../src/lib/sync/contracts";
import { createAccountEditCommand } from "../src/lib/sync/contracts";

const ACCOUNT_ID = "1111 1111 1111 1111";
const COLUMN_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_ID = "2222 2222 2222 2222";

function mutation<T extends AccountCommandType>(
	opType: T,
	payload: AccountCommandPayloadMap[T],
): QueuedMutation<T> {
	return {
		...createAccountEditCommand(opType, payload, {
			idempotencyKey: `key:${opType}`,
			entityId: ACCOUNT_ID,
			createdAt: 1,
			attemptCount: 0,
			nextRetryAt: 0,
		}),
		queueId: `queue:${opType}`,
	} as QueuedMutation<T>;
}

describe("account command executor", () => {
	it("maps every command to its HTTP contract and typed effects", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });

			if (url === "/api/column" && init?.method === "POST") {
				return Response.json({
					column: {
						schemaVersion: 1,
						id: COLUMN_ID,
						ownerId: ACCOUNT_ID,
						sharedWith: [],
						publicId: null,
						createdAt: 1,
					},
				});
			}
			if (url.endsWith("/share") || url.includes("/share/")) {
				return Response.json({ success: true, sharedWith: [TARGET_ID] });
			}
			if (url.endsWith("/public") && init?.method === "POST") {
				return Response.json({ publicId: "AbCd1234", url: "/p/AbCd1234" });
			}
			return Response.json({ success: true });
		}) as typeof globalThis.fetch;

		const executor = createAccountCommandExecutor({
			getActiveAccountId: () => ACCOUNT_ID,
			fetch: fetchMock,
		});
		const commands: QueuedMutation[] = [
			mutation("column.create", { columnId: COLUMN_ID }),
			mutation("column.reorder", { columnOrder: [COLUMN_ID] }),
			mutation("column.hide_shared", { hiddenSharedColumns: [COLUMN_ID] }),
			mutation("column.delete", { columnId: COLUMN_ID }),
			mutation("column.restore", { columnId: COLUMN_ID }),
			mutation("column.share", {
				columnId: COLUMN_ID,
				targetAccountId: TARGET_ID,
			}),
			mutation("column.revoke", {
				columnId: COLUMN_ID,
				targetAccountId: TARGET_ID,
			}),
			mutation("column.public.enable", { columnId: COLUMN_ID }),
			mutation("column.public.disable", { columnId: COLUMN_ID }),
		];
		const results = [];
		for (const command of commands) {
			results.push(await executor.execute(command));
		}

		expect(requests.map(({ url, init }) => [init?.method, url])).toEqual([
			["POST", "/api/column"],
			["PUT", "/api/account/1111111111111111/columns"],
			["PUT", "/api/account/1111111111111111/hidden"],
			["DELETE", `/api/column/${COLUMN_ID}`],
			["POST", `/api/column/${COLUMN_ID}/restore`],
			["POST", `/api/column/${COLUMN_ID}/share`],
			["DELETE", `/api/column/${COLUMN_ID}/share/2222222222222222`],
			["POST", `/api/column/${COLUMN_ID}/public`],
			["DELETE", `/api/column/${COLUMN_ID}/public`],
		]);
		expect(
			requests.every(
				({ init }) =>
					new Headers(init?.headers).get("X-Idempotency-Key") !== null,
			),
		).toBe(true);
		expect(requests[0]?.init?.body).toBe(
			JSON.stringify({ accountId: ACCOUNT_ID, columnId: COLUMN_ID }),
		);
		expect(requests[5]?.init?.body).toBe(
			JSON.stringify({ targetAccountId: TARGET_ID }),
		);
		expect(results.every((result) => result.kind === "ack")).toBe(true);
		expect(results.flatMap((result) => result.effects ?? []).map((effect) => effect.type)).toEqual([
			"column.created",
			"column.deleted",
			"column.sharing.updated",
			"column.sharing.updated",
			"column.public.enabled",
			"column.public.disabled",
		]);
	});

	it("rejects invalid command payloads without fetching", async () => {
		let fetchCount = 0;
		const executor = createAccountCommandExecutor({
			getActiveAccountId: () => ACCOUNT_ID,
			fetch: (async () => {
				fetchCount += 1;
				return Response.json({ success: true });
			}) as typeof globalThis.fetch,
		});

		const result = await executor.execute(
			mutation("column.share", {
				columnId: COLUMN_ID,
				targetAccountId: "invalid",
			}),
		);

		expect(result).toMatchObject({
			kind: "drop",
			reason: "validation_failed",
		});
		expect(fetchCount).toBe(0);
	});

	it("retries session mismatches and preserves coded server outcomes", async () => {
		const mismatchedExecutor = createAccountCommandExecutor({
			getActiveAccountId: () => "3333 3333 3333 3333",
			fetch: (() => {
				throw new Error("fetch should not run");
			}) as typeof globalThis.fetch,
		});
		expect(
			await mismatchedExecutor.execute(
				mutation("column.delete", { columnId: COLUMN_ID }),
			),
		).toMatchObject({ kind: "retry" });

		const deniedExecutor = createAccountCommandExecutor({
			getActiveAccountId: () => ACCOUNT_ID,
			fetch: (async () =>
				Response.json(
					{ error: "Only owner can delete", code: "not_owner" },
					{ status: 403 },
				)) as typeof globalThis.fetch,
		});
		expect(
			await deniedExecutor.execute(
				mutation("column.delete", { columnId: COLUMN_ID }),
			),
		).toMatchObject({ kind: "drop", reason: "not_owner" });
	});
});
