import { env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeAccountId } from "../src/lib/account";
import { lifecycleOperationKey } from "../src/server/lifecycle-journal";
import { claimPublicId } from "../src/server/public-id-registry";
import { runJournaledLifecycle } from "../src/server/routes/account-commands";
import { deleteColumn } from "../src/server/workflows/delete-column";
import { enablePublicColumn } from "../src/server/workflows/enable-public-column";
import { reconcileColumnLifecycle } from "../src/server/workflows/reconcile-column-lifecycle";
import { restoreColumn } from "../src/server/workflows/restore-column";
import { shareColumn } from "../src/server/workflows/share-column";
import { createColumn, headers, loadAuthoritativeAccount } from "./helpers/metadata-fixtures";

function interruptAfter(boundary: string) {
	return (written: string) => {
		if (written === boundary) {
			throw new Error(`interrupted after ${written}`);
		}
	};
}

async function recover(operationId: string) {
	const key = lifecycleOperationKey(operationId);
	expect(await env.ACCOUNTS.get(key)).not.toBeNull();
	const result = await reconcileColumnLifecycle(env);
	expect(result).toMatchObject({ operationsCompleted: 1, operationsFailed: 0 });
	expect(await env.ACCOUNTS.get(key)).toBeNull();
}

async function createFixture() {
	// The reconciler scans the whole registry. Replaying any history must see
	// exactly its own records, including after another history fails midway.
	await reset();
	const ownerId = "1111 1111 1111 1111";
	const guestId = "2222 2222 2222 2222";
	// Authenticated fixture headers bypass passkey login; these workflows own
	// only the coordinator, room, and KV state.
	const accounts = await Promise.all([ownerId, guestId].map(id =>
		SELF.fetch("http://example.com/api/account", { method: "POST", headers: headers(id) }),
	));
	expect(accounts.map(response => response.ok)).toEqual([true, true]);
	const columnId = await createColumn(ownerId);
	const common = { accountId: ownerId, columnId };
	const room = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
	const accessState = async () => (await room.fetch(new Request("http://do/access-state"))).json();
	const sharedKey = `shared:${normalizeAccountId(guestId)}`;
	const trashKey = `trash:${normalizeAccountId(ownerId)}`;
	const columnRead = async (accountId: string) =>
		(await SELF.fetch(`http://example.com/api/column/${columnId}`, { headers: headers(accountId) })).status;

	const link = await enablePublicColumn({ env, ...common });
	if (!link.ok) {throw new Error("Unable to enable public link");}
	const { publicId } = link.value;
	const publicRead = async () => (await SELF.fetch(`http://example.com/api/p/${publicId}`)).status;
	expect(await publicRead()).toBe(200);

	async function observedState() {
		const [ownerAccount, roomState, trash, shared, publicMapping, collaboratorStatus, publicStatus] = await Promise.all([
			loadAuthoritativeAccount(ownerId), accessState(), env.ACCOUNTS.get(trashKey, "json"),
			env.ACCOUNTS.get(sharedKey, "json"), env.ACCOUNTS.get(`public:${publicId}`),
			columnRead(guestId), publicRead(),
		]);
		return { order: ownerAccount.columnOrder, roomState, trash, shared, publicMapping, collaboratorStatus, publicStatus };
	}
	return { common, guestId, sharedKey, publicId, columnRead, publicRead, observedState };
}

const deleteCuts = ["owner-account", "shared-account", "public-mapping", "column-shares", "column-public", "trash"] as const;
const restoreCuts = ["owner-account", "trash"] as const;

for (const restoreCut of restoreCuts) {
	const shareCut = restoreCut === "owner-account" ? "column-shares" : "shared-account";
	describe(`share interrupted after ${shareCut}, restore interrupted after ${restoreCut}`, () => {
		let fixture: Awaited<ReturnType<typeof createFixture>>;

		beforeEach(async () => {
			fixture = await createFixture();
		});

		for (const deleteCut of deleteCuts) {
			it(`recovers across delete interrupted after ${deleteCut}`, async () => {
				const { common, guestId, sharedKey, publicId, columnRead, publicRead, observedState } = fixture;
				const { accountId, columnId } = common;
				const sharing = { ...common, targetAccountId: guestId, kind: "share", operationId: crypto.randomUUID(), createdAt: Date.now() } as const;
				await expect(runJournaledLifecycle(env, sharing, () =>
					shareColumn({ env, ...common, targetAccountId: guestId, afterWrite: interruptAfter(shareCut) }),
				)).rejects.toThrow(`interrupted after ${shareCut}`);
				expect(await columnRead(guestId)).toBe(200);
				await recover(sharing.operationId);
				expect(await env.ACCOUNTS.get(sharedKey, "json")).toEqual([columnId]);

				const deletion = { ...common, operationId: crypto.randomUUID(), createdAt: Date.now(), kind: "delete" } as const;
				const boundary = deleteCut === "shared-account" ? `shared-account:${normalizeAccountId(guestId)}` : deleteCut;
				await expect(runJournaledLifecycle(env, deletion, () =>
					deleteColumn({ env, ...common, afterWrite: interruptAfter(boundary) }),
				)).rejects.toThrow(`interrupted after ${boundary}`);
				const beforePublicRelease = deleteCut === "owner-account" || deleteCut === "shared-account";
				const beforeShareRemoval = beforePublicRelease || deleteCut === "public-mapping";
				expect(await Promise.all([publicRead(), columnRead(guestId)])).toEqual([
					beforePublicRelease ? 200 : 404, beforeShareRemoval ? 200 : 403,
				]);

				await recover(deletion.operationId);
				const privateState = { shared: [], publicMapping: null, publicStatus: 404, collaboratorStatus: 403 };
				expect(await observedState()).toMatchObject({
					...privateState, order: [], trash: [{ columnId, deletedAt: expect.any(Number) }],
					roomState: { trashed: true, meta: { sharedWith: [], publicId: null } },
				});

				// Even a stale authoritative public-ID claim cannot reopen a trashed column.
				expect(await claimPublicId(env, publicId, columnId)).toBe(true);
				expect(await publicRead()).toBe(404);
				const restoration = { ...common, operationId: crypto.randomUUID(), createdAt: Date.now(), kind: "restore" } as const;
				await expect(runJournaledLifecycle(env, restoration, () =>
					restoreColumn({ env, ...common, afterWrite: interruptAfter(restoreCut) }),
				)).rejects.toThrow(`interrupted after ${restoreCut}`);
				await recover(restoration.operationId);

				expect(await observedState()).toMatchObject({
					...privateState, order: [columnId], trash: [],
					roomState: { trashed: false, meta: { sharedWith: [], publicId: null } },
				});
				expect(await columnRead(accountId)).toBe(200);
				const secondPass = await reconcileColumnLifecycle(env);
				expect(secondPass).toMatchObject({
					operationsRetried: 0, ownerMembershipRepaired: 0, ownerMembershipRemoved: 0,
					sharedMembershipRepaired: 0, sharedMembershipRemoved: 0, publicMappingsRemoved: 0,
				});
			});
		}
	});
}
