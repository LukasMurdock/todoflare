import { normalizeAccountId } from "../../lib/account";
import { isColumnOwner } from "../../lib/column-access";
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
	const ownerData = await env.ACCOUNTS.get(ownerKey);
	if (ownerData) {
		const parsedOwner = parseAccountRecord(ownerData);
		if (!parsedOwner.ok) {
			return {
				ok: false,
				failure: { kind: "schema", record: "account", result: parsedOwner },
			};
		}
		const ownerAccount = parsedOwner.value;
		ownerAccount.columnOrder = ownerAccount.columnOrder.filter(
			(id) => id !== columnId,
		);
		await env.ACCOUNTS.put(ownerKey, JSON.stringify(ownerAccount));
		await afterWrite?.("owner-account");
	}

	for (const sharedAccountId of meta.sharedWith) {
		const normalizedSharedId = normalizeAccountId(sharedAccountId);
		const sharedKey = `shared:${normalizedSharedId}`;
		const sharedColumnsData = await env.ACCOUNTS.get(sharedKey);
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
		const sharedColumns = parsedSharedColumns.value;
		const updated = sharedColumns.filter((id) => id !== columnId);
		await env.ACCOUNTS.put(sharedKey, JSON.stringify(updated));
		await afterWrite?.(`shared-account:${normalizedSharedId}`);
	}

	if (meta.publicId) {
		await env.ACCOUNTS.delete(`public:${meta.publicId}`);
		await afterWrite?.("public-mapping");
	}

	await stub.fetch(
		new Request("http://do/share", {
			method: "PUT",
			body: JSON.stringify({ sharedWith: [] }),
		}),
	);
	await afterWrite?.("column-shares");

	await stub.fetch(
		new Request("http://do/public", {
			method: "PUT",
			body: JSON.stringify({ publicId: null }),
		}),
	);
	await afterWrite?.("column-public");

	const deletedAt = now();
	const trashKey = `trash:${normalizedOwnerId}`;
	const trashRaw = await env.ACCOUNTS.get(trashKey);
	const trash = parseDeletedColumnRecords(trashRaw).filter(
		(entry) => deletedAt - entry.deletedAt < TRASH_RETENTION_MS,
	);
	const updatedTrash = [
		{ columnId, deletedAt },
		...trash.filter((entry) => entry.columnId !== columnId),
	];
	await env.ACCOUNTS.put(trashKey, JSON.stringify(updatedTrash));
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
