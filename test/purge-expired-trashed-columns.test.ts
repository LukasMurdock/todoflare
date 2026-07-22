import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeExpiredTrashedColumns } from "../src/server/workflows/purge-expired-trashed-columns";
import { TRASH_RETENTION_MS } from "../src/server/persistence-records";
import type { ColumnMeta } from "../src/types/account";

const FIXED_NOW = 1_900_000_000_000;
const seededAccountIds: string[] = [];

afterEach(async () => {
	for (const accountId of seededAccountIds.splice(0)) {
		await env.ACCOUNTS.delete(`account:${accountId}`);
		await env.ACCOUNTS.delete(`trash:${accountId}`);
	}
});

async function seedTrash(
	entries: Array<{ columnId: string; deletedAt: number }>,
): Promise<string> {
	const accountId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		String(byte % 10),
	).join("");
	seededAccountIds.push(accountId);
	await env.ACCOUNTS.put(`account:${accountId}`, "{}");
	await env.ACCOUNTS.put(`trash:${accountId}`, JSON.stringify(entries));
	return accountId;
}

async function loadTrash(accountId: string) {
	return JSON.parse((await env.ACCOUNTS.get(`trash:${accountId}`)) ?? "[]") as Array<{
		columnId: string;
		deletedAt: number;
	}>;
}

