import { describe, expect, it } from "vitest";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseDeletedColumnRecords,
	parseSharedColumnIndex,
} from "../src/server/persistence-records";

const account = {
	schemaVersion: 1,
	id: "1111 2222 3333 4444",
	columnOrder: ["00000000-0000-4000-8000-000000000001"],
	hiddenSharedColumns: [],
	createdAt: 1,
};

describe("persisted record schemas", () => {
	it("keeps valid version-1 account records readable", () => {
		expect(parseAccountRecord(JSON.stringify(account))).toEqual({
			ok: true,
			value: account,
		});
	});

	it.each([
		["wrong account array member", { ...account, columnOrder: [42] }],
		["malformed account id", { ...account, id: "not-an-account" }],
		["non-UUID column id", { ...account, columnOrder: ["column-1"] }],
		["non-finite timestamp", { ...account, createdAt: null }],
	])("rejects %s", (_label, value) => {
		expect(parseAccountRecord(JSON.stringify(value))).toMatchObject({
			ok: false,
			code: "invalid_shape",
		});
	});

	it("reports unsupported record versions", () => {
		expect(
			parseColumnMetaRecord({
				schemaVersion: 2,
				id: "00000000-0000-4000-8000-000000000001",
				ownerId: account.id,
				sharedWith: [],
				publicId: null,
				createdAt: 1,
			}),
		).toMatchObject({
			ok: false,
			code: "unsupported_schema_version",
			foundVersion: 2,
		});
	});

	it.each(["not-json", '["column-1"]', '["00000000-0000-4000-8000-000000000001", 2]', '{"column":"column-1"}'])(
		"rejects corrupt shared indexes: %s",
		(raw) => {
			expect(parseSharedColumnIndex(raw).ok).toBe(false);
		},
	);

	it("treats a missing trash record as an empty valid collection", () => {
		expect(parseDeletedColumnRecords(null)).toEqual({ ok: true, value: [] });
	});

	it.each([
		"not-json",
		'{}',
		'[{"columnId":"00000000-0000-4000-8000-000000000001"}]',
		'[{"columnId":"column-1","deletedAt":1}]',
		'[42]',
	])(
		"rejects corrupt trash records: %s",
		(raw) => {
			expect(parseDeletedColumnRecords(raw).ok).toBe(false);
		},
	);
});
