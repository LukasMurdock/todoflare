import * as Y from "yjs";
import type { Bindings } from "../../index";
import { normalizeAccountId } from "../../lib/account";
import { createAccountBackup, restoreAccountCredentials, type AccountBackup } from "../account-backup";
import { accountRecordStore } from "../account-record-store";
import { latestColumnBackupKey } from "../backup-catalog";
import { parseAndVerifyColumnBackup, MAX_YJS_UPDATE_BYTES, type ColumnBackupPayload } from "../column-backup-payload";
import { parseDeletedColumnRecords } from "../persistence-records";
import { restoreColumnBackup } from "./restore-column-backup";

/** Requires a deployed write freeze; cross-DO recovery is retryable, not atomic. */
export async function restoreAccountBackup(
	env: Bindings,
	backup: AccountBackup,
	createPreRestoreBackup: (columnId: string) => Promise<{ key: string | null }>,
) {
	if (!env.BACKUPS) throw new Error("backup_not_configured");
	const snapshots = new Map<string, ColumnBackupPayload>();
	// Validate the entire recovery inventory before replacing any live state.
	for (const columnId of backup.columnIds) {
		const key = await latestColumnBackupKey(env.BACKUPS, columnId);
		const object = key ? await env.BACKUPS.get(key) : null;
		if (!object) throw new Error(`missing_column_backup:${columnId}`);
		if (object.size > MAX_YJS_UPDATE_BYTES * 5) throw new Error(`invalid_column_backup:${columnId}`);
		const verified = await parseAndVerifyColumnBackup(await object.text(), columnId);
		if (!verified.ok || normalizeAccountId(verified.payload.meta.ownerId) !== backup.accountId) throw new Error(`invalid_column_backup:${columnId}`);
		const doc = new Y.Doc();
		try { if (verified.payload.yjs) Y.applyUpdate(doc, Uint8Array.from(verified.payload.yjs)); }
		finally { doc.destroy(); }
		snapshots.set(columnId, verified.payload);
	}
	await createAccountBackup(env, backup.accountId, [], "pre-restore/accounts");
	const preRestore = new Map<string, { key: string | null }>();
	for (const columnId of snapshots.keys()) preRestore.set(columnId, await createPreRestoreBackup(columnId));
	const trash = parseDeletedColumnRecords(backup.trash);
	if (!trash.ok) throw new Error("account_backup_invalid_trash");
	const restoredColumns: string[] = [];
	for (const [columnId, payload] of snapshots) {
		const result = await restoreColumnBackup({ env, columnId, payload,
			trashedAt: trash.value.find(row => row.columnId === columnId)?.deletedAt,
			createPreRestoreBackup: async () => preRestore.get(columnId)!,
		});
		if (!result.ok) throw new Error(`column_restore_failed:${columnId}:${result.code}`);
		restoredColumns.push(columnId);
	}
	await restoreAccountCredentials(env, backup);
	const records = accountRecordStore(env);
	await records.put(`account:${backup.accountId}`, backup.account);
	for (const [prefix, value] of [["shared", backup.sharedIndex], ["trash", backup.trash]] as const) {
		if (value === null) await records.delete(`${prefix}:${backup.accountId}`);
		else await records.put(`${prefix}:${backup.accountId}`, value);
	}
	return { success: true, accountId: backup.accountId, restoredColumns };
}
