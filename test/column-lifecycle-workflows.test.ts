import { accountContractSchema } from "../src/lib/api/account-contract";
import { z } from "zod";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deleteColumn } from '../src/server/workflows/delete-column';
import type { DeleteColumnWriteBoundary } from '../src/server/workflows/delete-column';
import { restoreColumn } from '../src/server/workflows/restore-column';
import type { RestoreColumnWriteBoundary } from '../src/server/workflows/restore-column';
import { shareColumn as shareColumnWorkflow } from '../src/server/workflows/share-column';
import type { ShareColumnWriteBoundary } from '../src/server/workflows/share-column';
import { enablePublicColumn } from '../src/server/workflows/enable-public-column';
import type { EnablePublicColumnWriteBoundary } from '../src/server/workflows/enable-public-column';
import { revokeColumnShare } from '../src/server/workflows/revoke-column-share';
import type { RevokeColumnShareWriteBoundary } from '../src/server/workflows/revoke-column-share';
import { disablePublicColumn } from '../src/server/workflows/disable-public-column';
import type { DisablePublicColumnWriteBoundary } from '../src/server/workflows/disable-public-column';
import type { Account, ColumnMeta } from "../src/types/account";

function accountHeaders(accountId: string) {
	return { "X-Todoflare-Test-Account": accountId.replaceAll(/\D/g, "") };
}

function normalizeAccountId(id: string): string {
	return id.replaceAll(/\D/g, "");
}

async function createAccount(): Promise<string> {
	const syntheticIp = `10.2.0.${Math.floor(Math.random() * 200) + 10}`;
	const response = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
		headers: { "X-Forwarded-For": syntheticIp },
	});
	expect(response.ok).toBe(true);
	return ((await response.json<{ account: Account }>())).account.id;
}

async function createColumn(accountId: string): Promise<string> {
	const response = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Todoflare-Test-Account": accountId.replaceAll(/\D/g, ""),
		},
		body: JSON.stringify({}),
	});
	expect(response.ok).toBe(true);
	return ((await response.json<{ column: ColumnMeta }>())).column.id;
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
				...accountHeaders(ownerId),
			},
			body: JSON.stringify({ targetAccountId: targetId }),
		},
	);
	expect(response.ok).toBe(true);
}

async function enablePublic(ownerId: string, columnId: string): Promise<string> {
	const response = await SELF.fetch(
		`http://example.com/api/column/${columnId}/public`,
		{ method: "POST", headers: accountHeaders(ownerId) },
	);
	expect(response.ok).toBe(true);
	return ((await response.json<{ publicId: string }>())).publicId;
}

async function routeDelete(ownerId: string, columnId: string): Promise<void> {
	const response = await SELF.fetch(`http://example.com/api/column/${columnId}`, {
		method: "DELETE",
		headers: accountHeaders(ownerId),
	});
	expect(response.ok).toBe(true);
}

async function loadAccount(accountId: string): Promise<Account> {
	const raw = await env.ACCOUNTS.get(`account:${normalizeAccountId(accountId)}`);
	expect(raw).not.toBeNull();
	return accountContractSchema.parse(JSON.parse(raw ?? "null"));
}

async function loadMeta(columnId: string): Promise<ColumnMeta> {
	const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const response = await stub.fetch(new Request("http://do/meta"));
	expect(response.ok).toBe(true);
	return (await response.json<ColumnMeta>());
}

describe("deleteColumn lifecycle workflow", () => {
	const fixedNow = 1_800_000_000_000;

	it("fails before removing access when existing trash is malformed", async () => {
		const ownerId = await createAccount();
		const columnId = await createColumn(ownerId);
		const normalizedOwnerId = normalizeAccountId(ownerId);
		const trashKey = `trash:${normalizedOwnerId}`;
		const coordinator = env.ACCOUNT_COORDINATOR.get(
			env.ACCOUNT_COORDINATOR.idFromName(normalizedOwnerId),
		);
		await coordinator.fetch(
			new Request("http://account-coordinator/put", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: trashKey, value: "{" }),
			}),
		);

		const result = await deleteColumn({ env, columnId, accountId: ownerId });

		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "schema", record: "trash", result: { code: "invalid_json" } },
		});
		expect((await loadAccount(ownerId)).columnOrder).toContain(columnId);
		expect((await loadMeta(columnId)).id).toBe(columnId);
	});

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
			expect(z.array(z.string()).parse(JSON.parse(sharedRaw ?? "[]"))).not.toContain(columnId);
			expect(await env.ACCOUNTS.get(`public:${publicId}`)).toBeNull();

			const meta = await loadMeta(columnId);
			expect(meta.sharedWith).toEqual([]);
			expect(meta.publicId).toBeNull();
			const trash = z.array(z.object({ columnId: z.string(), deletedAt: z.number() })).parse(JSON.parse(
				(await env.ACCOUNTS.get(`trash:${normalizeAccountId(ownerId)}`)) ?? "[]",
			));
			expect(trash).toContainEqual({ columnId, deletedAt: fixedNow });
		});
	}
});