describe("purgeExpiredTrashedColumns workflow", () => {
	it("removes a trash entry only after a successful Durable Object deletion", async () => {
		const columnId = crypto.randomUUID();
		const accountId = await seedTrash([
			{ columnId, deletedAt: FIXED_NOW - TRASH_RETENTION_MS },
		]);
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: accountId,
			sharedWith: [],
			publicId: null,
			createdAt: FIXED_NOW - TRASH_RETENTION_MS,
		};
		const initResponse = await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(meta),
			}),
		);
		expect(initResponse.ok).toBe(true);

		const result = await purgeExpiredTrashedColumns({ env, now: () => FIXED_NOW });

		expect(result).toEqual({
			accountsScanned: 1,
			trashRecordsInvalid: 0,
			columnsPurged: 1,
			columnsFailed: 0,
			trashEntriesRemoved: 1,
		});
		expect(await loadTrash(accountId)).toEqual([]);
		expect((await stub.fetch(new Request("http://do/meta"))).status).toBe(404);
	});

	it("retains a non-OK deletion until a later retry succeeds", async () => {
		const entry = {
			columnId: crypto.randomUUID(),
			deletedAt: FIXED_NOW - TRASH_RETENTION_MS,
		};
		const accountId = await seedTrash([entry]);

		const result = await purgeExpiredTrashedColumns({
			env,
			now: () => FIXED_NOW,
			deleteColumn: async () => new Response("unavailable", { status: 503 }),
		});

		expect(result.columnsFailed).toBe(1);
		expect(result.columnsPurged).toBe(0);
		expect(result.trashEntriesRemoved).toBe(0);
		expect(await loadTrash(accountId)).toEqual([entry]);

		const retried = await purgeExpiredTrashedColumns({
			env,
			now: () => FIXED_NOW,
			deleteColumn: async () => Response.json({ success: true }),
		});
		expect(retried.columnsPurged).toBe(1);
		expect(retried.columnsFailed).toBe(0);
		expect(await loadTrash(accountId)).toEqual([]);
	});

	it("retains an expired entry after a thrown deletion error", async () => {
		const entry = {
			columnId: crypto.randomUUID(),
			deletedAt: FIXED_NOW - TRASH_RETENTION_MS,
		};
		const accountId = await seedTrash([entry]);

		const result = await purgeExpiredTrashedColumns({
			env,
			now: () => FIXED_NOW,
			deleteColumn: async () => {
				throw new Error("Durable Object unavailable");
			},
		});

		expect(result.columnsFailed).toBe(1);
		expect(result.columnsPurged).toBe(0);
		expect(result.trashEntriesRemoved).toBe(0);
		expect(await loadTrash(accountId)).toEqual([entry]);
	});

	it("does not delete column data when registry removal fails", async () => {
		const entry = {
			columnId: crypto.randomUUID(),
			deletedAt: FIXED_NOW - TRASH_RETENTION_MS,
		};
		const accountId = await seedTrash([entry]);
		const deleteColumn = vi.fn(async () => Response.json({ success: true }));
		const accounts = {
			get: (key: string) => env.ACCOUNTS.get(key),
			put: (key: string, value: string) => env.ACCOUNTS.put(key, value),
			list: (options: Parameters<typeof env.ACCOUNTS.list>[0]) =>
				env.ACCOUNTS.list(options),
			delete: async (key: string) => {
				if (key === `column-registry:${entry.columnId}`) {
					throw new Error("registry unavailable");
				}
				await env.ACCOUNTS.delete(key);
			},
		};

		const result = await purgeExpiredTrashedColumns({
			env: { ACCOUNTS: accounts, COLUMN_ROOM: env.COLUMN_ROOM },
			now: () => FIXED_NOW,
			deleteColumn,
		});

		expect(result.columnsFailed).toBe(1);
		expect(deleteColumn).not.toHaveBeenCalled();
		expect(await loadTrash(accountId)).toEqual([entry]);
	});

	it("reads trash from the account coordinator instead of stale KV", async () => {
		const entry = {
			columnId: crypto.randomUUID(),
			deletedAt: FIXED_NOW - TRASH_RETENTION_MS,
		};
		const accountId = await seedTrash([]);
		const trashKey = `trash:${accountId}`;
		const coordinator = env.ACCOUNT_COORDINATOR.get(
			env.ACCOUNT_COORDINATOR.idFromName(accountId),
		);
		await coordinator.fetch(
			new Request("http://account-coordinator/put", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: trashKey, value: JSON.stringify([entry]) }),
			}),
		);
		await env.ACCOUNTS.put(trashKey, "[]");
		const deleteColumn = vi.fn(async () => Response.json({ success: true }));

		const result = await purgeExpiredTrashedColumns({
			env,
			now: () => FIXED_NOW,
			deleteColumn,
		});

		expect(deleteColumn).toHaveBeenCalledWith(entry.columnId);
		expect(result.columnsPurged).toBe(1);
	});

	it("preserves malformed trash and skips destructive purge actions", async () => {
		const accountId = await seedTrash([]);
		const trashKey = `trash:${accountId}`;
		await env.ACCOUNTS.put(trashKey, "{");
		const deleteColumn = vi.fn(async () => Response.json({ success: true }));

		const result = await purgeExpiredTrashedColumns({
			env: { ACCOUNTS: env.ACCOUNTS, COLUMN_ROOM: env.COLUMN_ROOM },
			now: () => FIXED_NOW,
			deleteColumn,
		});

		expect(result.trashRecordsInvalid).toBe(1);
		expect(result.columnsPurged).toBe(0);
		expect(result.trashEntriesRemoved).toBe(0);
		expect(deleteColumn).not.toHaveBeenCalled();
		expect(await env.ACCOUNTS.get(trashKey)).toBe("{");
	});

	it("continues partial batches and retains only fresh or failed entries", async () => {
		const successfulId = crypto.randomUUID();
		const nonOkId = crypto.randomUUID();
		const thrownId = crypto.randomUUID();
		const freshId = crypto.randomUUID();
		const expiredAt = FIXED_NOW - TRASH_RETENTION_MS;
		const entries = [
			{ columnId: successfulId, deletedAt: expiredAt },
			{ columnId: nonOkId, deletedAt: expiredAt },
			{ columnId: thrownId, deletedAt: expiredAt },
			{ columnId: freshId, deletedAt: expiredAt + 1 },
		];
		const accountId = await seedTrash(entries);
		const attempted: string[] = [];

		const result = await purgeExpiredTrashedColumns({
			env,
			now: () => FIXED_NOW,
			deleteColumn: async (columnId) => {
				attempted.push(columnId);
				if (columnId === nonOkId) return new Response(null, { status: 500 });
				if (columnId === thrownId) throw new Error("injected failure");
				return Response.json({ success: true });
			},
		});

		expect(attempted).toEqual([successfulId, nonOkId, thrownId]);
		expect(result).toEqual({
			accountsScanned: 1,
			trashRecordsInvalid: 0,
			columnsPurged: 1,
			columnsFailed: 2,
			trashEntriesRemoved: 1,
		});
		expect(await loadTrash(accountId)).toEqual(entries.slice(1));
	});
});
