import { normalizeAccountId } from "../../lib/account";
import { isColumnOwner } from "../../lib/column-access";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import { releasePublicId } from "../public-id-registry";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
	TRASH_RETENTION_MS,
} from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type DeleteColumnWriteBoundary =
	| "owner-account"
	| `shared-account:${string}`
	| "public-mapping"
	| "column-shares"
	| "column-public"
	| "trash";

export interface DeleteColumnInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	now?: () => number;
	afterWrite?: ColumnLifecycleWriteObserver<DeleteColumnWriteBoundary>;
}

export interface DeleteColumnOutput {
	success: true;
	trashed: true;
	deleteAfter: number;
}

/**
 * Moves an owned column into trash while removing every access projection.
 *
 * The Durable Object metadata is authoritative for ownership and access. KV account,
 * shared, and public records are projections. Projection removals deliberately happen
 * before the matching metadata is cleared, so a retry can rediscover and repair them.
 * Trash is the commit record and is written last. Every mutation is idempotent.
 */
export async function deleteColumn<TColumnRoomId>(
	input: DeleteColumnInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<DeleteColumnOutput>> {
	const { env, columnId, accountId, afterWrite } = input;
	const records = accountRecordStore(env);
	const now = input.now ?? Date.now;
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const metaResponse = await stub.fetch(new Request("http://do/meta"));

	if (!metaResponse.ok) return lifecycleNotFound("Column not found");

	const parsedMeta = parseColumnMetaRecord(await metaResponse.json());
	if (!parsedMeta.ok) {
		return {
			ok: false,
			failure: { kind: "schema", record: "column_meta", result: parsedMeta },
		};
	}
	const meta = parsedMeta.value;

	if (!isColumnOwner(meta, accountId)) {
		return {
			ok: false,
			failure: { kind: "owner", meta, message: "Only owner can delete" },
		};
	}

	const normalizedOwnerId = normalizeAccountId(meta.ownerId);
	const ownerKey = `account:${normalizedOwnerId}`;
	const trashKey = `trash:${normalizedOwnerId}`;
	const parsedTrash = parseDeletedColumnRecords(await records.get(trashKey));
	if (!parsedTrash.ok) {
		return {
			ok: false,
			failure: { kind: "schema", record: "trash", result: parsedTrash },
		};
	}
	const ownerData = await records.get(ownerKey);
	if (ownerData) {
		const parsedOwner = parseAccountRecord(ownerData);
		if (!parsedOwner.ok) {
			return {
				ok: false,
				failure: { kind: "schema", record: "account", result: parsedOwner },
			};
		}
		await mutateAccountRecord(env, ownerKey, {
			kind: "account-remove-column",
			columnId,
		});
		await afterWrite?.("owner-account");
	}

	for (const sharedAccountId of meta.sharedWith) {
		const normalizedSharedId = normalizeAccountId(sharedAccountId);
		const sharedKey = `shared:${normalizedSharedId}`;
		const sharedColumnsData = await records.get(sharedKey);
		if (!sharedColumnsData) continue;

		const parsedSharedColumns = parseSharedColumnIndex(sharedColumnsData);
		if (!parsedSharedColumns.ok) {
			return {
				ok: false,
				failure: {
					kind: "schema",
					record: "shared_index",
					result: parsedSharedColumns,
				},
			};
		}
		await mutateAccountRecord(env, sharedKey, { kind: "shared-remove", columnId });
		await afterWrite?.(`shared-account:${normalizedSharedId}`);
	}

	if (meta.publicId) {
		await releasePublicId(env, meta.publicId, columnId);
		await afterWrite?.("public-mapping");
	}

	const shareResponse = await stub.fetch(
		new Request("http://do/share", {
			method: "PUT",
			body: JSON.stringify({ sharedWith: [] }),
		}),
	);
	if (!shareResponse.ok) {
		throw new Error(`Failed to clear column shares: ${shareResponse.status}`);
	}
	await afterWrite?.("column-shares");

	const publicResponse = await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId: null }),
		}),
	);
	if (!publicResponse.ok) {
		throw new Error(`Failed to clear public column ID: ${publicResponse.status}`);
	}
	await afterWrite?.("column-public");

	const deletedAt = now();
	await mutateAccountRecord(env, trashKey, {
		kind: "trash-upsert",
		columnId,
		deletedAt,
		retentionMs: TRASH_RETENTION_MS,
	});
	await afterWrite?.("trash");

	return {
		ok: true,
		value: {
			success: true,
			trashed: true,
			deleteAfter: deletedAt + TRASH_RETENTION_MS,
		},
	};
}
