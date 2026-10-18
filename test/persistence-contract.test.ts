import { describe, expect, it } from "vitest";
import { migrateCollectionEntries } from "../src/lib/local-first/persistence-contract";

const ACCOUNT_ID = "1111 1111 1111 1111";
const COLUMN_ID = "00000000-0000-4000-8000-000000000001";

function snapshotWithSharedColumn(publicId: string | null) {
	return {
		schemaVersion: 1,
		id: "account:1111111111111111",
		accountId: ACCOUNT_ID,
		account: {
			schemaVersion: 1,
			id: ACCOUNT_ID,
			columnOrder: [],
			hiddenSharedColumns: [],
			createdAt: 100,
		},
		sharedColumns: [
			{
				schemaVersion: 1,
				id: COLUMN_ID,
				ownerId: "2222 2222 2222 2222",
				sharedWith: [ACCOUNT_ID],
				publicId,
				createdAt: 100,
			},
		],
		deletedColumns: [],
		hydratedAt: 100,
		reconciledAt: null,
	};
}

describe("local-first record shapes follow the server contract", () => {
	it("accepts a snapshot the server contract accepts", () => {
		const snapshot = snapshotWithSharedColumn("x7Km9p2N");
		const result = migrateCollectionEntries("accountSnapshot", [[snapshot.id, snapshot]]);
		expect(result.quarantined).toEqual([]);
		expect(result.entries).toHaveLength(1);
	});

	it.each([
		["a public ID the server would reject", snapshotWithSharedColumn("not-a-public-id")],
		[
			"an invalid account ID",
			{ ...snapshotWithSharedColumn(null), account: { ...snapshotWithSharedColumn(null).account, id: "nobody" } },
		],
	])("quarantines a snapshot with %s", (_label, snapshot) => {
		const result = migrateCollectionEntries("accountSnapshot", [[snapshot.id, snapshot]]);
		expect(result.entries).toEqual([]);
		expect(result.quarantined).toMatchObject([{ category: "invalid", sourceKey: snapshot.id }]);
	});
});
