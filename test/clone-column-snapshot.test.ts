import { describe, expect, it } from "vitest";
import { cloneColumnSnapshot } from "../src/server/workflows/clone-column-snapshot";

const ownerId = "1111 2222 3333 4444";
const account = {
	schemaVersion: 1 as const,
	id: ownerId,
	columnOrder: [],
	hiddenSharedColumns: [],
	createdAt: 1,
};
const snapshot = {
	meta: {
		schemaVersion: 1,
		id: "00000000-0000-4000-8000-000000000001",
		ownerId,
		sharedWith: ["9999 8888 7777 6666"],
		publicId: "AbCd1234",
		createdAt: 1,
	},
	yjs: [1, 2, 3],
};

function bindings(importStatus = 200) {
	const writes: Array<string> = [];
	const removed: Array<string> = [];
	const records = new Map([["account:1111222233334444", JSON.stringify(account)]]);
	return {
		env: {
			ACCOUNTS: {
				get: async (key: string) => records.get(key) ?? null,
				put: async (key: string, value: string) => { writes.push(key); records.set(key, value); },
				delete: async (key: string) => { removed.push(key); records.delete(key); },
			},
			COLUMN_ROOM: {
				idFromName: (id: string) => id,
				get: () => ({ fetch: async () => new Response(null, { status: importStatus }) }),
			},
		},
		writes, removed,
	};
}

describe("cloneColumnSnapshot", () => {
	it("reports corrupt Yjs and removes the provisional registry entry", async () => {
		const failed = bindings(422);
		const result = await cloneColumnSnapshot({
			env: failed.env,
			ownerId,
			snapshot: { ...snapshot, yjs: [1] },
			createColumnId: () => "corrupt-clone",
		});

		expect(result).toEqual({ ok: false, code: "invalid_yjs_update" });
		expect(failed.removed).toContain(
			"column-registry:corrupt-clone",
		);
		expect(failed.writes).not.toContain(
			"account:1111222233334444",
		);
	});

	it("commits the account projection only after a successful DO import", async () => {
		const failed = bindings(500);
		const result = await cloneColumnSnapshot({
			env: failed.env,
			ownerId,
			snapshot,
			createColumnId: () => "00000000-0000-4000-8000-000000000002",
			now: () => 2,
		});
		expect(result).toEqual({ ok: false, code: "column_import_failed" });
		expect(failed.writes).toContain(
			"column-registry:00000000-0000-4000-8000-000000000002",
		);

		const successful = bindings();
		const writes: Array<string> = [];
		const cloned = await cloneColumnSnapshot({
			env: successful.env,
			ownerId,
			snapshot,
			createColumnId: () => "00000000-0000-4000-8000-000000000002",
			now: () => 2,
			afterWrite: (boundary) => {
				writes.push(boundary);
			},
		});
		expect(cloned).toMatchObject({
			ok: true,
			column: {
				id: "00000000-0000-4000-8000-000000000002",
				ownerId,
				sharedWith: [],
				publicId: null,
			},
		});
		expect(writes).toEqual(["column-import", "owner-account"]);
	});
});
