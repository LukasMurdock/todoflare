import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizeAccountId } from "../src/lib/account";
import { headers, createAccount, createColumn, coordinatorRequest, loadAuthoritativeAccount } from "./helpers/metadata-fixtures";

describe("metadata consistency under competing writers", () => {
	it("preserves a concurrent create when a stale reorder arrives", async () => {
		const account = await createAccount();
		const first = await createColumn(account.id);
		const second = crypto.randomUUID();

		const [createResponse, reorderResponse] = await Promise.all([
			SELF.fetch("http://example.com/api/column", {
				method: "POST",
				headers: headers(account.id),
				body: JSON.stringify({ columnId: second }),
			}),
			SELF.fetch("http://example.com/api/account/columns", {
				method: "PUT",
				headers: headers(account.id),
				body: JSON.stringify({ columnOrder: [first] }),
			}),
		]);

		expect(createResponse.ok).toBe(true);
		expect(reorderResponse.ok).toBe(true);
		expect((await loadAuthoritativeAccount(account.id)).columnOrder).toEqual([
			first,
			second,
		]);
	});

	it("does not let a concurrent stale reorder resurrect a deleted column", async () => {
		const account = await createAccount();
		const first = await createColumn(account.id);
		const deleted = await createColumn(account.id);

		const [deleteResponse, reorderResponse] = await Promise.all([
			SELF.fetch(`http://example.com/api/column/${deleted}`, {
				method: "DELETE",
				headers: headers(account.id),
			}),
			SELF.fetch("http://example.com/api/account/columns", {
				method: "PUT",
				headers: headers(account.id),
				body: JSON.stringify({ columnOrder: [deleted, first] }),
			}),
		]);

		expect(deleteResponse.ok).toBe(true);
		expect(reorderResponse.ok).toBe(true);
		expect((await loadAuthoritativeAccount(account.id)).columnOrder).toEqual([first]);
	});

	it("preserves concurrent shares of different columns to one account", async () => {
		const owner = await createAccount();
		const collaborator = await createAccount();
		const columns = [await createColumn(owner.id), await createColumn(owner.id)];

		const responses = await Promise.all(
			columns.map((columnId) =>
				SELF.fetch(`http://example.com/api/column/${columnId}/share`, {
					method: "POST",
					headers: headers(owner.id),
					body: JSON.stringify({ targetAccountId: collaborator.id }),
				}),
			),
		);
		expect(responses.every((response: Response) => response.ok)).toBe(true);

		const sharedKey = `shared:${normalizeAccountId(collaborator.id)}`;
		const shared = await coordinatorRequest(collaborator.id, "get", { key: sharedKey });
		expect(new Set(JSON.parse(shared.value as string) as string[])).toEqual(
			new Set(columns),
		);
	});

	it("atomically enforces the account column limit", async () => {
		const account = await createAccount();
		const existing = Array.from({ length: 99 }, () => crypto.randomUUID());
		const key = `account:${normalizeAccountId(account.id)}`;
		await coordinatorRequest(account.id, "put", {
			key,
			value: JSON.stringify({ ...account, columnOrder: existing }),
		});
		const candidates = [crypto.randomUUID(), crypto.randomUUID()];

		const responses = await Promise.all(
			candidates.map((columnId) =>
				SELF.fetch("http://example.com/api/column", {
					method: "POST",
					headers: headers(account.id),
					body: JSON.stringify({ columnId }),
				}),
			),
		);

		expect(responses.map((response: Response) => response.status).sort()).toEqual([200, 400]);
		expect((await loadAuthoritativeAccount(account.id)).columnOrder).toHaveLength(100);
	});

	it("allows only one column to claim a public ID", async () => {
		const publicId = `P${crypto.randomUUID().replaceAll("-", "").slice(0, 7)}`;
		const candidates = [crypto.randomUUID(), crypto.randomUUID()];
		const stub = env.PUBLIC_ID_COORDINATOR.get(
			env.PUBLIC_ID_COORDINATOR.idFromName(publicId),
		);
		const responses = await Promise.all(
			candidates.map((columnId) =>
				stub.fetch(
					new Request("http://public-id/claim", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ publicId, columnId }),
					}),
				),
			),
		);

		expect(responses.map((response: Response) => response.status).sort()).toEqual([
			200,
			409,
		]);
		expect(candidates).toContain(await env.ACCOUNTS.get(`public:${publicId}`));
	});
});
