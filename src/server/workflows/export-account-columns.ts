import { normalizeAccountId } from "../../lib/account";
import type { AccountExportColumn } from "../../types/account";
import { mapWithConcurrency } from "../bounded-concurrency";
import { yjsBytesSchema } from "../column-backup-payload";
import { parseColumnMetaRecord } from "../persistence-records";

export type AccountColumnExportFailureReason =
	| "duplicate_expected_column"
	| "unavailable"
	| "not_found"
	| "invalid_response"
	| "column_id_mismatch"
	| "owner_mismatch";

export interface AccountColumnExportFailure {
	columnId: string;
	reason: AccountColumnExportFailureReason;
}

export interface AccountColumnExportBindings<TColumnRoomId> {
	idFromName(name: string): TColumnRoomId;
	get(id: TColumnRoomId): { fetch(request: Request): Promise<Response> };
}

export type ExportAccountColumnsResult =
	| { ok: true; columns: AccountExportColumn[] }
	| { ok: false; failures: AccountColumnExportFailure[] };

/** Exports every expected owned column or returns no artifact at all. */
export async function exportAccountColumns<TColumnRoomId>(input: {
	columnRooms: AccountColumnExportBindings<TColumnRoomId>;
	columnIds: readonly string[];
	accountId: string;
	concurrency?: number;
}): Promise<ExportAccountColumnsResult> {
	const duplicateIds = input.columnIds.filter(
		(columnId, index) => input.columnIds.indexOf(columnId) !== index,
	);
	if (duplicateIds.length > 0) {
		return {
			ok: false,
			failures: Array.from(new Set(duplicateIds), (columnId) => ({
				columnId,
				reason: "duplicate_expected_column" as const,
			})),
		};
	}

	const normalizedAccountId = normalizeAccountId(input.accountId);
	const results = await mapWithConcurrency(
		input.columnIds,
		input.concurrency ?? 6,
		async (columnId): Promise<
			| { ok: true; column: AccountExportColumn }
			| { ok: false; failure: AccountColumnExportFailure }
		> => {
			const stub = input.columnRooms.get(input.columnRooms.idFromName(columnId));
			let response: Response;
			try {
				response = await stub.fetch(new Request("http://do/export"));
			} catch {
				return { ok: false, failure: { columnId, reason: "unavailable" } };
			}

			if (!response.ok) {
				return {
					ok: false,
					failure: {
						columnId,
						reason: response.status === 404 ? "not_found" : "unavailable",
					},
				};
			}

			let exported: unknown;
			try {
				exported = await response.json();
			} catch {
				return { ok: false, failure: { columnId, reason: "invalid_response" } };
			}
			if (!exported || typeof exported !== "object") {
				return { ok: false, failure: { columnId, reason: "invalid_response" } };
			}

			const candidate = exported as { meta?: unknown; yjs?: unknown };
			const parsedMeta = parseColumnMetaRecord(candidate.meta);
			const parsedYjs = yjsBytesSchema.safeParse(candidate.yjs);
			if (!parsedMeta.ok || !parsedYjs.success) {
				return { ok: false, failure: { columnId, reason: "invalid_response" } };
			}
			if (parsedMeta.value.id !== columnId) {
				return { ok: false, failure: { columnId, reason: "column_id_mismatch" } };
			}
			if (normalizeAccountId(parsedMeta.value.ownerId) !== normalizedAccountId) {
				return { ok: false, failure: { columnId, reason: "owner_mismatch" } };
			}

			return {
				ok: true,
				column: { meta: parsedMeta.value, yjs: parsedYjs.data },
			};
		},
	);

	const failures = results.flatMap((result) => result.ok ? [] : [result.failure]);
	if (failures.length > 0) return { ok: false, failures };

	return {
		ok: true,
		columns: results.map((result) => {
			if (!result.ok) throw new Error("Unreachable incomplete account export");
			return result.column;
		}),
	};
}
