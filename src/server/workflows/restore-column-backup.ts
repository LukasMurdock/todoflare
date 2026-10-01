import { normalizeAccountId } from "../../lib/account";
import { normalizeAccountIdSet } from "../../lib/column-access";
import type { ColumnMeta } from "../../types/account";
import {
	checksumColumnBackupPayload,
	type ColumnBackupPayload,
} from "../column-backup-payload";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import { registerColumn } from "../lifecycle-journal";
import { claimPublicId, releasePublicId } from "../public-id-registry";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseSharedColumnIndex,
	parseDeletedColumnRecords,
} from "../persistence-records";

export type { ColumnBackupPayload } from "../column-backup-payload";

export type RestoreColumnBackupWriteBoundary =
	| "pre-restore-backup"
	| "column-import"
	| "owner-account"
	| "trash"
	| `shared-account:${string}`
	| "old-public-mapping"
	| "public-mapping";

export interface RestoreColumnBackupBindings<TColumnRoomId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	PUBLIC_ID_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	COLUMN_ROOM: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
}

export interface RestoreColumnBackupInput<TColumnRoomId> {
	env: RestoreColumnBackupBindings<TColumnRoomId>;
	columnId: string;
	payload: ColumnBackupPayload;
	createPreRestoreBackup: () => Promise<{ key: string | null }>;
	trashedAt?: number;
	afterWrite?: (
		boundary: RestoreColumnBackupWriteBoundary,
	) => void | Promise<void>;
}

export type RestoreColumnBackupResult =
	| { ok: true; meta: ColumnMeta; preRestoreBackupKey: string | null }
	| {
			ok: false;
			code:
				| "invalid_backup_payload"
				| "backup_checksum_mismatch"
				| "column_meta_invalid"
				| "invalid_yjs_update"
				| "pre_restore_backup_failed"
				| "restore_failed"
				| "account_invalid"
				| "shared_index_invalid";
	  };

/** Restores authoritative DO state, then repairs every KV access projection. */
export async function restoreColumnBackup<TColumnRoomId>(
	input: RestoreColumnBackupInput<TColumnRoomId>,
): Promise<RestoreColumnBackupResult> {
	const { env, columnId, payload, afterWrite } = input;
	const records = accountRecordStore(env);
	if (payload.schemaVersion !== 1 || payload.columnId !== columnId) {
		return { ok: false, code: "invalid_backup_payload" };
	}
	const { checksum, ...basePayload } = payload;
	if ((await checksumColumnBackupPayload(basePayload)) !== checksum) {
		return { ok: false, code: "backup_checksum_mismatch" };
	}
	const parsedBackupMeta = parseColumnMetaRecord(payload.meta);
	if (!parsedBackupMeta.ok) return { ok: false, code: "column_meta_invalid" };
	const backupMeta = parsedBackupMeta.value;

	const ownerId = normalizeAccountId(backupMeta.ownerId);
	const trashKey = `trash:${ownerId}`;
	const trash = parseDeletedColumnRecords(await records.get(trashKey));
	if (!trash.ok) return { ok: false, code: "account_invalid" };

	let preRestoreBackup: { key: string | null };
	try {
		preRestoreBackup = await input.createPreRestoreBackup();
	} catch {
		return { ok: false, code: "pre_restore_backup_failed" };
	}
	await afterWrite?.("pre-restore-backup");

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const currentResponse = await stub.fetch(new Request("http://do/meta"));
	let currentMeta: ColumnMeta | null = null;
	if (!currentResponse.ok && ![404, 503].includes(currentResponse.status)) {
		return { ok: false, code: "restore_failed" };
	}
	if (currentResponse.ok) {
		const parsedCurrent = parseColumnMetaRecord(await currentResponse.json());
		if (!parsedCurrent.ok) return { ok: false, code: "column_meta_invalid" };
		currentMeta = parsedCurrent.value;
	}
	if (
		backupMeta.publicId &&
		!(await claimPublicId(env, backupMeta.publicId, columnId))
	) {
		return { ok: false, code: "restore_failed" };
	}

	const imported = await stub.fetch(
		new Request("http://do/import", {
			method: "POST",
			body: JSON.stringify({ meta: backupMeta, yjs: payload.yjs, trashedAt: input.trashedAt }),
		}),
	);
	if (!imported.ok) {
		if (backupMeta.publicId && currentMeta?.publicId !== backupMeta.publicId) {
			await releasePublicId(env, backupMeta.publicId, columnId);
		}
		return {
			ok: false,
			code: imported.status === 422 ? "invalid_yjs_update" : "restore_failed",
		};
	}
	await afterWrite?.("column-import");
	await registerColumn(env.ACCOUNTS, backupMeta);

	const ownerKey = `account:${ownerId}`;
	const ownerRaw = await records.get(ownerKey);
	if (ownerRaw) {
		const parsedOwner = parseAccountRecord(ownerRaw);
		if (!parsedOwner.ok) return { ok: false, code: "account_invalid" };
		if (input.trashedAt === undefined && !parsedOwner.value.columnOrder.includes(columnId)) {
			await mutateAccountRecord(env, ownerKey, {
				kind: "account-add-column",
				columnId,
			});
			await afterWrite?.("owner-account");
		}
	}

	// Remove the deletion commit record after the restored owner membership
	// exists. Purge also checks active membership to protect interrupted restores.
	if (input.trashedAt === undefined) {
		await mutateAccountRecord(env, trashKey, { kind: "trash-remove", columnId });
		await afterWrite?.("trash");
	}

	const desiredShared = normalizeAccountIdSet(backupMeta.sharedWith);
	const previousShared = normalizeAccountIdSet(currentMeta?.sharedWith ?? []);
	for (const accountId of new Set([...desiredShared, ...previousShared])) {
		const key = `shared:${accountId}`;
		const parsedIndex = parseSharedColumnIndex(await records.get(key));
		if (!parsedIndex.ok) return { ok: false, code: "shared_index_invalid" };
		const next = desiredShared.has(accountId)
			? Array.from(new Set([...parsedIndex.value, columnId]))
			: parsedIndex.value.filter((id) => id !== columnId);
		if (JSON.stringify(next) !== JSON.stringify(parsedIndex.value)) {
			await mutateAccountRecord(env, key, {
				kind: desiredShared.has(accountId) ? "shared-add" : "shared-remove",
				columnId,
			});
			await afterWrite?.(`shared-account:${accountId}`);
		}
	}

	if (currentMeta?.publicId && currentMeta.publicId !== backupMeta.publicId) {
		await releasePublicId(env, currentMeta.publicId, columnId);
		await afterWrite?.("old-public-mapping");
	}
	if (backupMeta.publicId) {
		await afterWrite?.("public-mapping");
	}

	return {
		ok: true,
		meta: backupMeta,
		preRestoreBackupKey: preRestoreBackup.key,
	};
}
