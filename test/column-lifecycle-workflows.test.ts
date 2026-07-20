import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	deleteColumn,
	type DeleteColumnWriteBoundary,
} from "../src/server/workflows/delete-column";
import {
	restoreColumn,
	type RestoreColumnWriteBoundary,
} from "../src/server/workflows/restore-column";
import {
	shareColumn as shareColumnWorkflow,
	type ShareColumnWriteBoundary,
} from "../src/server/workflows/share-column";
import {
	enablePublicColumn,
	type EnablePublicColumnWriteBoundary,
} from "../src/server/workflows/enable-public-column";
import type { Account, ColumnMeta } from "../src/types/account";

function normalizeAccountId(id: string): string {
	return id.replace(/\D/g, "");
}

async function createAccount(): Promise<string> {
	const syntheticIp = `10.2.0.${Math.floor(Math.random() * 200) + 10}`;
	const response = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
		headers: { "X-Forwarded-For": syntheticIp },
	});
	expect(response.ok).toBe(true);
	return ((await response.json()) as { account: Account }).account.id;
}

async function createColumn(accountId: string): Promise<string> {
	const response = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accountId }),
	});
	expect(response.ok).toBe(true);
	return ((await response.json()) as { column: ColumnMeta }).column.id;
}

async function shareColumn(
	ownerId: string,
	columnId: string,
	targetId: string,
): Promise<void> {
	const response = await SELF.fetch(
		`http://example.com/api/column/${columnId}/share`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Account-ID": ownerId,
			},
			body: JSON.stringify({ targetAccountId: targetId }),
		},
	);
	expect(response.ok).toBe(true);
}

async function enablePublic(ownerId: string, columnId: string): Promise<string> {
	const response = await SELF.fetch(
		`http://example.com/api/column/${columnId}/public`,
		{ method: "POST", headers: { "X-Account-ID": ownerId } },
	);
	expect(response.ok).toBe(true);
	return ((await response.json()) as { publicId: string }).publicId;
}

async function routeDelete(ownerId: string, columnId: string): Promise<void> {
	const response = await SELF.fetch(`http://example.com/api/column/${columnId}`, {
		method: "DELETE",
		headers: { "X-Account-ID": ownerId },
	});
	expect(response.ok).toBe(true);
}

async function loadAccount(accountId: string): Promise<Account> {
	const raw = await env.ACCOUNTS.get(`account:${normalizeAccountId(accountId)}`);
	expect(raw).not.toBeNull();
	return JSON.parse(raw as string) as Account;
}

async function loadMeta(columnId: string): Promise<ColumnMeta> {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const response = await stub.fetch(new Request("http://do/meta"));
	expect(response.ok).toBe(true);
	return (await response.json()) as ColumnMeta;
}

describe("deleteColumn lifecycle workflow", () => {
	const fixedNow = 1_800_000_000_000;

	for (const boundaryName of [
		"owner-account",
		"shared-account",
		"public-mapping",
		"column-shares",
		"column-public",
		"trash",
	] as const) {
		it(`repairs a failure after the ${boundaryName} write`, async () => {
			const ownerId = await createAccount();
			const collaboratorId = await createAccount();
			const columnId = await createColumn(ownerId);
			await shareColumn(ownerId, columnId, collaboratorId);
			const publicId = await enablePublic(ownerId, columnId);
			const expectedBoundary: DeleteColumnWriteBoundary =
				boundaryName === "shared-account"
					? `shared-account:${normalizeAccountId(collaboratorId)}`
					: boundaryName;

			await expect(
				deleteColumn({
					env,
					columnId,
					accountId: ownerId,
					now: () => fixedNow,
					afterWrite: (boundary) => {
						if (boundary === expectedBoundary) {
							throw new Error(`injected failure after ${boundary}`);
						}
					},
				}),
			).rejects.toThrow(`injected failure after ${expectedBoundary}`);

			const retried = await deleteColumn({
				env,
				columnId,
				accountId: ownerId,
				now: () => fixedNow,
			});
			expect(retried).toMatchObject({ ok: true });

			const owner = await loadAccount(ownerId);
			expect(owner.columnOrder).not.toContain(columnId);
			const sharedRaw = await env.ACCOUNTS.get(
				`shared:${normalizeAccountId(collaboratorId)}`,
			);
			expect(JSON.parse(sharedRaw ?? "[]") as string[]).not.toContain(columnId);
			expect(await env.ACCOUNTS.get(`public:${publicId}`)).toBeNull();

			const meta = await loadMeta(columnId);
			expect(meta.sharedWith).toEqual([]);
			expect(meta.publicId).toBeNull();
			const trash = JSON.parse(
				(await env.ACCOUNTS.get(`trash:${normalizeAccountId(ownerId)}`)) ?? "[]",
			) as Array<{ columnId: string; deletedAt: number }>;
			expect(trash).toContainEqual({ columnId, deletedAt: fixedNow });
		});
	}
});

