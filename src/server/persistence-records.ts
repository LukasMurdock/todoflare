import type { Account, ColumnMeta } from "../types/account";

export const ACCOUNT_SCHEMA_VERSION = 1;
export const COLUMN_META_SCHEMA_VERSION = 1;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

export type DeletedColumnRecord = {
	columnId: string;
	deletedAt: number;
};

export function parseAccountRecord(raw: string): SchemaParseResult<Account> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			code: "invalid_json",
			message: "Account record is invalid JSON",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	if (!parsed || typeof parsed !== "object") {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Account record has invalid shape",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	const obj = parsed as Partial<Account> & { schemaVersion?: number };
	const foundVersion = obj.schemaVersion ?? ACCOUNT_SCHEMA_VERSION;
	if (foundVersion !== ACCOUNT_SCHEMA_VERSION) {
		return {
			ok: false,
			code: "unsupported_schema_version",
			message: "Account schema version is not supported",
			foundVersion,
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	if (
		typeof obj.id !== "string" ||
		!Array.isArray(obj.columnOrder) ||
		!Array.isArray(obj.hiddenSharedColumns) ||
		typeof obj.createdAt !== "number"
	) {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Account record missing required fields",
			expectedVersion: ACCOUNT_SCHEMA_VERSION,
		};
	}

	return {
		ok: true,
		value: {
			schemaVersion: ACCOUNT_SCHEMA_VERSION,
			id: obj.id,
			columnOrder: obj.columnOrder,
			hiddenSharedColumns: obj.hiddenSharedColumns,
			createdAt: obj.createdAt,
		},
	};
}

export function parseColumnMetaRecord(
	raw: unknown,
): SchemaParseResult<ColumnMeta> {
	if (!raw || typeof raw !== "object") {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Column metadata has invalid shape",
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	const obj = raw as Partial<ColumnMeta> & { schemaVersion?: number };
	const foundVersion = obj.schemaVersion ?? COLUMN_META_SCHEMA_VERSION;
	if (foundVersion !== COLUMN_META_SCHEMA_VERSION) {
		return {
			ok: false,
			code: "unsupported_schema_version",
			message: "Column metadata schema version is not supported",
			foundVersion,
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	if (
		typeof obj.id !== "string" ||
		typeof obj.ownerId !== "string" ||
		!Array.isArray(obj.sharedWith) ||
		!(typeof obj.publicId === "string" || obj.publicId === null) ||
		typeof obj.createdAt !== "number"
	) {
		return {
			ok: false,
			code: "invalid_shape",
			message: "Column metadata missing required fields",
			expectedVersion: COLUMN_META_SCHEMA_VERSION,
		};
	}

	return {
		ok: true,
		value: {
			schemaVersion: COLUMN_META_SCHEMA_VERSION,
			id: obj.id,
			ownerId: obj.ownerId,
			sharedWith: obj.sharedWith,
			publicId: obj.publicId,
			createdAt: obj.createdAt,
		},
	};
}

export function parseDeletedColumnRecords(
	raw: string | null,
): DeletedColumnRecord[] {
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter(
				(item): item is DeletedColumnRecord =>
					!!item &&
					typeof item === "object" &&
					typeof (item as { columnId?: unknown }).columnId === "string" &&
					typeof (item as { deletedAt?: unknown }).deletedAt === "number",
			)
			.map((item) => ({ columnId: item.columnId, deletedAt: item.deletedAt }));
	} catch {
		return [];
	}
}
