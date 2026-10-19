// Scheduled lifecycle reconciliation scans all stored accounts and columns, so
// these tests live in their own file: storage is isolated per test file, not
// per test, and other files' fixtures (such as an account filled to its
// column limit) would otherwise make each scan slow and order-dependent.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { displayAccountId, normalizeAccountId } from "../src/lib/account";
import { beginLifecycleOperation, registerColumn } from "../src/server/lifecycle-journal";
import { reconcileColumnLifecycle } from "../src/server/workflows/reconcile-column-lifecycle";
import type { ColumnMeta } from "../src/types/account";
import { headers, createAccount, createColumn, coordinatorRequest, loadAuthoritativeAccount } from "./helpers/metadata-fixtures";

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