describe("restoreColumn lifecycle workflow", () => {
	for (const boundary of [
		"owner-account",
		"trash",
	] satisfies RestoreColumnWriteBoundary[]) {
		it(`repairs a failure after the ${boundary} write`, async () => {
			const ownerId = await createAccount();
			const columnId = await createColumn(ownerId);
			await routeDelete(ownerId, columnId);

			await expect(
				restoreColumn({
					env,
					columnId,
					accountId: ownerId,
					afterWrite: (observed) => {
						if (observed === boundary) {
							throw new Error(`injected failure after ${observed}`);
						}
					},
				}),
			).rejects.toThrow(`injected failure after ${boundary}`);

			const retried = await restoreColumn({
				env,
				columnId,
				accountId: ownerId,
			});
			expect(retried).toMatchObject({
				ok: true,
				value: { success: true, column: { id: columnId } },
			});

			const owner = await loadAccount(ownerId);
			expect(owner.columnOrder.filter((id) => id === columnId)).toHaveLength(1);
			const trash = JSON.parse(
				(await env.ACCOUNTS.get(`trash:${normalizeAccountId(ownerId)}`)) ?? "[]",
			) as Array<{ columnId: string }>;
			expect(trash.some((entry) => entry.columnId === columnId)).toBe(false);
		});
	}
});

describe("shareColumn lifecycle workflow", () => {
	for (const boundary of [
		"column-shares",
		"shared-account",
	] satisfies ShareColumnWriteBoundary[]) {
		it(`repairs a failure after the ${boundary} write`, async () => {
			const ownerId = await createAccount();
			const collaboratorId = await createAccount();
			const columnId = await createColumn(ownerId);

			await expect(
				shareColumnWorkflow({
					env,
					columnId,
					accountId: ownerId,
					targetAccountId: collaboratorId,
					afterWrite: (observed) => {
						if (observed === boundary) {
							throw new Error(`injected failure after ${observed}`);
						}
					},
				}),
			).rejects.toThrow(`injected failure after ${boundary}`);

			const retried = await shareColumnWorkflow({
				env,
				columnId,
				accountId: ownerId,
				targetAccountId: collaboratorId,
			});
			expect(retried).toMatchObject({ ok: true });

			const meta = await loadMeta(columnId);
			expect(
				meta.sharedWith.filter(
					(id) => normalizeAccountId(id) === normalizeAccountId(collaboratorId),
				),
			).toHaveLength(1);
			const shared = JSON.parse(
				(await env.ACCOUNTS.get(
					`shared:${normalizeAccountId(collaboratorId)}`,
				)) ?? "[]",
			) as string[];
			expect(shared.filter((id) => id === columnId)).toHaveLength(1);
		});
	}
});

describe("enablePublicColumn lifecycle workflow", () => {
	for (const boundary of [
		"column-public",
		"public-mapping",
	] satisfies EnablePublicColumnWriteBoundary[]) {
		it(`repairs a failure after the ${boundary} write without rotating the link`, async () => {
			const ownerId = await createAccount();
			const columnId = await createColumn(ownerId);
			const expectedPublicId = `P${crypto.randomUUID().replaceAll("-", "").slice(0, 7)}`;

			await expect(
				enablePublicColumn({
					env,
					columnId,
					accountId: ownerId,
					createPublicId: () => expectedPublicId,
					afterWrite: (observed) => {
						if (observed === boundary) {
							throw new Error(`injected failure after ${observed}`);
						}
					},
				}),
			).rejects.toThrow(`injected failure after ${boundary}`);

			const retried = await enablePublicColumn({
				env,
				columnId,
				accountId: ownerId,
				createPublicId: () => "Different",
			});
			expect(retried).toEqual({
				ok: true,
				value: { publicId: expectedPublicId },
			});
			expect(await env.ACCOUNTS.get(`public:${expectedPublicId}`)).toBe(columnId);
			expect((await loadMeta(columnId)).publicId).toBe(expectedPublicId);
		});
	}
});
