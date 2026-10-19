import { mapWithConcurrency } from "./bounded-concurrency";
import { createAccountBackup } from "./account-backup";
import type { ColumnMeta } from "../types/account";
import { normalizeAccountId } from "../lib/account";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
} from "./persistence-records";
import { restoreColumnBackup, type ColumnBackupPayload } from "./workflows/restore-column-backup";
import {
	checksumColumnBackupPayload,
	MAX_YJS_UPDATE_BYTES,
	parseAndVerifyColumnBackup,
	yjsBytesSchema,
} from "./column-backup-payload";
import { accountRecordStore, mutateAccountRecord } from "./account-record-store";
import { type Bindings } from "./bindings";

export const MAX_BACKUP_OBJECT_BYTES = MAX_YJS_UPDATE_BYTES * 4 + 1_000_000;

export function backupObjectKey(columnId: string, timestampMs: number): string {
	return `columns/${columnId}/${timestampMs.toString().padStart(13, "0")}.json`;
}

export function isAutoBackupEnabled(env: Bindings): boolean {
	return env.AUTO_BACKUP_ENABLED === "true" || env.AUTO_BACKUP_ENABLED === "1";
}

export function parseBackupMaxColumns(env: Bindings): number {
	const parsed = Number(env.BACKUP_MAX_COLUMNS ?? "1000");
	if (!Number.isFinite(parsed) || parsed <= 0) return 1000;
	return Math.min(Math.floor(parsed), 10_000);
}

export async function restoreColumnFromBackupPayload(
	env: Bindings,
	columnId: string,
	payload: ColumnBackupPayload,
) {
	return restoreColumnBackup({
		env,
		columnId,
		payload,
		createPreRestoreBackup: () => createPreRestoreColumnBackup(env, columnId),
	});
}

export async function readAndVerifyColumnBackup(
	object: R2ObjectBody,
	columnId: string,
) {
	if (object.size > MAX_BACKUP_OBJECT_BYTES) {
		return { ok: false as const, code: "invalid_backup_payload" as const };
	}
	return parseAndVerifyColumnBackup(await object.text(), columnId);
}

export async function rebuildSharedIndexesForColumns(env: Bindings, columns: ColumnMeta[]) {
	const byAccount = new Map<string, Set<string>>();

	for (const meta of columns) {
		for (const sharedAccountId of meta.sharedWith) {
			const normalized = normalizeAccountId(sharedAccountId);
			if (!byAccount.has(normalized)) {
				byAccount.set(normalized, new Set<string>());
			}
			byAccount.get(normalized)!.add(meta.id);
		}
	}

	for (const [normalizedAccountId, expectedColumnsSet] of byAccount) {
		const sharedColumnsData = await accountRecordStore(env).get(`shared:${normalizedAccountId}`);
		const parsedExistingColumns = parseSharedColumnIndex(sharedColumnsData);
		if (!parsedExistingColumns.ok) {
			throw new Error(
				`Invalid shared index for account ${normalizedAccountId}`,
			);
		}
		const existingColumns = parsedExistingColumns.value;

		for (const columnId of expectedColumnsSet) {
			if (!existingColumns.includes(columnId)) {
				await mutateAccountRecord(env, `shared:${normalizedAccountId}`, {
					kind: "shared-add",
					columnId,
				});
			}
		}
	}
}

export async function createColumnBackupSnapshot(env: Bindings, columnId: string, prefix = "columns") {
	if (!env.BACKUPS) {
		throw new Error("backup_not_configured");
	}

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const exportResponse = await stub.fetch(new Request("http://do/export"));

	if (exportResponse.status === 503) {
		// Keep an independent copy of undecodable storage before any recovery
		// replaces it. It is diagnostic data, never a valid document snapshot.
		const raw = await stub.fetch(new Request("http://do/export-raw"));
		if (!raw.ok) throw new Error("raw_column_backup_failed");
		const snapshotAt = Date.now();
		const key = `raw-columns/${columnId}/${snapshotAt}.json`;
		const bytes = await raw.text();
		await env.BACKUPS.put(key, bytes, { httpMetadata: { contentType: "application/json" } });
		return { key, snapshotAt, checksum: "raw-recovery-source" };
	}
	if (!exportResponse.ok) {
		throw new Error("column_not_found");
	}

	const exported = (await exportResponse.json()) as {
		meta: unknown;
		yjs: unknown;
	};
	const parsedMeta = parseColumnMetaRecord(exported.meta);
	if (!parsedMeta.ok || parsedMeta.value.id !== columnId) {
		throw new Error("column_meta_invalid");
	}
	const parsedYjs = yjsBytesSchema.safeParse(exported.yjs);
	if (!parsedYjs.success) {
		throw new Error("column_yjs_invalid");
	}

	const snapshotAt = Date.now();
	const key = prefix === "columns" ? backupObjectKey(columnId, snapshotAt) : `${prefix}/${columnId}/${snapshotAt}-${crypto.randomUUID()}.json`;

	const basePayload = {
		schemaVersion: 1 as const,
		columnId,
		snapshotAt,
		meta: parsedMeta.value,
		yjs: parsedYjs.data,
	};

	const checksum = await checksumColumnBackupPayload(basePayload);
	const payload: ColumnBackupPayload = { ...basePayload, checksum };

	await env.BACKUPS.put(key, JSON.stringify(payload), {
		httpMetadata: { contentType: "application/json" },
		customMetadata: {
			columnId,
			snapshotAt: String(snapshotAt),
			checksum,
		},
	});

	return { key, snapshotAt, checksum };
}

