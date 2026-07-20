import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	decodeWsFrame,
	WS_OP_PRESENCE,
	WS_OP_SYNC,
} from "../src/lib/collaboration/websocket-protocol";

function normalizeAccountId(id: string): string {
	return id.replace(/\D/g, "");
}

function toHex(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

async function sha256Hex(value: string): Promise<string> {
	const encoded = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return toHex(digest);
}

async function createAccount(): Promise<string> {
	const syntheticIp = `10.1.0.${Math.floor(Math.random() * 200) + 10}`;
	const res = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
		headers: { "X-Forwarded-For": syntheticIp },
	});
	expect(res.ok).toBe(true);
	const data = (await res.json()) as { account: { id: string } };
	expect(typeof data.account?.id).toBe("string");
	return data.account.id;
}

async function createColumn(accountId: string): Promise<string> {
	const res = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accountId }),
	});
	expect(res.ok).toBe(true);
	const data = (await res.json()) as { column: { id: string } };
	expect(typeof data.column?.id).toBe("string");
	return data.column.id;
}

async function createColumnWithId(
	accountId: string,
	columnId: string,
): Promise<string> {
	const res = await SELF.fetch("http://example.com/api/column", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ accountId, columnId }),
	});
	expect(res.ok).toBe(true);
	const data = (await res.json()) as { column: { id: string } };
	expect(data.column.id).toBe(columnId);
	return data.column.id;
}

async function deleteColumn(accountId: string, columnId: string): Promise<void> {
	const res = await SELF.fetch(`http://example.com/api/column/${columnId}`, {
		method: "DELETE",
		headers: { "X-Account-ID": accountId },
	});
	expect(res.ok).toBe(true);
}

async function restoreColumn(accountId: string, columnId: string): Promise<void> {
	const res = await SELF.fetch(`http://example.com/api/column/${columnId}/restore`, {
		method: "POST",
		headers: { "X-Account-ID": accountId },
	});
	expect(res.ok).toBe(true);
}

async function shareColumn(
	ownerAccountId: string,
	columnId: string,
	targetAccountId: string,
): Promise<void> {
	const res = await SELF.fetch(`http://example.com/api/column/${columnId}/share`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Account-ID": ownerAccountId,
		},
		body: JSON.stringify({ targetAccountId }),
	});
	expect(res.ok).toBe(true);
}

function getResponseWebSocket(response: Response): WebSocket {
	const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
	if (!ws) throw new Error("Expected Response.webSocket to be set");
	return ws;
}

function decodeOpcode(data: ArrayBuffer | string): number {
	if (typeof data === "string") {
		throw new Error("Expected binary WebSocket frame");
	}
	return decodeWsFrame(data).op;
}

function waitForWsMessage(ws: WebSocket, timeoutMs: number): Promise<MessageEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("Timed out waiting for WebSocket message"));
		}, timeoutMs);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timeout);
				resolve(event);
			},
			{ once: true },
		);
	});
}

