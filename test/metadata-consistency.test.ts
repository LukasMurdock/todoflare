import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { displayAccountId, normalizeAccountId } from "../src/lib/account";
import {
	beginLifecycleOperation,
	registerColumn,
} from "../src/server/lifecycle-journal";
import { reconcileColumnLifecycle } from "../src/server/workflows/reconcile-column-lifecycle";
import type { Account, ColumnMeta } from "../src/types/account";

function headers(accountId: string): Record<string, string> {
	return {
		"X-Todoflare-Test-Account": normalizeAccountId(accountId),
		"Content-Type": "application/json",
	};
}

async function createAccount(): Promise<Account> {
	const response = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
		headers: { "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 200)}.1` },
	});
	expect(response.ok).toBe(true);
	return ((await response.json()) as { account: Account }).account;
}

async function createColumn(accountId: string, columnId = crypto.randomUUID()): Promise<string> {
	const response = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: headers(accountId),
		body: JSON.stringify({ columnId }),
	});
	expect(response.ok).toBe(true);
	return columnId;
}

async function coordinatorRequest(
	accountId: string,
	path: "get" | "put" | "mutate",
	body: Record<string, unknown>,
): Promise<{ value?: string | null }> {
	const normalized = normalizeAccountId(accountId);
	const stub = env.ACCOUNT_COORDINATOR.get(
		env.ACCOUNT_COORDINATOR.idFromName(normalized),
	);
	const response = await stub.fetch(
		new Request(`http://account-coordinator/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	expect(response.ok).toBe(true);
	return (await response.json()) as { value?: string | null };
}

async function loadAuthoritativeAccount(accountId: string): Promise<Account> {
	const key = `account:${normalizeAccountId(accountId)}`;
	const result = await coordinatorRequest(accountId, "get", { key });
	return JSON.parse(result.value as string) as Account;
}

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

describe("scheduled lifecycle recovery", () => {
	it("does not resurrect columns when the owner's trash record is malformed", async () => {
		const account = await createAccount();
		const columnId = await createColumn(account.id);
		const normalizedId = normalizeAccountId(account.id);
		const accountKey = `account:${normalizedId}`;
		const trashKey = `trash:${normalizedId}`;
		await coordinatorRequest(account.id, "put", {
			key: accountKey,
			value: JSON.stringify({ ...account, columnOrder: [] }),
		});
		await coordinatorRequest(account.id, "put", { key: trashKey, value: "{" });

		const result = await reconcileColumnLifecycle(env);

		expect(result.trashRecordsInvalid).toBeGreaterThanOrEqual(1);
		expect(result.ownerMembershipRepaired).toBe(0);
		expect((await loadAuthoritativeAccount(account.id)).columnOrder).not.toContain(columnId);
		expect((await coordinatorRequest(account.id, "get", { key: trashKey })).value).toBe(
			"{",
		);
	});

	it("rejects trash mutations without overwriting malformed source data", async () => {
		const account = await createAccount();
		const key = `trash:${normalizeAccountId(account.id)}`;
		await coordinatorRequest(account.id, "put", { key, value: "{" });
		const stub = env.ACCOUNT_COORDINATOR.get(
			env.ACCOUNT_COORDINATOR.idFromName(normalizeAccountId(account.id)),
		);

		const response = await stub.fetch(
			new Request("http://account-coordinator/mutate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key,
					mutation: { kind: "trash-remove", columnId: crypto.randomUUID() },
				}),
			}),
		);

		expect(response.status).toBe(409);
		expect((await coordinatorRequest(account.id, "get", { key })).value).toBe("{");
	});

	it("finishes a create without another user request", async () => {
		const account = await createAccount();
		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: crypto.randomUUID(),
			ownerId: displayAccountId(account.id),
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};
		const operationId = crypto.randomUUID();
		await registerColumn(env.ACCOUNTS, meta);
		await beginLifecycleOperation(env.ACCOUNTS, {
			kind: "create",
			operationId,
			createdAt: Date.now(),
			meta,
		});

		const result = await reconcileColumnLifecycle(env);

		expect(result.operationsCompleted).toBeGreaterThanOrEqual(1);
		expect((await loadAuthoritativeAccount(account.id)).columnOrder).toContain(meta.id);
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(meta.id));
		expect((await stub.fetch(new Request("http://do/meta"))).ok).toBe(true);
		expect(await env.ACCOUNTS.get(`lifecycle-operation:${operationId}`)).toBeNull();
	});

	it("repairs stale public KV without reporting an authoritative conflict", async () => {
		const account = await createAccount();
		const columnId = crypto.randomUUID();
		const publicId = `P${crypto.randomUUID().replaceAll("-", "").slice(0, 7)}`;
		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: account.id,
			sharedWith: [],
			publicId,
			createdAt: Date.now(),
		};
		await registerColumn(env.ACCOUNTS, meta);
		const column = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		expect(
			(
				await column.fetch(
					new Request("http://do/init", {
						method: "POST",
						body: JSON.stringify(meta),
					}),
				)
			).ok,
		).toBe(true);
		const coordinator = env.PUBLIC_ID_COORDINATOR.get(
			env.PUBLIC_ID_COORDINATOR.idFromName(publicId),
		);
		expect(
			(
				await coordinator.fetch(
					new Request("http://public-id/claim", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ publicId, columnId }),
					}),
				)
			).ok,
		).toBe(true);
		await env.ACCOUNTS.put(`public:${publicId}`, crypto.randomUUID());

		const result = await reconcileColumnLifecycle(env);

		expect(result.publicMappingConflicts).toBe(0);
		expect(result.publicMappingsRepaired).toBeGreaterThanOrEqual(1);
		expect(await env.ACCOUNTS.get(`public:${publicId}`)).toBe(columnId);
	});
});
