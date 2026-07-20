import { describe, expect, it } from "vitest";
import {
	applyAccountCommand,
	applyCommandEffects,
	applyPendingCommands,
	projectionFromServer,
} from "../src/lib/sync/account-projection";
import type {
	AccountCommandPayloadMap,
	AccountCommandType,
	QueuedMutation,
} from "../src/lib/sync/contracts";

const ACCOUNT_ID = "1111 1111 1111 1111";
const TARGET_ID = "2222 2222 2222 2222";
const COLUMN_ID = "00000000-0000-4000-8000-000000000001";

function command<T extends AccountCommandType>(
	opType: T,
	payload: AccountCommandPayloadMap[T],
	createdAt = 10,
): QueuedMutation<T> {
	return {
		opType,
		payload,
		queueId: `queue:${opType}`,
		idempotencyKey: `key:${opType}`,
		entityId: ACCOUNT_ID,
		createdAt,
		attemptCount: 0,
		nextRetryAt: 0,
	} as unknown as QueuedMutation<T>;
}

function baseProjection() {
	return projectionFromServer({
		account: {
			schemaVersion: 1,
			id: ACCOUNT_ID,
			columnOrder: ["existing"],
			hiddenSharedColumns: [],
			createdAt: 1,
		},
		sharedColumns: [],
		deletedColumns: [],
	});
}

describe("account projection", () => {
	it("replaces retained owned metadata with the authoritative server response", () => {
		const projected = projectionFromServer(
			{
				account: baseProjection().account,
				ownedColumns: [
					{
						schemaVersion: 1,
						id: COLUMN_ID,
						ownerId: ACCOUNT_ID,
						sharedWith: [TARGET_ID],
						publicId: "public-1",
						createdAt: 1,
					},
				],
				sharedColumns: [],
				deletedColumns: [],
			},
			{
				sharedWithByColumn: { [COLUMN_ID]: ["stale"] },
				publicLinksByColumn: { [COLUMN_ID]: null },
			},
		);

		expect(projected.sharedWithByColumn[COLUMN_ID]).toEqual([TARGET_ID]);
		expect(projected.publicLinksByColumn[COLUMN_ID]).toEqual({
			publicId: "public-1",
			url: "/p/public-1",
		});
	});

	it("overlays every pending command without mutating the server base", () => {
		const base = baseProjection();
		const projected = applyPendingCommands(base, [
			command("column.create", { columnId: COLUMN_ID }),
			command("column.reorder", { columnOrder: [COLUMN_ID, "existing"] }),
			command("column.hide_shared", { hiddenSharedColumns: ["shared"] }),
			command("column.share", {
				columnId: COLUMN_ID,
				targetAccountId: "2222 2222 2222 2222",
			}),
			command("column.revoke", {
				columnId: COLUMN_ID,
				targetAccountId: "2222 2222 2222 2222",
			}),
			command("column.public.enable", { columnId: COLUMN_ID }),
			command("column.public.disable", { columnId: COLUMN_ID }),
			command("column.delete", { columnId: COLUMN_ID }, 20),
			command("column.restore", { columnId: COLUMN_ID }, 30),
		]);

		expect(base.account.columnOrder).toEqual(["existing"]);
		expect(projected.account.columnOrder).toEqual(["existing", COLUMN_ID]);
		expect(projected.account.hiddenSharedColumns).toEqual(["shared"]);
		expect(projected.deletedColumns).toEqual([]);
		expect(projected.sharedWithByColumn[COLUMN_ID]).toEqual([]);
		expect(projected.publicLinksByColumn[COLUMN_ID]).toBeNull();
	});

	it("keeps pending optimistic intent when a new server base is installed", () => {
		const pending = command("column.reorder", {
			columnOrder: [COLUMN_ID, "existing"],
		});
		const staleServer = baseProjection();

		expect(applyPendingCommands(staleServer, [pending]).account.columnOrder).toEqual([
			COLUMN_ID,
			"existing",
		]);
	});

	it("applies authoritative command effects to the confirmed base", () => {
		const base = applyAccountCommand(
			baseProjection(),
			command("column.create", { columnId: COLUMN_ID }),
		);
		const projected = applyCommandEffects(base, [
			{
				type: "column.sharing.updated",
				columnId: COLUMN_ID,
				sharedWith: ["2222 2222 2222 2222"],
			},
			{
				type: "column.public.enabled",
				queueId: "queue",
				columnId: COLUMN_ID,
				publicLink: { publicId: "public", url: "/p/public" },
			},
		]);

		expect(projected.sharedWithByColumn[COLUMN_ID]).toEqual([
			"2222 2222 2222 2222",
		]);
		expect(projected.publicLinksByColumn[COLUMN_ID]).toEqual({
			publicId: "public",
			url: "/p/public",
		});
	});
});
