import {
	allocateGeneratedId,
	generatePublicId,
	normalizeAccountId,
} from "../../lib/account";
import { parseColumnMetaRecord } from "../persistence-records";
import {
	type ColumnLifecycleBindings,
	type ColumnLifecycleResult,
	type ColumnLifecycleWriteObserver,
	lifecycleNotFound,
} from "./column-lifecycle";

export type EnablePublicColumnWriteBoundary =
	| "column-public"
	| "public-mapping";

export interface EnablePublicColumnInput<TColumnRoomId> {
	env: ColumnLifecycleBindings<TColumnRoomId>;
	columnId: string;
	accountId: string;
	createPublicId?: () => string;
	maxPublicIdAttempts?: number;
	afterWrite?: ColumnLifecycleWriteObserver<EnablePublicColumnWriteBoundary>;
}

export interface EnablePublicColumnOutput {
	publicId: string;
}

/**
 * Keeps public-link identity in authoritative DO metadata and treats the KV
 * reverse lookup as a repairable projection. A retry reuses an existing DO ID
 * instead of rotating the link after a partial failure.
 */
export async function enablePublicColumn<TColumnRoomId>(
	input: EnablePublicColumnInput<TColumnRoomId>,
): Promise<ColumnLifecycleResult<EnablePublicColumnOutput>> {
	const { env, columnId, accountId, afterWrite } = input;
	const createPublicId = input.createPublicId ?? generatePublicId;
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
				message: "Only owner can enable public link",
			},
		};
	}

	const publicId =
		meta.publicId ??
		(await allocateGeneratedId({
			createId: createPublicId,
			isInUse: async (candidate) => {
				const mappedColumnId = await env.ACCOUNTS.get(`public:${candidate}`);
				return mappedColumnId !== null && mappedColumnId !== columnId;
			},
			maxAttempts: input.maxPublicIdAttempts,
		}));
	if (meta.publicId === null) {
		const publicResponse = await stub.fetch(
			new Request("http://do/public", {
				method: "PUT",
				body: JSON.stringify({ publicId }),
			}),
		);
		if (!publicResponse.ok) {
			throw new Error(`Failed to enable public column: ${publicResponse.status}`);
		}
		await afterWrite?.("column-public");
	}

	const publicKey = `public:${publicId}`;
	const mappedColumnId = await env.ACCOUNTS.get(publicKey);
	if (mappedColumnId !== null && mappedColumnId !== columnId) {
		throw new Error(`Public ID ${publicId} is already mapped to another column`);
	}
	if (mappedColumnId !== columnId) {
		await env.ACCOUNTS.put(publicKey, columnId);
		await afterWrite?.("public-mapping");
	}

	return { ok: true, value: { publicId } };
}
