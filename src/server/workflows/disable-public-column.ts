import { normalizeAccountId } from "../../lib/account";
import { parseColumnMetaRecord } from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type DisablePublicColumnWriteBoundary =
	| "public-mapping"
	| "column-public";

export interface DisablePublicColumnInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	afterWrite?: ColumnLifecycleWriteObserver<DisablePublicColumnWriteBoundary>;
}

export interface DisablePublicColumnOutput {
	success: true;
}

/**
 * Removes the public reverse lookup while the Durable Object still retains the
 * public ID needed by a retry, then clears authoritative public access.
 */
export async function disablePublicColumn<TColumnRoomId>(
	input: DisablePublicColumnInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<DisablePublicColumnOutput>> {
	const { env, columnId, accountId, afterWrite } = input;
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
				message: "Only owner can disable public link",
			},
		};
	}

	if (meta.publicId) {
		const publicKey = `public:${meta.publicId}`;
		if ((await env.ACCOUNTS.get(publicKey)) === columnId) {
			await env.ACCOUNTS.delete(publicKey);
			await afterWrite?.("public-mapping");
		}

		const publicResponse = await stub.fetch(
			new Request("http://do/public", {
				method: "PUT",
				body: JSON.stringify({ publicId: null }),
			}),
		);
		if (!publicResponse.ok) {
			throw new Error(`Failed to disable public column: ${publicResponse.status}`);
		}
		await afterWrite?.("column-public");
	}

	return { ok: true, value: { success: true } };
}
