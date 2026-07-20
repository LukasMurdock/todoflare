import { z } from "zod";
import type { Account, ColumnMeta } from "../types/account";
import {
	accountContractSchema,
	columnMetaContractSchema,
	deletedColumnContractSchema,
	recordIdContractSchema,
} from "../lib/api/account-contract";

export const ACCOUNT_SCHEMA_VERSION = 1;
export const COLUMN_META_SCHEMA_VERSION = 1;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Authoritative runtime shape for account records persisted in KV. */
export const accountRecordSchema = accountContractSchema.extend({
	schemaVersion: z.literal(ACCOUNT_SCHEMA_VERSION).default(ACCOUNT_SCHEMA_VERSION),
});

/** Authoritative runtime shape for metadata persisted by ColumnRoom. */
export const columnMetaRecordSchema = columnMetaContractSchema.extend({
	schemaVersion: z
		.literal(COLUMN_META_SCHEMA_VERSION)
		.default(COLUMN_META_SCHEMA_VERSION),
});

export const deletedColumnRecordSchema = deletedColumnContractSchema;

export const sharedColumnIndexSchema = z.array(recordIdContractSchema).max(100);

export type SchemaParseErrorCode =
	| "invalid_json"
	| "unsupported_schema_version"
	| "invalid_shape";

export type SchemaParseResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code: SchemaParseErrorCode;
			message: string;
			foundVersion?: number;
			expectedVersion: number;
	  };

export type DeletedColumnRecord = z.infer<typeof deletedColumnRecordSchema>;

function invalidShape(message: string): SchemaParseResult<never> {
	return {
		ok: false,
		code: "invalid_shape",
		message,
		expectedVersion: 1,
	};
}

function parseJson(raw: string, recordName: string): SchemaParseResult<unknown> {
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch {
		return {
			ok: false,
			code: "invalid_json",
			message: `${recordName} is invalid JSON`,
			expectedVersion: 1,
		};
	}
}

function unsupportedVersion(
	raw: unknown,
	expectedVersion: number,
	recordName: string,
): SchemaParseResult<never> | null {
	if (!raw || typeof raw !== "object") return null;
	const foundVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
	if (typeof foundVersion !== "number" || foundVersion === expectedVersion) {
		return null;
	}
	return {
		ok: false,
		code: "unsupported_schema_version",
		message: `${recordName} schema version is not supported`,
		foundVersion,
		expectedVersion,
	};
}

export function parseAccountRecord(raw: string): SchemaParseResult<Account> {
	const json = parseJson(raw, "Account record");
	if (!json.ok) return json;
	const versionError = unsupportedVersion(
		json.value,
		ACCOUNT_SCHEMA_VERSION,
		"Account",
	);
	if (versionError) return versionError;
	const parsed = accountRecordSchema.safeParse(json.value);
	return parsed.success
		? { ok: true, value: parsed.data satisfies Account }
		: invalidShape("Account record has invalid shape");
}

export function parseColumnMetaRecord(raw: unknown): SchemaParseResult<ColumnMeta> {
	const versionError = unsupportedVersion(
		raw,
		COLUMN_META_SCHEMA_VERSION,
		"Column metadata",
	);
	if (versionError) return versionError;
	const parsed = columnMetaRecordSchema.safeParse(raw);
	return parsed.success
		? { ok: true, value: parsed.data satisfies ColumnMeta }
		: invalidShape("Column metadata has invalid shape");
}

export function parseDeletedColumnRecords(raw: string | null): DeletedColumnRecord[] {
	if (!raw) return [];
	const json = parseJson(raw, "Trash record");
	if (!json.ok) return [];
	const parsed = z.array(deletedColumnRecordSchema).max(100).safeParse(json.value);
	return parsed.success ? parsed.data : [];
}

export function parseSharedColumnIndex(
	raw: string | null,
): SchemaParseResult<string[]> {
	if (raw === null) return { ok: true, value: [] };
	const json = parseJson(raw, "Shared column index");
	if (!json.ok) return json;
	const parsed = sharedColumnIndexSchema.safeParse(json.value);
	return parsed.success
		? { ok: true, value: parsed.data }
		: invalidShape("Shared column index has invalid shape");
}
