import type { ColumnMeta } from "../../types/account";
import { parseColumnMetaRecord } from "../persistence-records";

export interface ColumnAccessState {
	meta: ColumnMeta;
	trashed: boolean;
}

export type ColumnAccessStateResult =
	| { ok: true; state: ColumnAccessState | null }
	| { ok: false; reason: "invalid_meta" | "unavailable" };

/** Reads membership and trash state from the column's Durable Object. */
export async function loadColumnAccessState(
	columnRooms: DurableObjectNamespace,
	columnId: string,
): Promise<ColumnAccessStateResult> {
	const stub = columnRooms.get(columnRooms.idFromName(columnId));
	const response = await stub.fetch(new Request("http://do/access-state"));
	if (response.status === 404) return { ok: true, state: null };
	if (!response.ok) return { ok: false, reason: "unavailable" };
	const body = (await response.json()) as { meta?: unknown; trashed?: unknown };
	const meta = parseColumnMetaRecord(body.meta);
	if (!meta.ok || typeof body.trashed !== "boolean") return { ok: false, reason: "invalid_meta" };
	return { ok: true, state: { meta: meta.value, trashed: body.trashed } };
}
