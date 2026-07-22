import { z } from "zod";
import {
	columnMetaContractSchema,
	recordIdContractSchema,
} from "../lib/api/account-contract";

export const MAX_YJS_UPDATE_BYTES = 8 * 1024 * 1024;

export const yjsBytesSchema = z
	.array(z.number().int().min(0).max(255))
	.max(MAX_YJS_UPDATE_BYTES)
	.nullable();

const columnBackupBaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		columnId: recordIdContractSchema,
		snapshotAt: z.number().int().finite().nonnegative(),
		meta: columnMetaContractSchema,
		yjs: yjsBytesSchema,
	})
	.strict()
	.refine((payload) => payload.meta.id === payload.columnId, {
		message: "Backup metadata does not match the column ID",
		path: ["meta", "id"],
	});

export const columnBackupPayloadSchema = columnBackupBaseSchema
	.safeExtend({
		checksum: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict();

export const columnSnapshotImportSchema = z
	.object({
		meta: columnMetaContractSchema,
		yjs: yjsBytesSchema,
	})
	.strict();

export type ColumnBackupPayload = z.infer<typeof columnBackupPayloadSchema>;
export type ColumnBackupBasePayload = z.infer<typeof columnBackupBaseSchema>;

export type ColumnBackupParseError =
	| "invalid_backup_json"
	| "invalid_backup_payload"
	| "backup_checksum_mismatch";

export type ColumnBackupParseResult =
	| { ok: true; payload: ColumnBackupPayload }
	| { ok: false; code: ColumnBackupParseError };

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checksumColumnBackupPayload(
	payload: ColumnBackupBasePayload,
): Promise<string> {
	const encoded = new TextEncoder().encode(JSON.stringify(payload));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return toHex(new Uint8Array(digest));
}

export async function parseAndVerifyColumnBackup(
	raw: string,
	expectedColumnId: string,
): Promise<ColumnBackupParseResult> {
	let input: unknown;
	try {
		input = JSON.parse(raw) as unknown;
	} catch {
		return { ok: false, code: "invalid_backup_json" };
	}

	const parsed = columnBackupPayloadSchema.safeParse(input);
	if (!parsed.success || parsed.data.columnId !== expectedColumnId) {
		return { ok: false, code: "invalid_backup_payload" };
	}

	const { checksum, ...basePayload } = parsed.data;
	if ((await checksumColumnBackupPayload(basePayload)) !== checksum) {
		return { ok: false, code: "backup_checksum_mismatch" };
	}

	return { ok: true, payload: parsed.data };
}
