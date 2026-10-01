import { describe, expect, it, vi } from "vitest";
import {
	applyAccountCommand,
	applyCommandEffects,
	applyPendingCommands,
	projectionFromLocalSnapshot,
	projectionFromServer,
} from "../src/lib/sync/account-projection";
import {
	fetchAccountProjection,
	parseGetAccountResponse,
} from "../src/lib/sync/account-api-client";
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
		ownedColumns: [],
		sharedColumns: [],
		deletedColumns: [],
	});
}

describe("account projection", () => {
	it("rejects a server response that omits authoritative owned metadata", () => {
		expect(() =>
			parseGetAccountResponse({
				account: baseProjection().account,
				sharedColumns: [],
				deletedColumns: [],
			}),
		).toThrow("Account response has invalid shape");
	});

	it("rejects owned metadata that belongs to a different account", () => {
		expect(() =>
			parseGetAccountResponse({
				account: {
					...baseProjection().account,
					columnOrder: [COLUMN_ID],
				},
				ownedColumns: [
					{
						schemaVersion: 1,
						id: COLUMN_ID,
						ownerId: TARGET_ID,
						sharedWith: [],
						publicId: null,
						createdAt: 1,
					},
				],
				sharedColumns: [],
				deletedColumns: [],
			}),
		).toThrow("Account response has invalid shape");
	});

	it("preserves retry-after from a rate-limited account response", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ retryAfter: 7 }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			await expect(
				fetchAccountProjection(ACCOUNT_ID, new AbortController().signal, "hydrate"),
			).rejects.toMatchObject({ retryAfterMs: 7_000 });
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("keeps the public account ID out of credentials and URLs", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 401 }),
		);
		try {
			await expect(fetchAccountProjection(
				ACCOUNT_ID,
				new AbortController().signal,
				"hydrate",
			)).rejects.toBeDefined();
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe("/api/account");
			expect(String(url)).not.toContain("1111111111111111");
			expect(new Headers(init?.headers).get("Authorization")).toBeNull();
		} finally {
			fetchMock.mockRestore();
		}
	});

	it("builds owned metadata only from the authoritative server response", () => {
		const projected = projectionFromServer({
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
			});

		expect(projected.sharedWithByColumn[COLUMN_ID]).toEqual([TARGET_ID]);
		expect(projected.publicLinksByColumn[COLUMN_ID]).toEqual({
			publicId: "public-1",
			url: "/p/public-1",
		});
	});

	it("retains sharing metadata only through the local snapshot path", () => {
		const projected = projectionFromLocalSnapshot({
			account: baseProjection().account,
			sharedWithByColumn: { [COLUMN_ID]: [TARGET_ID] },
			publicLinksByColumn: {
				[COLUMN_ID]: { publicId: "public-1", url: "/p/public-1" },
			},
		});

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
