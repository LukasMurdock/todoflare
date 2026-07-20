import { displayAccountId, normalizeAccountId } from "../../lib/account";
import { hasColumnAccess, isColumnOwner } from "../../lib/column-access";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseSharedColumnIndex,
} from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type ShareColumnWriteBoundary = "column-shares" | "shared-account";

export interface ShareColumnInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	targetAccountId: string;
	afterWrite?: ColumnLifecycleWriteObserver<ShareColumnWriteBoundary>;
}

export interface ShareColumnOutput {
	success: true;
	sharedWith: string[];
}

/**
 * Updates authoritative Durable Object access before repairing the derived KV
 * discovery projection. A retry always reconciles KV, even when DO access was
 * committed by a prior partial attempt.
 */
export async function shareColumn<TColumnRoomId>(
	input: ShareColumnInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<ShareColumnOutput>> {
	const { env, columnId, accountId, targetAccountId, afterWrite } = input;
	const normalizedTargetId = normalizeAccountId(targetAccountId);
	const targetData = await env.ACCOUNTS.get(`account:${normalizedTargetId}`);
	if (!targetData) return lifecycleNotFound("Target account not found");

	const parsedTarget = parseAccountRecord(targetData);
	if (!parsedTarget.ok) {
		return {
			ok: false,
			failure: { kind: "schema", record: "account", result: parsedTarget },
		};
	}

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
			failure: { kind: "owner", meta, message: "Only owner can share" },
		};
	}

	const formattedTargetId = displayAccountId(targetAccountId);
	if (!hasColumnAccess(meta, targetAccountId)) {
		meta.sharedWith.push(formattedTargetId);
		const shareResponse = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({ sharedWith: meta.sharedWith }),
			}),
		);
		if (!shareResponse.ok) {
			throw new Error(`Failed to update column shares: ${shareResponse.status}`);
		}
		await afterWrite?.("column-shares");
	}

	const sharedKey = `shared:${normalizedTargetId}`;
	const sharedColumnsData = await env.ACCOUNTS.get(sharedKey);
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
	if (!sharedColumns.includes(columnId)) {
		sharedColumns.push(columnId);
		await env.ACCOUNTS.put(sharedKey, JSON.stringify(sharedColumns));
		await afterWrite?.("shared-account");
	}

	return { ok: true, value: { success: true, sharedWith: meta.sharedWith } };
}
