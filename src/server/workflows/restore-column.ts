import { normalizeAccountId } from "../../lib/account";
import { isColumnOwner } from "../../lib/column-access";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import type { ColumnMeta } from "../../types/account";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	TRASH_RETENTION_MS,
} from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type RestoreColumnWriteBoundary = "owner-account" | "trash";

export interface RestoreColumnInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	now?: () => number;
	afterWrite?: ColumnLifecycleWriteObserver<RestoreColumnWriteBoundary>;
}

export interface RestoreColumnOutput {
	success: true;
	column: ColumnMeta;
}

/**
 * Restores the account projection before removing the trash commit record.
 *
 * The trash entry authorizes a normal restore. If a retry finds the column already in
 * the owner's order and absent from trash, the prior attempt crossed its final write
 * boundary, so the completed result is reconstructed from authoritative DO metadata.
 */
export async function restoreColumn<TColumnRoomId>(
	input: RestoreColumnInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<RestoreColumnOutput>> {
	const { env, columnId, accountId, afterWrite } = input;
	const records = accountRecordStore(env);
	const now = input.now ?? Date.now;
	const normalizedAccountId = normalizeAccountId(accountId);
	const accountKey = `account:${normalizedAccountId}`;
	const accountData = await records.get(accountKey);
	if (!accountData) return lifecycleNotFound("Account not found");

	const parsedAccount = parseAccountRecord(accountData);
	if (!parsedAccount.ok) {
		return {
			ok: false,
			failure: { kind: "schema", record: "account", result: parsedAccount },
		};
	}
	const account = parsedAccount.value;
	const trashKey = `trash:${normalizedAccountId}`;
	const trashRaw = await records.get(trashKey);
	const parsedTrash = parseDeletedColumnRecords(trashRaw);
	if (!parsedTrash.ok) {
		return {
			ok: false,
			failure: { kind: "schema", record: "trash", result: parsedTrash },
		};
	}
	const trash = parsedTrash.value;
	const entry = trash.find((item) => item.columnId === columnId);

	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const loadMeta = async (): Promise<ColumnLifecycleResult<ColumnMeta>> => {
		const metaResponse = await stub.fetch(new Request("http://do/meta"));
		if (!metaResponse.ok) return lifecycleNotFound("Column not found");
		const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
		if (!parsedMeta.ok) {
			return {
				ok: false,
				failure: {
					kind: "schema",
					record: "column_meta",
					result: parsedMeta,
				},
			};
		}
		return { ok: true, value: parsedMeta.value };
	};

	if (!entry) {
		if (!account.columnOrder.includes(columnId)) {
			return lifecycleNotFound("Column not in garbage can");
		}

		const completedMeta = await loadMeta();
		if (!completedMeta.ok) return completedMeta;
		if (!isColumnOwner(completedMeta.value, accountId)) {
			return lifecycleNotFound("Column not in garbage can");
		}
		return { ok: true, value: { success: true, column: completedMeta.value } };
	}

	if (now() - entry.deletedAt >= TRASH_RETENTION_MS) {
		return lifecycleNotFound("Column expired", 410);
	}

	const loadedMeta = await loadMeta();
	if (!loadedMeta.ok) return loadedMeta;
	const meta = loadedMeta.value;
	if (!isColumnOwner(meta, accountId)) {
		return {
			ok: false,
			failure: { kind: "owner", meta, message: "Only owner can restore" },
		};
	}

	if (!account.columnOrder.includes(columnId)) {
		await mutateAccountRecord(env, accountKey, {
			kind: "account-add-column",
			columnId,
		});
		await afterWrite?.("owner-account");
	}

	await mutateAccountRecord(env, trashKey, { kind: "trash-remove", columnId });
	await afterWrite?.("trash");

	return { ok: true, value: { success: true, column: meta } };
}