describe("Worker routes", () => {
	it("serves /api/clock", async () => {
		const res = await SELF.fetch("http://example.com/api/clock");
		expect(res.ok).toBe(true);
		expect((await res.json()) as { time: string }).toHaveProperty("time");
	});

	it("does not implement GET /api/column", async () => {
		const res = await SELF.fetch("http://example.com/api/column");
		expect(res.status).toBe(404);
	});

	it("returns Account not found for unknown accounts", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/account/0000000000000000",
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: "Account not found" });
	});

	it("rejects column creation for unknown accounts", async () => {
		const res = await SELF.fetch("http://example.com/api/column", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId: "0000 0000 0000 0000" }),
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: "Account not found" });
	});

	it("rejects malformed JSON request bodies", async () => {
		const res = await SELF.fetch("http://example.com/api/column", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: "invalid_request",
			code: "invalid_request",
		});
	});

	it("rejects wrong array element types", async () => {
		const res = await SELF.fetch(
			"http://example.com/api/account/0000000000000000/columns",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ columnOrder: [42] }),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
	});

	it("rejects oversized column arrays", async () => {
		const columnOrder = Array.from({ length: 101 }, () => crypto.randomUUID());
		const res = await SELF.fetch(
			"http://example.com/api/account/0000000000000000/columns",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ columnOrder }),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
	});

	it("rejects invalid path, header, and query values", async () => {
		const invalidPath = await SELF.fetch(
			"http://example.com/api/account/not-an-account",
		);
		expect(invalidPath.status).toBe(400);

		const invalidHeader = await SELF.fetch(
			`http://example.com/api/column/${crypto.randomUUID()}`,
			{ headers: { "X-Account-ID": "invalid" } },
		);
		expect(invalidHeader.status).toBe(400);

		const invalidQuery = await SELF.fetch(
			`http://example.com/api/admin/backups/column/${crypto.randomUUID()}?limit=invalid`,
		);
		expect(invalidQuery.status).toBe(400);
	});

	it("rejects malformed account imports", async () => {
		const accountId = "0000000000000000";
		const res = await SELF.fetch(
			`http://example.com/api/account/${accountId}/import`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Account-ID": accountId,
				},
				body: JSON.stringify({
					schemaVersion: 1,
					exportedAt: 0,
					account: {},
					ownedColumns: [],
				}),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
	});

	it("accepts a current account export as an import payload", async () => {
		const accountId = await createAccount();
		await createColumn(accountId);
		const normalizedAccountId = normalizeAccountId(accountId);
		const exportResponse = await SELF.fetch(
			`http://example.com/api/account/${normalizedAccountId}/export`,
			{ headers: { "X-Account-ID": accountId } },
		);
		expect(exportResponse.ok).toBe(true);
		const payload = await exportResponse.json();

		const importResponse = await SELF.fetch(
			`http://example.com/api/account/${normalizedAccountId}/import`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Account-ID": accountId,
				},
				body: JSON.stringify(payload),
			},
		);

		expect(importResponse.ok).toBe(true);
		expect(await importResponse.json()).toMatchObject({
			success: true,
			importedColumns: 1,
		});
	});

	it("rejects invalid backup restore modes", async () => {
		const res = await SELF.fetch(
			`http://example.com/api/admin/backups/column/${crypto.randomUUID()}/restore`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "overwrite" }),
			},
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "invalid_request" });
	});

	it("creates a column for an existing account", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);

		const metaRes = await SELF.fetch(`http://example.com/api/column/${columnId}`,
			{
				headers: { "X-Account-ID": accountId },
			},
		);
		expect(metaRes.ok).toBe(true);
		const data = (await metaRes.json()) as { column: { id: string; ownerId: string } };
		expect(data.column.id).toBe(columnId);
		expect(data.column.ownerId).toBe(accountId);
	});

	it("distinguishes not-owner authorization from revoked access", async () => {
		const ownerId = await createAccount();
		const collaboratorId = await createAccount();
		const outsiderId = await createAccount();
		const columnId = await createColumn(ownerId);
		await shareColumn(ownerId, columnId, collaboratorId);

		const notOwnerResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}`,
			{
				method: "DELETE",
				headers: { "X-Account-ID": collaboratorId },
			},
		);
		expect(notOwnerResponse.status).toBe(403);
		expect(await notOwnerResponse.json()).toMatchObject({ code: "not_owner" });

		const revokedResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}`,
			{
				method: "DELETE",
				headers: { "X-Account-ID": outsiderId },
			},
		);
		expect(revokedResponse.status).toBe(403);
		expect(await revokedResponse.json()).toMatchObject({
			code: "access_revoked",
		});
	});

	it("creates a column using a client-provided id", async () => {
		const accountId = await createAccount();
		const columnId = crypto.randomUUID();
		const createdId = await createColumnWithId(accountId, columnId);

		expect(createdId).toBe(columnId);

		const accountRes = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(accountId)}`,
		);
		expect(accountRes.ok).toBe(true);
		const data = (await accountRes.json()) as {
			account: { columnOrder: string[] };
		};

		expect(data.account.columnOrder).toContain(columnId);
	});

	it("treats repeated create with same client id as idempotent", async () => {
		const accountId = await createAccount();
		const columnId = crypto.randomUUID();

		await createColumnWithId(accountId, columnId);
		await createColumnWithId(accountId, columnId);

		const accountRes = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(accountId)}`,
		);
		expect(accountRes.ok).toBe(true);
		const data = (await accountRes.json()) as {
			account: { columnOrder: string[] };
		};

		const occurrences = data.account.columnOrder.filter(
			(id) => id === columnId,
		).length;
		expect(occurrences).toBe(1);
	});

	it("moves deleted columns into garbage can list", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		await deleteColumn(accountId, columnId);

		const accountRes = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(accountId)}`,
		);
		expect(accountRes.ok).toBe(true);
		const data = (await accountRes.json()) as {
			account: { columnOrder: string[] };
			deletedColumns: Array<{ columnId: string; deletedAt: number }>;
		};

		expect(data.account.columnOrder).not.toContain(columnId);
		expect(data.deletedColumns.some((c) => c.columnId === columnId)).toBe(true);
	});

	it("restores a trashed column back into account order", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		await deleteColumn(accountId, columnId);
		await restoreColumn(accountId, columnId);

		const accountRes = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(accountId)}`,
		);
		expect(accountRes.ok).toBe(true);
		const data = (await accountRes.json()) as {
			account: { columnOrder: string[] };
			deletedColumns: Array<{ columnId: string }>;
		};

		expect(data.account.columnOrder).toContain(columnId);
		expect(data.deletedColumns.some((c) => c.columnId === columnId)).toBe(false);
	});

	it("replays restore response for duplicate idempotency key", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		await deleteColumn(accountId, columnId);

		const idempotencyKey = crypto.randomUUID();
		const requestRestore = () =>
			SELF.fetch(`http://example.com/api/column/${columnId}/restore`, {
				method: "POST",
				headers: {
					"X-Account-ID": accountId,
					"X-Idempotency-Key": idempotencyKey,
				},
			});

		const firstRestore = await requestRestore();
		expect(firstRestore.ok).toBe(true);
		const firstPayload = (await firstRestore.json()) as {
			success: boolean;
			column: { id: string };
		};
		expect(firstPayload.success).toBe(true);
		expect(firstPayload.column.id).toBe(columnId);

		const replayedRestore = await requestRestore();
		expect(replayedRestore.ok).toBe(true);
		expect(replayedRestore.headers.get("X-Idempotency-Replay")).toBe("1");
		const replayedPayload = (await replayedRestore.json()) as {
			success: boolean;
			column: { id: string };
		};
		expect(replayedPayload.success).toBe(true);
		expect(replayedPayload.column.id).toBe(columnId);
	});

	it("replays public-link enable response for duplicate idempotency key", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		const idempotencyKey = crypto.randomUUID();

		const enablePublic = () =>
			SELF.fetch(`http://example.com/api/column/${columnId}/public`, {
				method: "POST",
				headers: {
					"X-Account-ID": accountId,
					"X-Idempotency-Key": idempotencyKey,
				},
			});

		const firstEnable = await enablePublic();
		expect(firstEnable.ok).toBe(true);
		const firstPayload = (await firstEnable.json()) as {
			publicId: string;
			url: string;
		};
		expect(typeof firstPayload.publicId).toBe("string");

		const replayedEnable = await enablePublic();
		expect(replayedEnable.ok).toBe(true);
		expect(replayedEnable.headers.get("X-Idempotency-Replay")).toBe("1");
		const replayedPayload = (await replayedEnable.json()) as {
			publicId: string;
			url: string;
		};

		expect(replayedPayload.publicId).toBe(firstPayload.publicId);
		expect(replayedPayload.url).toBe(firstPayload.url);
	});

	it("repairs missing shared and public KV projections from DO metadata", async () => {
		const ownerId = await createAccount();
		const collaboratorId = await createAccount();
		const columnId = await createColumn(ownerId);
		await shareColumn(ownerId, columnId, collaboratorId);

		const enablePublic = () =>
			SELF.fetch(`http://example.com/api/column/${columnId}/public`, {
				method: "POST",
				headers: { "X-Account-ID": ownerId },
			});
		const firstPublicResponse = await enablePublic();
		expect(firstPublicResponse.ok).toBe(true);
		const firstPublic = (await firstPublicResponse.json()) as { publicId: string };

		const sharedKey = `shared:${normalizeAccountId(collaboratorId)}`;
		await env.ACCOUNTS.delete(sharedKey);
		await env.ACCOUNTS.delete(`public:${firstPublic.publicId}`);

		await shareColumn(ownerId, columnId, collaboratorId);
		const repairedPublicResponse = await enablePublic();
		expect(repairedPublicResponse.ok).toBe(true);
		const repairedPublic = (await repairedPublicResponse.json()) as {
			publicId: string;
		};

		expect(repairedPublic.publicId).toBe(firstPublic.publicId);
		expect(
			JSON.parse((await env.ACCOUNTS.get(sharedKey)) ?? "[]") as string[],
		).toContain(columnId);
		expect(await env.ACCOUNTS.get(`public:${firstPublic.publicId}`)).toBe(
			columnId,
		);
	});

	it("routes sharing revoke and public disable through lifecycle workflows", async () => {
		const ownerId = await createAccount();
		const collaboratorId = await createAccount();
		const columnId = await createColumn(ownerId);
		await shareColumn(ownerId, columnId, collaboratorId);

		const publicResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}/public`,
			{ method: "POST", headers: { "X-Account-ID": ownerId } },
		);
		expect(publicResponse.ok).toBe(true);
		const { publicId } = (await publicResponse.json()) as { publicId: string };

		const revokeResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}/share/${normalizeAccountId(collaboratorId)}`,
			{ method: "DELETE", headers: { "X-Account-ID": ownerId } },
		);
		expect(revokeResponse.ok).toBe(true);
		expect(await revokeResponse.json()).toEqual({
			success: true,
			sharedWith: [],
		});

		const disableResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}/public`,
			{ method: "DELETE", headers: { "X-Account-ID": ownerId } },
		);
		expect(disableResponse.ok).toBe(true);
		expect(await disableResponse.json()).toEqual({ success: true });

		expect(
			JSON.parse(
				(await env.ACCOUNTS.get(
					`shared:${normalizeAccountId(collaboratorId)}`,
				)) ?? "[]",
			) as string[],
		).not.toContain(columnId);
		expect(await env.ACCOUNTS.get(`public:${publicId}`)).toBeNull();
	});

	it("filters and removes a stale shared KV projection on account hydration", async () => {
		const ownerId = await createAccount();
		const collaboratorId = await createAccount();
		const columnId = await createColumn(ownerId);
		await shareColumn(ownerId, columnId, collaboratorId);

		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const removeShare = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({ sharedWith: [] }),
			}),
		);
		expect(removeShare.ok).toBe(true);

		const accountResponse = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(collaboratorId)}`,
		);
		expect(accountResponse.ok).toBe(true);
		const accountPayload = (await accountResponse.json()) as {
			sharedColumns: Array<{ id: string }>;
		};
		expect(accountPayload.sharedColumns).toEqual([]);
		expect(
			JSON.parse(
				(await env.ACCOUNTS.get(
					`shared:${normalizeAccountId(collaboratorId)}`,
				)) ?? "[]",
			) as string[],
		).not.toContain(columnId);
	});

	it("rejects duplicate idempotency key reused with different payload", async () => {
		const accountId = await createAccount();
		const normalizedAccountId = normalizeAccountId(accountId);
		const firstColumnId = await createColumn(accountId);
		const secondColumnId = await createColumn(accountId);
		const idempotencyKey = crypto.randomUUID();

		const firstWrite = await SELF.fetch(
			`http://example.com/api/account/${normalizedAccountId}/hidden`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({ hiddenSharedColumns: [firstColumnId] }),
			},
		);
		expect(firstWrite.ok).toBe(true);

		const secondWrite = await SELF.fetch(
			`http://example.com/api/account/${normalizedAccountId}/hidden`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"X-Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({ hiddenSharedColumns: [secondColumnId] }),
			},
		);
		expect(secondWrite.status).toBe(409);
		expect(await secondWrite.json()).toMatchObject({
			error: "idempotency_key_conflict",
		});

		const accountRes = await SELF.fetch(
			`http://example.com/api/account/${normalizedAccountId}`,
		);
		expect(accountRes.ok).toBe(true);
		const accountPayload = (await accountRes.json()) as {
			account: { hiddenSharedColumns: string[] };
		};
		expect(accountPayload.account.hiddenSharedColumns).toEqual([firstColumnId]);
	});

	it("returns in-progress when matching idempotent write is pending", async () => {
		const accountId = await createAccount();
		const normalizedAccountId = normalizeAccountId(accountId);
		const columnId = await createColumn(accountId);
		const idempotencyKey = crypto.randomUUID();

		const path = `/api/column/${columnId}/public`;
		const scope = `account:${normalizedAccountId}:column:${columnId}:public:enable`;
		const cacheKey = `idempotency:${scope}:${normalizedAccountId}:${idempotencyKey}`;
		const fingerprint = await sha256Hex(`POST ${path}\n`);

		await env.ACCOUNTS.put(
			cacheKey,
			JSON.stringify({
				schemaVersion: 1,
				state: "pending",
				fingerprint,
			}),
			{ expirationTtl: 60 },
		);

		const response = await SELF.fetch(`http://example.com${path}`, {
			method: "POST",
			headers: {
				"X-Account-ID": accountId,
				"X-Idempotency-Key": idempotencyKey,
			},
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "idempotency_request_in_progress",
		});
	});

	it("returns backup service misconfiguration error when admin backups unavailable", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);

		const res = await SELF.fetch(
			`http://example.com/api/admin/backups/column/${columnId}`,
			{
				headers: { Authorization: "Bearer test-token" },
			},
		);

		expect(res.status).toBe(503);
		const data = (await res.json()) as { error?: string };
		expect(["backup_not_configured", "backup_auth_not_configured"]).toContain(
			data.error,
		);
	});
});

