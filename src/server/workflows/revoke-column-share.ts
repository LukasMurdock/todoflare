import { normalizeAccountId } from "../../lib/account";
import { parseColumnMetaRecord } from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type RevokeColumnShareWriteBoundary =
	| "column-shares"
	| "shared-account";

export interface RevokeColumnShareInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	targetAccountId: string;
	afterWrite?: ColumnLifecycleWriteObserver<RevokeColumnShareWriteBoundary>;
}

export interface RevokeColumnShareOutput {
	success: true;
	sharedWith: string[];
}

/**
 * Removes authoritative Durable Object access before repairing the target's
 * derived KV discovery list. A retry reconciles KV even when access was
 * removed by a prior partial attempt.
 */
export async function revokeColumnShare<TColumnRoomId>(
	input: RevokeColumnShareInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<RevokeColumnShareOutput>> {
	const { env, columnId, accountId, targetAccountId, afterWrite } = input;
	const normalizedTargetId = normalizeAccountId(targetAccountId);
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

	if (normalizeAccountId(meta.ownerId) !== normalizeAccountId(accountId)) {
		return {
			ok: false,
			failure: {
				kind: "owner",
				meta,
				message: "Only owner can revoke sharing",
			},
		};
	}

	const sharedWith = meta.sharedWith.filter(
		(id) => normalizeAccountId(id) !== normalizedTargetId,
	);
	if (sharedWith.length !== meta.sharedWith.length) {
		const shareResponse = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({ sharedWith }),
			}),
		);
		if (!shareResponse.ok) {
			throw new Error(`Failed to revoke column share: ${shareResponse.status}`);
		}
		await afterWrite?.("column-shares");
	}

	const sharedKey = `shared:${normalizedTargetId}`;
	const sharedColumnsData = await env.ACCOUNTS.get(sharedKey);
	if (sharedColumnsData) {
		const sharedColumns = JSON.parse(sharedColumnsData) as string[];
		const updated = sharedColumns.filter((id) => id !== columnId);
		if (updated.length !== sharedColumns.length) {
			await env.ACCOUNTS.put(sharedKey, JSON.stringify(updated));
			await afterWrite?.("shared-account");
		}
	}

	return { ok: true, value: { success: true, sharedWith } };
}
