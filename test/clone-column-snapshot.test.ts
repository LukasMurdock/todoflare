import { describe, expect, it, vi } from "vitest";
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
		id: "source-column",
		ownerId,
		sharedWith: ["9999 8888 7777 6666"],
		publicId: "AbCd1234",
		createdAt: 1,
	},
	yjs: [1, 2, 3],
};

function bindings(importStatus = 200) {
	const put = vi.fn(async () => undefined);
	const fetch = vi.fn(async () => new Response(null, { status: importStatus }));
	return {
			env: {
				ACCOUNTS: {
					get: vi.fn(async () => JSON.stringify(account)),
					put,
					delete: vi.fn(async () => undefined),
			},
			COLUMN_ROOM: {
				idFromName: (id: string) => id,
				get: () => ({ fetch }),
			},
		},
		put,
		fetch,
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
		expect(failed.env.ACCOUNTS.delete).toHaveBeenCalledWith(
			"column-registry:corrupt-clone",
		);
		expect(failed.put).not.toHaveBeenCalledWith(
			"account:1111222233334444",
			expect.any(String),
		);
	});

	it("commits the account projection only after a successful DO import", async () => {
		const failed = bindings(500);
		const result = await cloneColumnSnapshot({
			env: failed.env,
			ownerId,
			snapshot,
			createColumnId: () => "new-column",
			now: () => 2,
		});
		expect(result).toEqual({ ok: false, code: "column_import_failed" });
		expect(failed.put).toHaveBeenCalledWith(
			"column-registry:new-column",
			expect.any(String),
		);

		const successful = bindings();
		const writes: string[] = [];
		const cloned = await cloneColumnSnapshot({
			env: successful.env,
			ownerId,
			snapshot,
			createColumnId: () => "new-column",
			now: () => 2,
			afterWrite: (boundary) => {
				writes.push(boundary);
			},
		});
		expect(cloned).toMatchObject({
			ok: true,
			column: {
				id: "new-column",
				ownerId,
				sharedWith: [],
				publicId: null,
			},
		});
		expect(writes).toEqual(["column-import", "owner-account"]);
	});
});
