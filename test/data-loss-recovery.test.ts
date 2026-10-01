import { createAccountBackup, readAccountBackup } from "../src/server/account-backup";
import { restoreAccountBackup } from "../src/server/workflows/restore-account-backup";
import { accountRecordStore } from "../src/server/account-record-store";
import { env, runInDurableObject, createExecutionContext, waitOnExecutionContext, applyD1Migrations } from "cloudflare:test";
import { describe, expect, it, beforeAll } from "vitest";
import * as Y from "yjs";
import worker, { runScheduledBackups, type Bindings } from "../src/index";
import { listColumnBackups, latestColumnBackupKey } from "../src/server/backup-catalog";
import { checksumColumnBackupPayload } from "../src/server/column-backup-payload";
import { restoreColumnBackup } from "../src/server/workflows/restore-column-backup";
import { purgeExpiredTrashedColumns } from "../src/server/workflows/purge-expired-trashed-columns";
import { TRASH_RETENTION_MS } from "../src/server/persistence-records";

function fixture() {
	const accountId = "1234567890123456";
	const columnId = crypto.randomUUID();
	const meta = { schemaVersion: 1 as const, id: columnId, ownerId: accountId, sharedWith: [], publicId: null, createdAt: 1 };
	const records = new Map<string, string>([
		[`account:${accountId}`, JSON.stringify({ schemaVersion: 1, id: accountId, columnOrder: [], hiddenSharedColumns: [], createdAt: 1 })],
		[`trash:${accountId}`, JSON.stringify([{ columnId, deletedAt: 1 }])],
	]);
	const bindings = { COLUMN_ROOM: env.COLUMN_ROOM, ACCOUNTS: {
		get: async (key: string) => records.get(key) ?? null,
		put: async (key: string, value: string) => { records.set(key, value); },
		delete: async (key: string) => { records.delete(key); },
		list: async () => ({ keys: [{ name: `account:${accountId}` }], list_complete: true }),
	} };
	return { accountId, columnId, meta, records, bindings };
}

