import { describe, expect, it } from "vitest";
import { restoreColumnBackup } from '../src/server/workflows/restore-column-backup';
import type { ColumnBackupPayload } from '../src/server/workflows/restore-column-backup';

const ownerId = "1111 2222 3333 4444";
const collaboratorId = "9999 8888 7777 6666";
const columnId = "00000000-0000-4000-8000-000000000001";

async function payload(): Promise<ColumnBackupPayload> {
	const base = {
		schemaVersion: 1 as const,
		columnId,
		snapshotAt: 10,
		meta: {
			schemaVersion: 1 as const,
			id: columnId,
			ownerId,
			sharedWith: [collaboratorId],
			publicId: "AbCd1234",
			createdAt: 1,
		},
		yjs: [1, 2],
	};
	const bytes = new TextEncoder().encode(JSON.stringify(base));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const checksum = Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return { ...base, checksum };
}

function bindings(importStatus: number) {
	const records = new Map<string, string>([
		[
			"account:1111222233334444",
			JSON.stringify({
				schemaVersion: 1,
				id: ownerId,
				columnOrder: [],
				hiddenSharedColumns: [],
				createdAt: 1,
			}),
		],
	]);
	const put = async (key: string, value: string) => {
		records.set(key, value);
	};
	const fetch = async (request: Request) => {
		if (new URL(request.url).pathname === "/meta") {
			return new Response("Column not found", { status: 404 });
		}
		return new Response(null, { status: importStatus });
	};
	return {
		env: {
			ACCOUNTS: {
				get: async (key: string) => records.get(key) ?? null,
				put,
				delete: async (key: string) => { records.delete(key); },
			},
			COLUMN_ROOM: {
				idFromName: (id: string) => id,
				get: () => ({ fetch }),
			},
		},
		records,
	};
}

describe("restoreColumnBackup", () => {
	it("reports corrupt Yjs without committing KV projections", async () => {
		const { env, records } = bindings(422);
		const result = await restoreColumnBackup({
			env,
			columnId,
			payload: await payload(),
			createPreRestoreBackup: async () => ({ key: "pre-backup" }),
		});

		expect(result).toEqual({ ok: false, code: "invalid_yjs_update" });
		expect(records.has("public:AbCd1234")).toBe(false);
		expect(records.get("account:1111222233334444")).toContain(
			'"columnOrder":[]',
		);
	});

	it("does not commit KV projections when the DO import fails", async () => {
		const { env, records } = bindings(500);
		const result = await restoreColumnBackup({
			env,
			columnId,
			payload: await payload(),
			createPreRestoreBackup: async () => ({ key: "pre-backup" }),
		});
		expect(result).toEqual({ ok: false, code: "restore_failed" });
		expect(records.has("public:AbCd1234")).toBe(false);
		expect(records.get("account:1111222233334444")).toBeDefined();
	});

	it("repairs owner, collaborator, and public projections after import", async () => {
		const { env, records } = bindings(200);
		const writes: Array<string> = [];
		const result = await restoreColumnBackup({
			env,
			columnId,
			payload: await payload(),
			createPreRestoreBackup: async () => ({ key: "pre-backup" }),
			afterWrite: (boundary) => {
				writes.push(boundary);
			},
		});
		expect(result).toMatchObject({ ok: true, preRestoreBackupKey: "pre-backup" });
		expect(records.get("shared:9999888877776666")).toBe(JSON.stringify([columnId]));
		expect(records.get("public:AbCd1234")).toBe(columnId);
		expect(writes).toContain("column-import");
		expect(writes).toContain("owner-account");
	});
});
