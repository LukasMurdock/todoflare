import { normalizeAccountId } from "../../lib/account";
import { normalizeAccountIdSet } from "../../lib/column-access";
import type { ColumnMeta } from "../../types/account";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseSharedColumnIndex,
} from "../persistence-records";

export type ColumnBackupPayload = {
	schemaVersion: 1;
	columnId: string;
	snapshotAt: number;
	checksum: string;
	meta: ColumnMeta;
	yjs: number[] | null;
};

export type RestoreColumnBackupWriteBoundary =
	| "pre-restore-backup"
	| "column-import"
	| "owner-account"
	| `shared-account:${string}`
	| "old-public-mapping"
	| "public-mapping";

export interface RestoreColumnBackupBindings<TColumnRoomId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
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
	createPreRestoreBackup: () => Promise<{ key: string }>;
	afterWrite?: (
		boundary: RestoreColumnBackupWriteBoundary,
	) => void | Promise<void>;
}

export type RestoreColumnBackupResult =
	| { ok: true; meta: ColumnMeta; preRestoreBackupKey: string }
	| {
			ok: false;
			code:
				| "invalid_backup_payload"
				| "backup_checksum_mismatch"
				| "column_meta_invalid"
				| "pre_restore_backup_failed"
				| "restore_failed"
				| "account_invalid"
				| "shared_index_invalid";
	  };

async function checksumForPayload(payload: ColumnBackupPayload): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify({
			schemaVersion: payload.schemaVersion,
			columnId: payload.columnId,
			snapshotAt: payload.snapshotAt,
			meta: payload.meta,
			yjs: payload.yjs,
		}),
	);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Restores authoritative DO state, then repairs every KV access projection. */
export async function restoreColumnBackup<TColumnRoomId>(
	input: RestoreColumnBackupInput<TColumnRoomId>,
): Promise<RestoreColumnBackupResult> {
	const { env, columnId, payload, afterWrite } = input;
	if (payload.schemaVersion !== 1 || payload.columnId !== columnId) {
		return { ok: false, code: "invalid_backup_payload" };
	}
	if ((await checksumForPayload(payload)) !== payload.checksum) {
		return { ok: false, code: "backup_checksum_mismatch" };
	}
	const parsedBackupMeta = parseColumnMetaRecord(payload.meta);
	if (!parsedBackupMeta.ok) return { ok: false, code: "column_meta_invalid" };
	const backupMeta = parsedBackupMeta.value;

	let preRestoreBackup: { key: string };
	try {
		preRestoreBackup = await input.createPreRestoreBackup();
	} catch {
		return { ok: false, code: "pre_restore_backup_failed" };
	}
	await afterWrite?.("pre-restore-backup");

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const currentResponse = await stub.fetch(new Request("http://do/meta"));
	let currentMeta: ColumnMeta | null = null;
	if (currentResponse.ok) {
		const parsedCurrent = parseColumnMetaRecord(await currentResponse.json());
		if (!parsedCurrent.ok) return { ok: false, code: "column_meta_invalid" };
		currentMeta = parsedCurrent.value;
	}

	const imported = await stub.fetch(
		new Request("http://do/import", {
			method: "POST",
			body: JSON.stringify({ meta: backupMeta, yjs: payload.yjs }),
		}),
	);
	if (!imported.ok) return { ok: false, code: "restore_failed" };
	await afterWrite?.("column-import");

	const ownerId = normalizeAccountId(backupMeta.ownerId);
	const ownerKey = `account:${ownerId}`;
	const ownerRaw = await env.ACCOUNTS.get(ownerKey);
	if (ownerRaw) {
		const parsedOwner = parseAccountRecord(ownerRaw);
		if (!parsedOwner.ok) return { ok: false, code: "account_invalid" };
		if (!parsedOwner.value.columnOrder.includes(columnId)) {
			parsedOwner.value.columnOrder.push(columnId);
			await env.ACCOUNTS.put(ownerKey, JSON.stringify(parsedOwner.value));
			await afterWrite?.("owner-account");
		}
	}

	const desiredShared = normalizeAccountIdSet(backupMeta.sharedWith);
	const previousShared = normalizeAccountIdSet(currentMeta?.sharedWith ?? []);
	for (const accountId of new Set([...desiredShared, ...previousShared])) {
		const key = `shared:${accountId}`;
		const parsedIndex = parseSharedColumnIndex(await env.ACCOUNTS.get(key));
		if (!parsedIndex.ok) return { ok: false, code: "shared_index_invalid" };
		const next = desiredShared.has(accountId)
			? Array.from(new Set([...parsedIndex.value, columnId]))
			: parsedIndex.value.filter((id) => id !== columnId);
		if (JSON.stringify(next) !== JSON.stringify(parsedIndex.value)) {
			await env.ACCOUNTS.put(key, JSON.stringify(next));
			await afterWrite?.(`shared-account:${accountId}`);
		}
	}

	if (currentMeta?.publicId && currentMeta.publicId !== backupMeta.publicId) {
		await env.ACCOUNTS.delete(`public:${currentMeta.publicId}`);
		await afterWrite?.("old-public-mapping");
	}
	if (backupMeta.publicId) {
		await env.ACCOUNTS.put(`public:${backupMeta.publicId}`, columnId);
		await afterWrite?.("public-mapping");
	}

	return {
		ok: true,
		meta: backupMeta,
		preRestoreBackupKey: preRestoreBackup.key,
	};
}
