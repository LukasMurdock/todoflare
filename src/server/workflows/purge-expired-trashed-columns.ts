import {
	parseDeletedColumnRecords,
	TRASH_RETENTION_MS,
} from "../persistence-records";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";

interface AccountKey {
	name: string;
}

interface AccountKeyPage {
	keys: AccountKey[];
	list_complete: boolean;
	cursor?: string;
}

export interface PurgeExpiredTrashBindings<TColumnRoomId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete?(key: string): Promise<void>;
		list(options: {
			prefix: string;
			cursor?: string;
			limit: number;
		}): Promise<AccountKeyPage>;
	};
	COLUMN_ROOM: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
}

export interface PurgeExpiredTrashedColumnsInput<TColumnRoomId> {
	env: PurgeExpiredTrashBindings<TColumnRoomId>;
	now?: () => number;
	retentionMs?: number;
	deleteColumn?: (columnId: string) => Promise<Response>;
}

export interface PurgeExpiredTrashedColumnsResult {
	accountsScanned: number;
	columnsPurged: number;
	columnsFailed: number;
	trashEntriesRemoved: number;
}

/**
 * Purges expired column data before removing its trash record. Any non-OK
 * response or thrown deletion remains in trash so a later scheduled run can
 * retry it. Failures are isolated per column so the rest of the batch proceeds.
 */
export async function purgeExpiredTrashedColumns<TColumnRoomId>(
	input: PurgeExpiredTrashedColumnsInput<TColumnRoomId>,
): Promise<PurgeExpiredTrashedColumnsResult> {
	const { env } = input;
	const now = input.now?.() ?? Date.now();
	const retentionMs = input.retentionMs ?? TRASH_RETENTION_MS;
	const deleteColumn =
		input.deleteColumn ??
		(async (columnId: string) => {
			const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
			return stub.fetch(new Request("http://do/", { method: "DELETE" }));
		});

	let accountsScanned = 0;
	let columnsPurged = 0;
	let columnsFailed = 0;
	let trashEntriesRemoved = 0;
	let cursor: string | undefined;

	while (true) {
		const page = await env.ACCOUNTS.list({
			prefix: "account:",
			cursor,
			limit: 1000,
		});

		for (const key of page.keys) {
			const normalizedId = key.name.replace(/^account:/, "");
			accountsScanned += 1;

			const trashKey = `trash:${normalizedId}`;
			const trash = parseDeletedColumnRecords(await env.ACCOUNTS.get(trashKey));
			if (trash.length === 0) continue;

			for (const entry of trash) {
				if (now - entry.deletedAt < retentionMs) {
					continue;
				}

				try {
					const deleteResponse = await deleteColumn(entry.columnId);
					if (!deleteResponse.ok) {
						columnsFailed += 1;
						continue;
					}

					// Remove discoverability before the trash commit record. If the
					// invocation stops here, the retained trash entry safely retries.
					await env.ACCOUNTS.delete?.(`column-registry:${entry.columnId}`);
					await mutateAccountRecord(env, trashKey, {
						kind: "trash-remove",
						columnId: entry.columnId,
					});
					columnsPurged += 1;
					trashEntriesRemoved += 1;
				} catch {
					columnsFailed += 1;
				}
			}
		}

		if (page.list_complete) break;
		cursor = page.cursor;
	}

	return {
		accountsScanned,
		columnsPurged,
		columnsFailed,
		trashEntriesRemoved,
	};
}
