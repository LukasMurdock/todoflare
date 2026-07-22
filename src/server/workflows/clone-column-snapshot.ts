import { displayAccountId, normalizeAccountId } from "../../lib/account";
import type { ColumnMeta } from "../../types/account";
import { accountRecordStore, mutateAccountRecord } from "../account-record-store";
import { registerColumn } from "../lifecycle-journal";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
} from "../persistence-records";

export type CloneColumnSnapshotWriteBoundary = "column-import" | "owner-account";

export interface CloneColumnSnapshotBindings<TColumnRoomId> {
	ACCOUNTS: {
		get(key: string): Promise<string | null>;
		put(key: string, value: string): Promise<void>;
		delete?(key: string): Promise<void>;
	};
	ACCOUNT_COORDINATOR?: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
	COLUMN_ROOM: {
		idFromName(name: string): TColumnRoomId;
		get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
	};
}

export interface CloneColumnSnapshotInput<TColumnRoomId> {
	env: CloneColumnSnapshotBindings<TColumnRoomId>;
	ownerId: string;
	snapshot: { meta: unknown; yjs: number[] | null };
	createColumnId?: () => string;
	now?: () => number;
	afterWrite?: (
		boundary: CloneColumnSnapshotWriteBoundary,
	) => void | Promise<void>;
}

export type CloneColumnSnapshotResult =
	| { ok: true; column: ColumnMeta }
	| {
			ok: false;
			code:
				| "account_not_found"
				| "account_invalid"
				| "column_meta_invalid"
				| "column_import_failed";
	  };

/**
 * Clones a snapshot into a new private column. An enumerable registry record
 * is written before import so a crash cannot leave an undiscoverable Durable
 * Object; owner membership is committed after the complete import succeeds.
 */
export async function cloneColumnSnapshot<TColumnRoomId>(
	input: CloneColumnSnapshotInput<TColumnRoomId>,
): Promise<CloneColumnSnapshotResult> {
	const parsedMeta = parseColumnMetaRecord(input.snapshot.meta);
	if (!parsedMeta.ok) return { ok: false, code: "column_meta_invalid" };

	const ownerKey = `account:${normalizeAccountId(input.ownerId)}`;
	const records = accountRecordStore(input.env);
	const ownerRaw = await records.get(ownerKey);
	if (!ownerRaw) return { ok: false, code: "account_not_found" };
	const parsedOwner = parseAccountRecord(ownerRaw);
	if (!parsedOwner.ok) return { ok: false, code: "account_invalid" };

	const columnId = input.createColumnId?.() ?? crypto.randomUUID();
	const column: ColumnMeta = {
		...parsedMeta.value,
		id: columnId,
		ownerId: displayAccountId(input.ownerId),
		sharedWith: [],
		publicId: null,
		createdAt: (input.now ?? Date.now)(),
	};
	await registerColumn(input.env.ACCOUNTS, column);

	const stub = input.env.COLUMN_ROOM.get(
		input.env.COLUMN_ROOM.idFromName(columnId),
	);
	const imported = await stub.fetch(
		new Request("http://do/import", {
			method: "POST",
			body: JSON.stringify({ meta: column, yjs: input.snapshot.yjs }),
		}),
	);
	if (!imported.ok) {
		await input.env.ACCOUNTS.delete?.(`column-registry:${columnId}`);
		return { ok: false, code: "column_import_failed" };
	}
	await input.afterWrite?.("column-import");

	const owner = parsedOwner.value;
	if (!owner.columnOrder.includes(columnId)) {
		await mutateAccountRecord(input.env, ownerKey, {
			kind: "account-add-column",
			columnId,
		});
		await input.afterWrite?.("owner-account");
	}

	return { ok: true, column };
}
