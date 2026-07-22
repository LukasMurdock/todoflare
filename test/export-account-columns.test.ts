import { describe, expect, it } from "vitest";
import { exportAccountColumns } from "../src/server/workflows/export-account-columns";

const accountId = "1111 2222 3333 4444";
const columnId = "11111111-1111-4111-8111-111111111111";

function validExport(id = columnId, ownerId = accountId) {
	return {
		meta: {
			schemaVersion: 1,
			id,
			ownerId,
			sharedWith: [],
			publicId: null,
			createdAt: 1,
		},
		yjs: [1, 2, 3],
	};
}

function columnRooms(fetch: (request: Request) => Promise<Response>) {
	return {
		idFromName: (id: string) => id,
		get: () => ({ fetch }),
	};
}

describe("exportAccountColumns", () => {
	it("exports every expected column in account order", async () => {
		const secondColumnId = "22222222-2222-4222-8222-222222222222";
		const result = await exportAccountColumns({
			columnRooms: {
				idFromName: (id: string) => id,
				get: (id: string) => ({
					fetch: async () => Response.json(validExport(id)),
				}),
			},
			columnIds: [columnId, secondColumnId],
			accountId,
		});
		expect(result.ok && result.columns.map((column) => column.meta.id)).toEqual([
			columnId,
			secondColumnId,
		]);
	});

	it.each([
		{
			name: "missing",
			fetch: async () => new Response("missing", { status: 404 }),
			reason: "not_found",
		},
		{
			name: "unavailable",
			fetch: async () => {
				throw new Error("Durable Object unavailable");
			},
			reason: "unavailable",
		},
		{
			name: "malformed JSON",
			fetch: async () => new Response("{"),
			reason: "invalid_response",
		},
		{
			name: "malformed metadata",
			fetch: async () => Response.json({ meta: {}, yjs: null }),
			reason: "invalid_response",
		},
		{
			name: "malformed Yjs bytes",
			fetch: async () => Response.json({ ...validExport(), yjs: [256] }),
			reason: "invalid_response",
		},
	])("fails the whole export when a column is $name", async ({ fetch, reason }) => {
		const result = await exportAccountColumns({
			columnRooms: columnRooms(fetch),
			columnIds: [columnId],
			accountId,
		});

		expect(result).toEqual({
			ok: false,
			failures: [{ columnId, reason }],
		});
	});

	it.each([
		{
			name: "metadata ID does not match",
			body: validExport("22222222-2222-4222-8222-222222222222"),
			reason: "column_id_mismatch",
		},
		{
			name: "metadata owner does not match",
			body: validExport(columnId, "9999 8888 7777 6666"),
			reason: "owner_mismatch",
		},
	])("fails when $name", async ({ body, reason }) => {
		const result = await exportAccountColumns({
			columnRooms: columnRooms(async () => Response.json(body)),
			columnIds: [columnId],
			accountId,
		});
		expect(result).toEqual({
			ok: false,
			failures: [{ columnId, reason }],
		});
	});
});