describe("data-loss recovery regressions", () => {
	beforeAll(async () => { await applyD1Migrations(env.AUTH_DB, env.TEST_AUTH_MIGRATIONS); });
	it("selects the newest snapshot beyond the first 100 R2 objects", async () => {
		const columnId = crypto.randomUUID();
		for (let n = 1; n <= 101; n++) {
			await env.BACKUPS.put(`columns/${columnId}/${String(n).padStart(13, "0")}.json`, "{}");
		}
		expect(await latestColumnBackupKey(env.BACKUPS, columnId)).toBe(`columns/${columnId}/0000000000101.json`);
		expect((await listColumnBackups(env.BACKUPS, columnId))).toHaveLength(101);
	});

	it("follows truncated pages even when R2 returns fewer than the requested limit", async () => {
		const calls: Array<string | undefined> = [];
		const bucket = { list: async (options: R2ListOptions = {}) => {
			calls.push(options.cursor);
			return options.cursor
				? { objects: [{ key: "columns/c/002.json" }], truncated: false, delimitedPrefixes: [] }
				: { objects: [{ key: "columns/c/001.json" }], truncated: true, cursor: "next", delimitedPrefixes: [] };
		} } as unknown as Pick<R2Bucket, "list">;
		expect(await latestColumnBackupKey(bucket, "c")).toBe("columns/c/002.json");
		expect(calls).toEqual([undefined, "next"]);
	});

	it("clears trash on backup restore and preserves restored content after expiry", async () => {
		const { meta, columnId, records, bindings } = fixture();
		const doc = new Y.Doc(); doc.getText("t").insert(0, "keep this");
		const base = { schemaVersion: 1 as const, columnId, snapshotAt: 2, meta, yjs: Array.from(Y.encodeStateAsUpdate(doc)) };
		const restored = await restoreColumnBackup({ env: bindings, columnId, payload: { ...base, checksum: await checksumColumnBackupPayload(base) }, createPreRestoreBackup: async () => ({ key: "pre" }) });
		expect(restored.ok).toBe(true);
		expect(JSON.parse(records.get(`trash:${meta.ownerId}`)!)).toEqual([]);
		const result = await purgeExpiredTrashedColumns({ env: bindings, now: () => TRASH_RETENTION_MS + 100 });
		expect(result.columnsPurged).toBe(0);
		const exported = await (await env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId)).fetch("http://do/export")).json() as { yjs: number[] };
		const copy = new Y.Doc(); Y.applyUpdate(copy, Uint8Array.from(exported.yjs));
		expect(copy.getText("t").toString()).toBe("keep this");
		doc.destroy(); copy.destroy();
	});

	it("never purges a live column even if an interrupted restore left expired trash", async () => {
		const { accountId, columnId, records, bindings } = fixture();
		const account = JSON.parse(records.get(`account:${accountId}`)!);
		account.columnOrder = [columnId]; records.set(`account:${accountId}`, JSON.stringify(account));
		let deletions = 0;
		const result = await purgeExpiredTrashedColumns({ env: bindings, now: () => TRASH_RETENTION_MS + 100, deleteColumn: async () => { deletions++; return Response.json({}); } });
		expect(deletions).toBe(0);
		expect(result.trashEntriesRemoved).toBe(1);
	});

	it("freezes scheduled maintenance in read-only mode", async () => {
		const executionCtx = createExecutionContext();
		// Invalid bindings deliberately prove that maintenance never starts.
		await worker.scheduled({ cron: "0 * * * *" } as ScheduledController,
			{ READ_ONLY_MODE: "true", AUTO_BACKUP_ENABLED: "true" } as Bindings, executionCtx);
		await waitOnExecutionContext(executionCtx);
		const { bindings } = fixture();
		const result = await purgeExpiredTrashedColumns({ env: { ...bindings, READ_ONLY_MODE: "true" }, now: () => TRASH_RETENTION_MS + 100 });
		expect(result.accountsScanned).toBe(0);
	});

	for (const source of ["snapshot", "update"] as const) {
		it(`preserves corrupt ${source} bytes and refuses reads, writes, and compaction`, async () => {
			const { meta, columnId } = fixture();
			const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
			await stub.fetch("http://do/init", { method: "POST", body: JSON.stringify(meta) });
			await runInDurableObject(stub, async (instance, state) => {
				if (source === "snapshot") state.storage.sql.exec("INSERT INTO yjs_snapshot VALUES (1, ?, 1)", new Uint8Array([1]).buffer);
				else state.storage.sql.exec("INSERT INTO yjs_updates (update_blob, ts) VALUES (?, 1)", new Uint8Array([1]).buffer);
				// Exercise the same loader used on activation with fresh in-memory state.
				(instance as unknown as { loadStateFromSql(): void }).loadStateFromSql();
			});
			expect((await stub.fetch("http://do/export")).status).toBe(503);
			expect((await stub.fetch("http://do/init", { method: "POST", body: JSON.stringify(meta) })).status).toBe(503);
			await runInDurableObject(stub, async (instance) => { await (instance as unknown as { alarm(): Promise<void> }).alarm(); });
			const raw = await (await stub.fetch("http://do/export-raw")).json() as { snapshot: number[] | null; updates: Array<{ bytes: number[] }> };
			expect(source === "snapshot" ? raw.snapshot : raw.updates[0]?.bytes).toEqual([1]);
			const doc = new Y.Doc(); doc.getText("t").insert(0, "recovered");
			expect((await stub.fetch("http://do/import", { method: "POST", body: JSON.stringify({ meta, yjs: Array.from(Y.encodeStateAsUpdate(doc)) }) })).status).toBe(200);
			expect((await stub.fetch("http://do/export")).status).toBe(200);
			doc.destroy();
		});
	}
	it("rotates capped backups across active, trashed and registered orphan columns", async () => {
		const accountId = "2345678901234567";
		const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort();
		const records = accountRecordStore(env);
		await records.put(`account:${accountId}`, JSON.stringify({ schemaVersion: 1, id: accountId, columnOrder: [ids[0]], hiddenSharedColumns: [], createdAt: 1 }));
		await records.put(`trash:${accountId}`, JSON.stringify([{ columnId: ids[1], deletedAt: 1 }]));
		for (const id of ids) {
			const meta = { schemaVersion: 1, id, ownerId: accountId, sharedWith: [], publicId: null, createdAt: 1 };
			await env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(id)).fetch("http://do/init", { method: "POST", body: JSON.stringify(meta) });
			await env.ACCOUNTS.put(`column-registry:${id}`, JSON.stringify(meta));
		}
		for (let n = 0; n < 3; n++) {
			const result = await runScheduledBackups({ ...env, BACKUP_MAX_COLUMNS: "1" });
			expect(result).toMatchObject({ columnsDiscovered: 3, columnsSelected: 1, backedUp: 1, accountsBackedUp: 1, failed: 0 });
		}
		for (const id of ids) expect(await latestColumnBackupKey(env.BACKUPS, id)).not.toBeNull();
		const backup = await readAccountBackup(env, accountId);
		expect(backup?.columnIds).toEqual(ids);
	});

	it("recovers a missing account, column and passkey from independent backups", async () => {
		const accountId = "3456789012345678", columnId = crypto.randomUUID();
		const records = accountRecordStore(env);
		const account = JSON.stringify({ schemaVersion: 1, id: accountId, columnOrder: [columnId], hiddenSharedColumns: [], createdAt: 1 });
		await records.put(`account:${accountId}`, account);
		await env.AUTH_DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, 1, 1)').bind(accountId, "Recovered", `${accountId}@accounts.invalid`).run();
		await env.AUTH_DB.prepare('INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp) VALUES (?, ?, ?, ?, 0, ?, 0)').bind("recovery-key", "public", accountId, "credential", "singleDevice").run();
		const meta = { schemaVersion: 1 as const, id: columnId, ownerId: accountId, sharedWith: [], publicId: null, createdAt: 1 };
		const doc = new Y.Doc(); doc.getText("t").insert(0, "Recovered content");
		const base = { schemaVersion: 1 as const, columnId, snapshotAt: Date.now(), meta, yjs: Array.from(Y.encodeStateAsUpdate(doc)) };
		await env.BACKUPS.put(`columns/${columnId}/9999999999999.json`, JSON.stringify({ ...base, checksum: await checksumColumnBackupPayload(base) }));
		const snapshot = await createAccountBackup(env, accountId);
		expect(snapshot).not.toBeNull();
		await records.delete(`account:${accountId}`);
		await env.AUTH_DB.prepare('DELETE FROM "user" WHERE id = ?').bind(accountId).run();
		const verified = await readAccountBackup(env, accountId, snapshot!.key);
		await restoreAccountBackup(env, verified!, async () => ({ key: null }));
		expect(await records.get(`account:${accountId}`)).toBe(account);
		expect(await env.AUTH_DB.prepare('SELECT publicKey FROM passkey WHERE userId = ?').bind(accountId).first()).toEqual({ publicKey: "public" });
		const exported = await (await env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId)).fetch("http://do/export")).json() as { yjs: number[] };
		const copy = new Y.Doc(); Y.applyUpdate(copy, Uint8Array.from(exported.yjs));
		expect(copy.getText("t").toString()).toBe("Recovered content");
		copy.destroy(); doc.destroy();
	});

	it("validates a complete account inventory before replacing live columns", async () => {
		const { accountId, columnId, meta } = fixture();
		const records = accountRecordStore(env);
		await records.put(`account:${accountId}`, JSON.stringify({ schemaVersion: 1, id: accountId, columnOrder: [columnId], hiddenSharedColumns: [], createdAt: 1 }));
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		await stub.fetch("http://do/init", { method: "POST", body: JSON.stringify(meta) });
		const snapshot = await createAccountBackup(env, accountId);
		let preBackups = 0;
		await expect(restoreAccountBackup(env, snapshot!.payload, async () => { preBackups++; return { key: "pre" }; })).rejects.toThrow("missing_column_backup");
		expect(preBackups).toBe(0);
		expect((await stub.fetch("http://do/export")).ok).toBe(true);
	});

	it("refuses a stale purge after import activates a column and repairs its registry", async () => {
		const { meta, columnId, bindings, records } = fixture();
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		await stub.fetch("http://do/import", { method: "POST", body: JSON.stringify({ meta, yjs: [0, 0] }) });
		const result = await purgeExpiredTrashedColumns({ env: bindings, now: () => TRASH_RETENTION_MS + 100 });
		expect(result.columnsPurged).toBe(0);
		expect(result.columnsFailed).toBe(1);
		expect((await stub.fetch("http://do/export")).ok).toBe(true);
		expect(JSON.parse(records.get(`column-registry:${columnId}`)!)).toEqual(meta);
	});

	it("keeps expired trash intact when the final backup fails", async () => {
		const { bindings, records, accountId } = fixture();
		let deleted = false;
		const result = await purgeExpiredTrashedColumns({ env: bindings, now: () => TRASH_RETENTION_MS + 100,
			beforeDelete: async () => { throw new Error("R2 unavailable"); },
			deleteColumn: async () => { deleted = true; return Response.json({}); },
		});
		expect(deleted).toBe(false);
		expect(result.columnsFailed).toBe(1);
		expect(JSON.parse(records.get(`trash:${accountId}`)!)).toHaveLength(1);
	});

});
