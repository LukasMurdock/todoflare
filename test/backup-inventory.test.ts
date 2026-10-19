import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { collectBackupInventory, collectRegisteredColumns } from "../src/server/column-backups";

const OWNER = "1111222233334444";
const OTHER = "5555666677778888";

async function register(columnId: string, ownerId: string) {
	await env.ACCOUNTS.put(
		`column-registry:${columnId}`,
		JSON.stringify({ schemaVersion: 1, id: columnId, ownerId, sharedWith: [], publicId: null, createdAt: 1 }),
	);
}

describe("backup inventory", () => {
	it("groups registered columns by owner and counts corrupt registry entries", async () => {
		const owned = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
		const other = "00000000-0000-4000-8000-000000000003";
		for (const id of owned) await register(id, OWNER);
		await register(other, OTHER);
		await env.ACCOUNTS.put("column-registry:00000000-0000-4000-8000-000000000004", "{");

		const registered = await collectRegisteredColumns(env);

		expect(registered.columnsByOwner.get(OWNER)?.sort()).toEqual(owned);
		expect(registered.columnsByOwner.get(OTHER)).toEqual([other]);
		expect(registered.invalid).toBe(1);
		expect(registered.columnIds.sort()).toEqual([...owned, other].sort());
	});

	it("includes registered columns that no account lists in the full inventory", async () => {
		const orphan = "00000000-0000-4000-8000-000000000005";
		await register(orphan, OWNER);

		const inventory = await collectBackupInventory(env);

		expect(inventory.columnIds).toContain(orphan);
		expect(inventory.columnsByOwner.get(OWNER)).toContain(orphan);
	});
});