describe("WebSocket upgrade routing", () => {
	it("upgrades /api/column/:id/ws and reaches the DO", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);

		const res = await SELF.fetch(
			`http://example.com/api/column/${columnId}/ws?accountId=${encodeURIComponent(
				normalizeAccountId(accountId),
			)}`,
			{
				headers: { Upgrade: "websocket" },
			},
		);
		expect(res.status).toBe(101);

		const ws = getResponseWebSocket(res);
		(ws as unknown as { accept: () => void }).accept();

		// Read a few initial frames. We only assert we see a sync frame at least once,
		// since ordering can vary with presence/awareness updates.
		const ops: number[] = [];
		for (let i = 0; i < 4; i++) {
			const event = await waitForWsMessage(ws, 2000);
			ops.push(decodeOpcode(event.data));
		}
		expect(ops).toContain(WS_OP_SYNC);
		expect(ops).toContain(WS_OP_PRESENCE);

		ws.close();
	});

	it("upgrades /api/p/:publicId/ws and reaches the DO", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);

		const publicRes = await SELF.fetch(
			`http://example.com/api/column/${columnId}/public`,
			{
				method: "POST",
				headers: { "X-Account-ID": accountId },
			},
		);
		expect(publicRes.ok).toBe(true);
		const publicData = (await publicRes.json()) as { publicId: string };
		expect(typeof publicData.publicId).toBe("string");

		const res = await SELF.fetch(
			`http://example.com/api/p/${publicData.publicId}/ws`,
			{
				headers: { Upgrade: "websocket" },
			},
		);
		expect(res.status).toBe(101);

		const ws = getResponseWebSocket(res);
		(ws as unknown as { accept: () => void }).accept();

		const ops: number[] = [];
		for (let i = 0; i < 4; i++) {
			const event = await waitForWsMessage(ws, 2000);
			ops.push(decodeOpcode(event.data));
		}
		expect(ops).toContain(WS_OP_SYNC);
		expect(ops).toContain(WS_OP_PRESENCE);

		ws.close();
	});
});

