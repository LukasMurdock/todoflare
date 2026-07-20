import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
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
	const accountId = crypto.randomUUID().replaceAll("-", "");
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
			columnsPurged: 1,
			columnsFailed: 2,
			trashEntriesRemoved: 1,
		});
		expect(await loadTrash(accountId)).toEqual(entries.slice(1));
	});
});