export async function createPreRestoreColumnBackup(env: Bindings, columnId: string) {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const current = await stub.fetch(new Request("http://do/meta"));
	if (current.status === 404) return { key: null };
	return createColumnBackupSnapshot(env, columnId, "pre-restore/columns");
}

/** Concurrent KV and Durable Object reads per scan; keeps scans from scaling with sequential round trips. */
const INVENTORY_READ_CONCURRENCY = 16;
/** Concurrent account and column backups in a scheduled run (each writes to R2). */
const BACKUP_CONCURRENCY = 6;

async function listKeys(env: Bindings, prefix: string): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.ACCOUNTS.list({ prefix, cursor, limit: 1000 });
		names.push(...page.keys.map((key) => key.name));
		if (page.list_complete) break;
		cursor = page.cursor;
	} while (cursor);
	return names;
}

/** Every registered column and its owner, from the column registry alone. */
export async function collectRegisteredColumns(env: Bindings) {
	const keys = await listKeys(env, "column-registry:");
	const metas = await mapWithConcurrency(keys, INVENTORY_READ_CONCURRENCY, async (key) => {
		const raw = await env.ACCOUNTS.get(key);
		if (!raw) return null;
		try {
			const meta = parseColumnMetaRecord(JSON.parse(raw));
			return meta.ok ? meta.value : "invalid";
		} catch {
			return "invalid";
		}
	});
	const columnsByOwner = new Map<string, string[]>();
	const columnIds: string[] = [];
	let invalid = 0;
	for (const meta of metas) {
		if (meta === null) continue;
		if (meta === "invalid") { invalid++; continue; }
		columnIds.push(meta.id);
		const ownerId = normalizeAccountId(meta.ownerId);
		columnsByOwner.set(ownerId, [...(columnsByOwner.get(ownerId) ?? []), meta.id]);
	}
	return { columnIds, columnsByOwner, invalid };
}

/** Every account and column known to storage, for the scheduled full backup. */
export async function collectBackupInventory(env: Bindings) {
	const columnIds = new Set<string>();
	const accountIds: string[] = [];
	let invalidAccounts = 0;
	const records = accountRecordStore(env);
	const accountKeys = await listKeys(env, "account:");
	const accounts = await mapWithConcurrency(accountKeys, INVENTORY_READ_CONCURRENCY, async (key) => {
		const id = key.slice("account:".length);
		const raw = await records.get(key);
		const account = raw === null ? null : parseAccountRecord(raw);
		const trash = parseDeletedColumnRecords(await records.get(`trash:${id}`));
		return { id, account, trash };
	});
	for (const { id, account, trash } of accounts) {
		if (!account?.ok || !trash.ok) { invalidAccounts++; continue; }
		accountIds.push(id);
		for (const columnId of [...account.value.columnOrder, ...trash.value.map(row => row.columnId)]) columnIds.add(columnId);
	}
	const registered = await collectRegisteredColumns(env);
	for (const columnId of registered.columnIds) columnIds.add(columnId);
	invalidAccounts += registered.invalid;
	return { columnIds: Array.from(columnIds).sort(), columnsByOwner: registered.columnsByOwner, accountIds, invalidAccounts };
}

export async function runScheduledBackups(env: Bindings) {
	if (!env.BACKUPS) return { skipped: true, reason: "backup_not_configured" as const };
	const inventory = await collectBackupInventory(env);
	const stateObject = await env.BACKUPS.get("backup-state.json");
	const state = stateObject ? await stateObject.json<{ afterColumnId?: string }>() : {};
	const after = state.afterColumnId ?? "";
	const split = inventory.columnIds.findIndex(id => id > after);
	const ordered = split < 0 ? inventory.columnIds : [...inventory.columnIds.slice(split), ...inventory.columnIds.slice(0, split)];
	const selected = ordered.slice(0, parseBackupMaxColumns(env));
	let backedUp = 0, failed = 0, accountsBackedUp = 0, rawCopies = 0;
	// Backups of different accounts and columns are independent; running a few at
	// once keeps a run's duration from growing with sequential round trips.
	await mapWithConcurrency(inventory.accountIds, BACKUP_CONCURRENCY, async (accountId) => {
		try { await createAccountBackup(env, accountId, inventory.columnsByOwner.get(accountId)); accountsBackedUp++; }
		catch { failed++; }
	});
	await mapWithConcurrency(selected, BACKUP_CONCURRENCY, async (columnId) => {
		try {
			const snapshot = await createColumnBackupSnapshot(env, columnId);
			if (snapshot.checksum === "raw-recovery-source") { rawCopies++; failed++; } else backedUp++;
		}
		catch { failed++; }
	});
	const result = {
		skipped: false, completedAt: Date.now(),
		columnsDiscovered: inventory.columnIds.length, columnsSelected: selected.length,
		backedUp, accountsBackedUp, rawCopies, failed, invalidAccounts: inventory.invalidAccounts,
		afterColumnId: selected.at(-1) ?? after,
	};
	await env.BACKUPS.put("backup-state.json", JSON.stringify(result));
	env.LIFECYCLE_METRICS?.writeDataPoint({ indexes: ["scheduled-backups"], doubles: [result.columnsDiscovered, backedUp, accountsBackedUp, failed, result.invalidAccounts] });
	return result;
}