describe("Agent read API", () => {
	for (const persistedAccountCase of [
		{
			name: "invalid JSON",
			record: "{",
			code: "invalid_json",
		},
		{
			name: "an invalid shape",
			record: JSON.stringify({ schemaVersion: 1 }),
			code: "invalid_shape",
		},
		{
			name: "an unsupported schema version",
			record: JSON.stringify({
				schemaVersion: 999,
				id: "0000 0000 0000 0000",
				columnOrder: [],
				hiddenSharedColumns: [],
				createdAt: 0,
			}),
			code: "unsupported_schema_version",
		},
	] as const) {
		it(`rejects ${persistedAccountCase.name} through both account APIs`, async () => {
			const accountId = await createAccount();
			const normalizedId = normalizeAccountId(accountId);
			await env.ACCOUNTS.put(
				`account:${normalizedId}`,
				persistedAccountCase.record,
			);

			const browserResponse = await SELF.fetch(
				`http://example.com/api/account/${normalizedId}`,
			);
			expect(browserResponse.status).toBe(503);
			expect(await browserResponse.json()).toMatchObject({
				error: "schema_guard_blocked",
				kind: "account",
				code: persistedAccountCase.code,
			});

			const agentResponse = await SELF.fetch(
				`http://example.com/api/agent/v1/accounts/${normalizedId}/columns`,
				{ headers: { "X-Account-ID": accountId } },
			);
			expect(agentResponse.status).toBe(503);
			expect(await agentResponse.json()).toEqual({
				error: "Account record is invalid",
			});
		});
	}

	it("rejects unsupported column metadata at Durable Object import", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		const stub = env.COLUMN_ROOM.get(env.COLUMN_ROOM.idFromName(columnId));
		const metaResponse = await stub.fetch(new Request("http://do/meta"));
		expect(metaResponse.ok).toBe(true);
		const meta = (await metaResponse.json()) as Record<string, unknown>;
		const importResponse = await stub.fetch(
			new Request("http://do/import", {
				method: "POST",
				body: JSON.stringify({
					meta: { ...meta, schemaVersion: 999 },
					yjs: null,
				}),
			}),
		);
		expect(importResponse.status).toBe(400);

		const browserResponse = await SELF.fetch(
			`http://example.com/api/column/${columnId}`,
			{ headers: { "X-Account-ID": accountId } },
		);
		expect(browserResponse.status).toBe(200);

		const agentResponse = await SELF.fetch(
			`http://example.com/api/agent/v1/columns/${columnId}`,
			{ headers: { "X-Account-ID": accountId } },
		);
		expect(agentResponse.status).toBe(200);
	});

	it("serves a public OpenAPI spec for agent endpoints", async () => {
		const res = await SELF.fetch("http://example.com/openapi.json");
		expect(res.ok).toBe(true);
		const spec = (await res.json()) as {
			openapi: string;
			paths: Record<string, unknown>;
		};

		expect(spec.openapi).toBe("3.0.0");
		expect(spec.paths["/api/agent/v1/accounts/{accountId}/columns"]).toBeDefined();
		expect(spec.paths["/api/agent/v1/columns/{columnId}"]).toBeDefined();
		expect(spec.paths["/api/agent/v1/columns/{columnId}/snapshot"]).toBeDefined();
	});

	it("denies account list if header account differs from path account", async () => {
		const accountIdA = await createAccount();
		const accountIdB = await createAccount();

		const res = await SELF.fetch(
			`http://example.com/api/agent/v1/accounts/${normalizeAccountId(accountIdA)}/columns`,
			{
				headers: { "X-Account-ID": accountIdB },
			},
		);

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "Access denied" });
	});

	it("lists owned, shared (including hidden), and deleted columns", async () => {
		const ownerId = await createAccount();
		const sharedUserId = await createAccount();
		const sharedColumnId = await createColumn(ownerId);
		const deletedColumnId = await createColumn(ownerId);

		await shareColumn(ownerId, sharedColumnId, sharedUserId);

		const hideRes = await SELF.fetch(
			`http://example.com/api/account/${normalizeAccountId(sharedUserId)}/hidden`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ hiddenSharedColumns: [sharedColumnId] }),
			},
		);
		expect(hideRes.ok).toBe(true);

		const deleteRes = await SELF.fetch(`http://example.com/api/column/${deletedColumnId}`, {
			method: "DELETE",
			headers: { "X-Account-ID": ownerId },
		});
		expect(deleteRes.ok).toBe(true);

		const ownerListRes = await SELF.fetch(
			`http://example.com/api/agent/v1/accounts/${normalizeAccountId(ownerId)}/columns`,
			{
				headers: { "X-Account-ID": ownerId },
			},
		);
		expect(ownerListRes.ok).toBe(true);
		const ownerList = (await ownerListRes.json()) as {
			columns: Array<{ id: string; state: string; source: string }>;
		};
		expect(
			ownerList.columns.some(
				(c) => c.id === deletedColumnId && c.source === "owned" && c.state === "deleted",
			),
		).toBe(true);

		const sharedListRes = await SELF.fetch(
			`http://example.com/api/agent/v1/accounts/${normalizeAccountId(sharedUserId)}/columns`,
			{
				headers: { "X-Account-ID": sharedUserId },
			},
		);
		expect(sharedListRes.ok).toBe(true);
		const sharedList = (await sharedListRes.json()) as {
			columns: Array<{ id: string; source: string; visibility: string }>;
		};
		expect(
			sharedList.columns.some(
				(c) =>
					c.id === sharedColumnId &&
					c.source === "shared" &&
					c.visibility === "hidden",
			),
		).toBe(true);
	});

	it("returns canonical snapshot with nullable markdown", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);

		const res = await SELF.fetch(
			`http://example.com/api/agent/v1/columns/${columnId}/snapshot`,
			{
				headers: { "X-Account-ID": accountId },
			},
		);

		expect(res.ok).toBe(true);
		const data = (await res.json()) as {
			columnId: string;
			state: "active" | "deleted";
			yjs: number[] | null;
			markdown: string | null;
		};

		expect(data.columnId).toBe(columnId);
		expect(data.state).toBe("active");
		expect(data).toHaveProperty("yjs");
		expect(data).toHaveProperty("markdown");
		expect(Array.isArray(data.yjs) || data.yjs === null).toBe(true);
		expect(typeof data.markdown === "string" || data.markdown === null).toBe(true);
	});

	it("allows owner to snapshot a deleted column", async () => {
		const accountId = await createAccount();
		const columnId = await createColumn(accountId);
		await deleteColumn(accountId, columnId);

		const res = await SELF.fetch(
			`http://example.com/api/agent/v1/columns/${columnId}/snapshot`,
			{
				headers: { "X-Account-ID": accountId },
			},
		);

		expect(res.ok).toBe(true);
		const data = (await res.json()) as { state: string; deletedAt: number | null };
		expect(data.state).toBe("deleted");
		expect(typeof data.deletedAt).toBe("number");
	});
});
