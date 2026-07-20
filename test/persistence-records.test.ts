import { describe, expect, it } from "vitest";
import {
	parseAccountRecord,
	parseColumnMetaRecord,
	parseSharedColumnIndex,
} from "../src/server/persistence-records";

const account = {
	schemaVersion: 1,
	id: "1111 2222 3333 4444",
	columnOrder: ["column-1"],
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
				id: "column-1",
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

	it.each(["not-json", '["column-1", 2]', '{"column":"column-1"}'])(
		"rejects corrupt shared indexes: %s",
		(raw) => {
			expect(parseSharedColumnIndex(raw).ok).toBe(false);
		},
	);
});