describe("restoreColumn lifecycle workflow", () => {
	it("fails closed and preserves malformed trash", async () => {
		const ownerId = await createAccount();
		const columnId = await createColumn(ownerId);
		await routeDelete(ownerId, columnId);
		const normalizedOwnerId = normalizeAccountId(ownerId);
		const trashKey = `trash:${normalizedOwnerId}`;
		const coordinator = env.ACCOUNT_COORDINATOR.get(
			env.ACCOUNT_COORDINATOR.idFromName(normalizedOwnerId),
		);
		await coordinator.fetch(
			new Request("http://account-coordinator/put", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: trashKey, value: "{" }),
			}),
		);

		const result = await restoreColumn({ env, columnId, accountId: ownerId });

		expect(result).toMatchObject({
			ok: false,
			failure: { kind: "schema", record: "trash", result: { code: "invalid_json" } },
		});
		expect((await loadAccount(ownerId)).columnOrder).not.toContain(columnId);
		const rawResponse = await coordinator.fetch(
			new Request("http://account-coordinator/get", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key: trashKey }),
			}),
		);
		expect(((await rawResponse.json<{ value: string }>())).value).toBe("{");
	});

	for (const boundary of [
		"owner-account",
		"trash",
	] satisfies Array<RestoreColumnWriteBoundary>) {
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
			const trash = z.array(z.object({ columnId: z.string() })).parse(JSON.parse(
				(await env.ACCOUNTS.get(`trash:${normalizeAccountId(ownerId)}`)) ?? "[]",
			));
			expect(trash.some((entry) => entry.columnId === columnId)).toBe(false);
		});
	}
});

describe("shareColumn lifecycle workflow", () => {
	for (const boundary of [
		"column-shares",
		"shared-account",
	] satisfies Array<ShareColumnWriteBoundary>) {
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
			const shared = z.array(z.string()).parse(JSON.parse(
				(await env.ACCOUNTS.get(
					`shared:${normalizeAccountId(collaboratorId)}`,
				)) ?? "[]",
			));
			expect(shared.filter((id) => id === columnId)).toHaveLength(1);
		});
	}
});

describe("enablePublicColumn lifecycle workflow", () => {
	it("retries generated ID collisions without overwriting their mappings", async () => {
		const ownerId = await createAccount();
		const columnId = await createColumn(ownerId);
		const candidates = ["Collision", "Available"];
		await env.ACCOUNTS.put("public:Collision", "another-column");

		const result = await enablePublicColumn({
			env,
			columnId,
			accountId: ownerId,
			createPublicId: () => {
				const next = candidates.shift();
				if (!next) { throw new Error("Candidate list exhausted"); }
				return next;
			},
		});

		expect(result).toEqual({ ok: true, value: { publicId: "Available" } });
		expect(await env.ACCOUNTS.get("public:Collision")).toBe("another-column");
		expect(await env.ACCOUNTS.get("public:Available")).toBe(columnId);
	});

	it("stops after bounded public ID collisions without changing the column", async () => {
		const ownerId = await createAccount();
		const columnId = await createColumn(ownerId);
		await env.ACCOUNTS.put("public:Collision", "another-column");

		await expect(
			enablePublicColumn({
				env,
				columnId,
				accountId: ownerId,
				createPublicId: () => "Collision",
				maxPublicIdAttempts: 2,
			}),
		).rejects.toThrow("Unable to allocate a unique ID after 2 attempts");

		expect(await env.ACCOUNTS.get("public:Collision")).toBe("another-column");
		expect((await loadMeta(columnId)).publicId).toBeNull();
	});

	for (const boundary of [
		"column-public",
		"public-mapping",
	] satisfies Array<EnablePublicColumnWriteBoundary>) {
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

describe("revokeColumnShare lifecycle workflow", () => {
	for (const boundary of [
		"column-shares",
		"shared-account",
	] satisfies Array<RevokeColumnShareWriteBoundary>) {
		it(`repairs a failure after the ${boundary} write`, async () => {
			const ownerId = await createAccount();
			const collaboratorId = await createAccount();
			const columnId = await createColumn(ownerId);
			await shareColumn(ownerId, columnId, collaboratorId);

			await expect(
				revokeColumnShare({
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

			const retried = await revokeColumnShare({
				env,
				columnId,
				accountId: ownerId,
				targetAccountId: collaboratorId,
			});
			expect(retried).toEqual({
				ok: true,
				value: { success: true, sharedWith: [] },
			});
			expect((await loadMeta(columnId)).sharedWith).toEqual([]);
			const shared = z.array(z.string()).parse(JSON.parse(
				(await env.ACCOUNTS.get(
					`shared:${normalizeAccountId(collaboratorId)}`,
				)) ?? "[]",
			));
			expect(shared).not.toContain(columnId);
		});
	}
});

describe("disablePublicColumn lifecycle workflow", () => {
	for (const boundary of [
		"public-mapping",
		"column-public",
	] satisfies Array<DisablePublicColumnWriteBoundary>) {
		it(`repairs a failure after the ${boundary} write`, async () => {
			const ownerId = await createAccount();
			const columnId = await createColumn(ownerId);
			const publicId = await enablePublic(ownerId, columnId);

			await expect(
				disablePublicColumn({
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

			const retried = await disablePublicColumn({
				env,
				columnId,
				accountId: ownerId,
			});
			expect(retried).toEqual({ ok: true, value: { success: true } });
			expect(await env.ACCOUNTS.get(`public:${publicId}`)).toBeNull();
			expect((await loadMeta(columnId)).publicId).toBeNull();
		});
	}
});
