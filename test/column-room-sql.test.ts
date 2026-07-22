import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import type { ColumnMeta } from "../src/types/account";
import {
	decodeWsFrame,
	decodeWsMessage,
	encodeDurableSyncSubmission,
	encodeWsFrame,
	WS_OP_ACCESS_REVOKED,
	WS_OP_AWARENESS,
	WS_OP_ERROR,
	WS_OP_PRESENCE,
	WS_OP_SYNC,
	WS_OP_SYNC_ACK,
	WS_PROTOCOL_V1,
} from "../src/lib/collaboration/websocket-protocol";

function getColumnRoomStub(columnId: string) {
	const id = env.COLUMN_ROOM.idFromName(columnId);
	return env.COLUMN_ROOM.get(id);
}

function getResponseWebSocket(response: Response): WebSocket {
	const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
	if (!ws) {
		throw new Error("Expected Response.webSocket to be set");
	}
	return ws;
}

async function issueWsTicket(
	stub: ReturnType<typeof getColumnRoomStub>,
	accountId: string,
): Promise<string> {
	const response = await stub.fetch("http://do/ws-ticket", {
		method: "POST",
		headers: { "X-Authenticated-Account-ID": accountId },
	});
	expect(response.ok).toBe(true);
	return ((await response.json()) as { ticket: string }).ticket;
}

async function setColumnRoomReadOnly(
	stub: ReturnType<typeof getColumnRoomStub>,
	enabled: boolean,
) {
	await runInDurableObject(stub, async (instance) => {
		const durableObjectEnv = (
			instance as unknown as {
				env: { READ_ONLY_MODE?: string };
			}
		).env;
		durableObjectEnv.READ_ONLY_MODE = enabled ? "true" : "false";
	});
}

function decodeFrame(
	data: ArrayBuffer | string,
): { op: number; payload: Uint8Array } {
	if (typeof data === "string") {
		throw new Error("Expected binary WebSocket frame");
	}
	return decodeWsFrame(data);
}

function decodeOp(data: ArrayBuffer | string): number {
	return decodeFrame(data).op;
}

function acceptWebSocket(ws: WebSocket) {
	(ws as unknown as { accept: () => void }).accept();
}

function waitForWsEvent<T extends keyof WebSocketEventMap>(
	ws: WebSocket,
	type: T,
	timeoutMs: number,
): Promise<WebSocketEventMap[T]> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for WebSocket '${type}' event`));
		}, timeoutMs);

		ws.addEventListener(
			type,
			(event) => {
				clearTimeout(timeout);
				resolve(event);
			},
			{ once: true },
		);
	});
}

async function readNextFrame(
	ws: WebSocket,
	timeoutMs = 1000,
): Promise<{ op: number; payload: Uint8Array }> {
	const event = await waitForWsEvent(ws, "message", timeoutMs);
	return decodeFrame(event.data);
}

async function readNextOp(ws: WebSocket, timeoutMs = 1000): Promise<number> {
	return (await readNextFrame(ws, timeoutMs)).op;
}

async function waitForPayloadWithOp(
	ws: WebSocket,
	expectedOp: number,
	timeoutMs = 2000,
): Promise<Uint8Array> {
	const start = Date.now();
	while (true) {
		const elapsed = Date.now() - start;
		const remaining = timeoutMs - elapsed;
		if (remaining <= 0) {
			throw new Error(`Timed out waiting for opcode ${expectedOp}`);
		}
		const frame = await readNextFrame(ws, remaining);
		if (frame.op === expectedOp) return frame.payload;
	}
}

async function waitForOp(
	ws: WebSocket,
	expectedOp: number,
	timeoutMs = 2000,
): Promise<number> {
	const start = Date.now();
	while (true) {
		const elapsed = Date.now() - start;
		const remaining = timeoutMs - elapsed;
		if (remaining <= 0) {
			throw new Error(`Timed out waiting for opcode ${expectedOp}`);
		}
		const op = await readNextOp(ws, remaining);
		if (op === expectedOp) return op;
	}
}

describe("ColumnRoomSql Durable Object (HTTP)", () => {
	it("distinguishes an uninitialized room from denied access", async () => {
		const columnId = "ws-ticket-error-semantics";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";

		const missing = await stub.fetch("http://do/ws-ticket", {
			method: "POST",
			headers: { "X-Authenticated-Account-ID": ownerId },
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({ code: "not_found" });

		await stub.fetch("http://do/init", {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: 1,
				id: columnId,
				ownerId,
				sharedWith: [],
				publicId: null,
				createdAt: Date.now(),
			} satisfies ColumnMeta),
		});

		const denied = await stub.fetch("http://do/ws-ticket", {
			method: "POST",
			headers: { "X-Authenticated-Account-ID": "2222 2222 2222 2222" },
		});
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: "access_revoked" });
	});

	it("negotiates the supported WebSocket protocol and rejects unknown versions", async () => {
		const columnId = "ws-protocol-negotiation";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";
		await stub.fetch("http://do/init", {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: 1,
				id: columnId,
				ownerId,
				sharedWith: [],
				publicId: null,
				createdAt: Date.now(),
			} satisfies ColumnMeta),
		});

		const unsupported = await stub.fetch("http://do/", {
			headers: {
				Upgrade: "websocket",
				"Sec-WebSocket-Protocol": "todoflare-yjs-v999",
			},
		});
		expect(unsupported.status).toBe(426);

		const ticket = await issueWsTicket(stub, ownerId);
		const accepted = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Protocol": WS_PROTOCOL_V1,
				},
			}),
		);
		expect(accepted.status).toBe(101);
		expect(accepted.headers.get("Sec-WebSocket-Protocol")).toBe(WS_PROTOCOL_V1);
		const ws = getResponseWebSocket(accepted);
		acceptWebSocket(ws);
		ws.close();
	});

	it("returns 404 for /meta before init", async () => {
		const stub = getColumnRoomStub("meta-before-init");
		const res = await stub.fetch(new Request("http://do/meta"));
		expect(res.status).toBe(404);
	});

	it("initializes, updates meta, and deletes", async () => {
		const columnId = "http-init-meta";
		const stub = getColumnRoomStub(columnId);

		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: "1111 1111 1111 1111",
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		const initRes = await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meta),
			}),
		);
		expect(initRes.ok).toBe(true);

		const metaRes = await stub.fetch(new Request("http://do/meta"));
		expect(metaRes.ok).toBe(true);
		expect((await metaRes.json()) as ColumnMeta).toMatchObject({
			id: columnId,
			ownerId: meta.ownerId,
			sharedWith: [],
			publicId: null,
		});

		const shareRes = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sharedWith: ["2222 2222 2222 2222"] }),
			}),
		);
		expect(shareRes.ok).toBe(true);

		const publicRes = await stub.fetch(
			new Request("http://do/public", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ publicId: "pub12345" }),
			}),
		);
		expect(publicRes.ok).toBe(true);

		const metaRes2 = await stub.fetch(new Request("http://do/meta"));
		expect(metaRes2.ok).toBe(true);
		expect((await metaRes2.json()) as ColumnMeta).toMatchObject({
			sharedWith: ["2222 2222 2222 2222"],
			publicId: "pub12345",
		});

		const deleteRes = await stub.fetch(
			new Request("http://do/", { method: "DELETE" }),
		);
		expect(deleteRes.ok).toBe(true);

		const metaResAfterDelete = await stub.fetch(new Request("http://do/meta"));
		expect(metaResAfterDelete.status).toBe(404);
	});

	it("exports imported Yjs text state", async () => {
		const columnId = "http-export-state";
		const stub = getColumnRoomStub(columnId);

		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: "1111 1111 1111 1111",
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		const initRes = await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meta),
			}),
		);
		expect(initRes.ok).toBe(true);

		const doc = new Y.Doc();
		doc.getText("t").insert(0, "export me");
		const update = encodeStateAsUpdate(doc);

		const importRes = await stub.fetch(
			new Request("http://do/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ meta, yjs: Array.from(update) }),
			}),
		);
		expect(importRes.ok).toBe(true);

		const exportRes = await stub.fetch(new Request("http://do/export"));
		expect(exportRes.ok).toBe(true);
		const exported = (await exportRes.json()) as {
			meta: ColumnMeta;
			yjs: number[] | null;
		};

		expect(exported.meta.id).toBe(columnId);
		expect(exported.yjs).not.toBeNull();

		const docOut = new Y.Doc();
		applyUpdate(docOut, new Uint8Array(exported.yjs ?? []));
		expect(docOut.getText("t").toString()).toBe("export me");
	});

	it("rejects corrupt Yjs imports without changing authoritative state", async () => {
		const columnId = "http-reject-corrupt-import";
		const stub = getColumnRoomStub(columnId);
		const originalMeta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: "1111 1111 1111 1111",
			sharedWith: [],
			publicId: null,
			createdAt: 1,
		};
		const originalDoc = new Y.Doc();
		originalDoc.getText("t").insert(0, "keep me");
		const initialImport = await stub.fetch(
			new Request("http://do/import", {
				method: "POST",
				body: JSON.stringify({
					meta: originalMeta,
					yjs: Array.from(encodeStateAsUpdate(originalDoc)),
				}),
			}),
		);
		expect(initialImport.ok).toBe(true);

		const changedMeta = { ...originalMeta, createdAt: 2 };
		const corruptImport = await stub.fetch(
			new Request("http://do/import", {
				method: "POST",
				body: JSON.stringify({ meta: changedMeta, yjs: [1] }),
			}),
		);
		expect(corruptImport.status).toBe(422);
		expect(await corruptImport.json()).toEqual({ error: "invalid_yjs_update" });

		const metaResponse = await stub.fetch(new Request("http://do/meta"));
		expect(await metaResponse.json()).toEqual(originalMeta);
		const exportResponse = await stub.fetch(new Request("http://do/export"));
		const exported = (await exportResponse.json()) as {
			yjs: number[] | null;
		};
		const restoredDoc = new Y.Doc();
		applyUpdate(restoredDoc, Uint8Array.from(exported.yjs ?? []));
		expect(restoredDoc.getText("t").toString()).toBe("keep me");
	});
});

describe("ColumnRoomSql Durable Object (WebSocket)", () => {
	async function drainInitialFrames(ws: WebSocket) {
		const required = new Set([WS_OP_SYNC, WS_OP_AWARENESS, WS_OP_PRESENCE]);
		const seen = new Set<number>();
		const start = Date.now();
		while (seen.size < required.size) {
			const remaining = 2000 - (Date.now() - start);
			if (remaining <= 0) {
				throw new Error("Timed out draining initial WebSocket frames");
			}
			const op = await readNextOp(ws, remaining);
			if (required.has(op)) seen.add(op);
		}
	}

	it("upgrades to a binary WebSocket and sends initial frames", async () => {
		const columnId = "ws-initial-frames";
		const stub = getColumnRoomStub(columnId);

		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: "1111 1111 1111 1111",
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meta),
			}),
		);

		const ticket = await issueWsTicket(stub, meta.ownerId);
		const res = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`,
				{
					headers: { Upgrade: "websocket" },
				},
			),
		);
		expect(res.status).toBe(101);
		const replayedTicket = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		expect(replayedTicket.status).toBe(403);

		const ws = getResponseWebSocket(res);
		acceptWebSocket(ws);

		const ops = [await readNextOp(ws), await readNextOp(ws), await readNextOp(ws)];
		expect(ops).toEqual([WS_OP_SYNC, WS_OP_AWARENESS, WS_OP_PRESENCE]);

		ws.close();
	});

	it("revokes access over WebSocket when /share removes a user", async () => {
		const columnId = "ws-access-revoked";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";
		const sharedId = "2222 2222 2222 2222";

		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId,
			sharedWith: [sharedId],
			publicId: null,
			createdAt: Date.now(),
		};
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meta),
			}),
		);

		const ticket = await issueWsTicket(stub, sharedId);
		const res = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`,
				{
					headers: { Upgrade: "websocket" },
				},
			),
		);
		expect(res.status).toBe(101);

		const ws = getResponseWebSocket(res);
		acceptWebSocket(ws);
		await drainInitialFrames(ws);

		const revokedPromise = waitForPayloadWithOp(ws, WS_OP_ACCESS_REVOKED, 2000);
		const closePromise = waitForWsEvent(ws, "close", 2000);

		const updateShareRes = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sharedWith: [] }),
			}),
		);
		expect(updateShareRes.ok).toBe(true);

		expect((await revokedPromise).byteLength).toBe(0);
		await closePromise;
	});

	it("keeps a normalized collaborator session when another user is added", async () => {
		const columnId = "ws-access-normalized";
		const stub = getColumnRoomStub(columnId);
		const sharedId = "2222 2222 2222 2222";
		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId: "1111 1111 1111 1111",
			sharedWith: [sharedId],
			publicId: null,
			createdAt: Date.now(),
		};
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(meta),
			}),
		);

		const ticket = await issueWsTicket(stub, sharedId);
		const res = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		const ws = getResponseWebSocket(res);
		acceptWebSocket(ws);
		await drainInitialFrames(ws);

		const update = await stub.fetch(
			new Request("http://do/share", {
				method: "PUT",
				body: JSON.stringify({
					sharedWith: [sharedId, "3333 3333 3333 3333"],
				}),
			}),
		);

		expect(update.ok).toBe(true);
		expect(ws.readyState).toBe(WebSocket.OPEN);
		ws.close();
	});

	it("broadcasts Yjs sync updates between clients", async () => {
		const columnId = "ws-yjs-sync";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";

		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId,
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(meta),
			}),
		);

		const connect = async () => {
			const ticket = await issueWsTicket(stub, ownerId);
			const res = await stub.fetch(
				new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`,
					{
						headers: { Upgrade: "websocket" },
					},
				),
			);
			expect(res.status).toBe(101);
			const ws = getResponseWebSocket(res);
			acceptWebSocket(ws);
			await drainInitialFrames(ws);
			return ws;
		};

		const wsA = await connect();
		const wsB = await connect();

		const docA = new Y.Doc();
		docA.getText("t").insert(0, "hello");
		const update = encodeStateAsUpdate(docA);

		const ackPromise = waitForPayloadWithOp(wsA, WS_OP_SYNC_ACK, 2000);
		wsA.send(encodeDurableSyncSubmission("delivery-1", update));

		const received = await waitForPayloadWithOp(wsB, WS_OP_SYNC, 2000);
		const ackPayload = await ackPromise;
		expect(Array.from(received)).toEqual(Array.from(update));
		expect(
			decodeWsMessage(encodeWsFrame(WS_OP_SYNC_ACK, ackPayload)),
		).toEqual({ type: "sync-ack", outboxId: "delivery-1" });

		const docB = new Y.Doc();
		applyUpdate(docB, received);
		expect(docB.getText("t").toString()).toBe("hello");

		await runInDurableObject(stub, async (_instance, state) => {
			const rows = state.storage.sql
				.exec<{ c: number }>("SELECT COUNT(*) AS c FROM yjs_updates")
				.toArray();
			expect(rows[0]?.c ?? 0).toBeGreaterThan(0);
		});

		wsA.close();
		wsB.close();

		// The update schedules a compaction alarm; run it to avoid cross-test leaks.
		await runDurableObjectAlarm(stub);
	});

	it("deduplicates durable submissions before and after compaction", async () => {
		const columnId = "ws-yjs-dedup";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";
		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify({
					schemaVersion: 1,
					id: columnId,
					ownerId,
					sharedWith: [],
					publicId: null,
					createdAt: Date.now(),
				} satisfies ColumnMeta),
			}),
		);

		const connect = async () => {
			const ticket = await issueWsTicket(stub, ownerId);
			const response = await stub.fetch(
				new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			const ws = getResponseWebSocket(response);
			acceptWebSocket(ws);
			await drainInitialFrames(ws);
			return ws;
		};

		const sender = await connect();
		const peer = await connect();
		let peerSyncCount = 0;
		const countPeerSync = (event: MessageEvent) => {
			if (decodeOp(event.data) === WS_OP_SYNC) peerSyncCount += 1;
		};
		peer.addEventListener("message", countPeerSync);

		const doc = new Y.Doc();
		doc.getText("t").insert(0, "deduplicated");
		const update = encodeStateAsUpdate(doc);
		const submission = encodeDurableSyncSubmission("stable-delivery", update);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const ack = waitForPayloadWithOp(sender, WS_OP_SYNC_ACK);
			sender.send(submission);
			expect(
				decodeWsMessage(encodeWsFrame(WS_OP_SYNC_ACK, await ack)),
			).toEqual({ type: "sync-ack", outboxId: "stable-delivery" });
		}
		await new Promise((resolve) => setTimeout(resolve, 25));

		await runInDurableObject(stub, async (_instance, state) => {
			const updateCount = state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM yjs_updates")
				.toArray()[0]?.count;
			const receiptCount = state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM received_outbox")
				.toArray()[0]?.count;
			expect(updateCount).toBe(1);
			expect(receiptCount).toBe(1);
		});
		expect(peerSyncCount).toBe(1);

		await runDurableObjectAlarm(stub);
		const replayAck = waitForPayloadWithOp(sender, WS_OP_SYNC_ACK);
		sender.send(submission);
		await replayAck;
		await new Promise((resolve) => setTimeout(resolve, 25));

		await runInDurableObject(stub, async (_instance, state) => {
			const updateCount = state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM yjs_updates")
				.toArray()[0]?.count;
			const receiptCount = state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM received_outbox")
				.toArray()[0]?.count;
			expect(updateCount).toBe(0);
			expect(receiptCount).toBe(1);
		});
		expect(peerSyncCount).toBe(1);

		peer.removeEventListener("message", countPeerSync);
		sender.close();
		peer.close();
		doc.destroy();
	});

	it("rejects reuse of a delivery ID with different update bytes", async () => {
		const columnId = "ws-yjs-delivery-conflict";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";
		await stub.fetch("http://do/init", {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: 1,
				id: columnId,
				ownerId,
				sharedWith: [],
				publicId: null,
				createdAt: Date.now(),
			} satisfies ColumnMeta),
		});

		const ticket = await issueWsTicket(stub, ownerId);
		const response = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		const ws = getResponseWebSocket(response);
		acceptWebSocket(ws);
		await drainInitialFrames(ws);

		const first = new Y.Doc();
		first.getText("t").insert(0, "first");
		const firstAck = waitForPayloadWithOp(ws, WS_OP_SYNC_ACK);
		ws.send(
			encodeDurableSyncSubmission("reused-delivery", encodeStateAsUpdate(first)),
		);
		await firstAck;

		const second = new Y.Doc();
		second.getText("t").insert(0, "second");
		const error = waitForPayloadWithOp(ws, WS_OP_ERROR);
		const closed = waitForWsEvent(ws, "close", 2000);
		ws.send(
			encodeDurableSyncSubmission("reused-delivery", encodeStateAsUpdate(second)),
		);
		expect(new TextDecoder().decode(await error)).toContain("different content");
		expect((await closed).code).toBe(1008);

		await runInDurableObject(stub, async (_instance, state) => {
			expect(
				state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM yjs_updates")
					.toArray()[0]?.count,
			).toBe(1);
		});
		first.destroy();
		second.destroy();
		await runDurableObjectAlarm(stub);
	});

	it("does not persist an existing socket submission after read-only activation", async () => {
		const columnId = "ws-read-only-existing-socket";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";
		const meta: ColumnMeta = {
			schemaVersion: 1,
			id: columnId,
			ownerId,
			sharedWith: [],
			publicId: null,
			createdAt: Date.now(),
		};

		await stub.fetch(
			new Request("http://do/init", {
				method: "POST",
				body: JSON.stringify(meta),
			}),
		);

		const ticket = await issueWsTicket(stub, ownerId);
		const unusedTicket = await issueWsTicket(stub, ownerId);
		const upgrade = await stub.fetch(
			new Request(`http://do/?ticket=${encodeURIComponent(ticket)}`, {
				headers: { Upgrade: "websocket" },
			}),
		);
		expect(upgrade.status).toBe(101);
		const ws = getResponseWebSocket(upgrade);
		acceptWebSocket(ws);
		await drainInitialFrames(ws);

		const baselineDoc = new Y.Doc();
		baselineDoc.getText("t").insert(0, "baseline");
		const baselineAck = waitForPayloadWithOp(ws, WS_OP_SYNC_ACK);
		ws.send(
			encodeDurableSyncSubmission(
				"read-only-baseline",
				encodeStateAsUpdate(baselineDoc),
			),
		);
		await baselineAck;

		const beforeExport = await stub.fetch(new Request("http://do/export"));
		const before = (await beforeExport.json()) as { yjs: number[] | null };
		const beforeUpdateCount = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM yjs_updates")
					.toArray()[0]?.count ?? 0,
		);

		try {
			await setColumnRoomReadOnly(stub, true);

			const ticketResponse = await stub.fetch("http://do/ws-ticket", {
				method: "POST",
				headers: { "X-Authenticated-Account-ID": ownerId },
			});
			expect(ticketResponse.status).toBe(503);
			expect(await ticketResponse.json()).toMatchObject({
				error: "read_only_mode",
				code: "read_only_mode",
			});

			const staleUpgrade = await stub.fetch(
				new Request(`http://do/?ticket=${encodeURIComponent(unusedTicket)}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			expect(staleUpgrade.status).toBe(503);

			const errorPromise = waitForPayloadWithOp(ws, WS_OP_ERROR);
			const closePromise = waitForWsEvent(ws, "close", 2000);
			const rejectedDoc = new Y.Doc();
			rejectedDoc.getText("t").insert(0, "must-not-persist");
			ws.send(
				encodeDurableSyncSubmission(
					"read-only-rejected",
					encodeStateAsUpdate(rejectedDoc),
				),
			);

			expect(new TextDecoder().decode(await errorPromise)).toContain(
				"Writes are temporarily disabled",
			);
			const close = await closePromise;
			expect(close.code).toBe(1013);

			const afterExport = await stub.fetch(new Request("http://do/export"));
			const after = (await afterExport.json()) as { yjs: number[] | null };
			expect(after.yjs).toEqual(before.yjs);

			const afterUpdateCount = await runInDurableObject(
				stub,
				async (_instance, state) =>
					state.storage.sql
						.exec<{ count: number }>("SELECT COUNT(*) AS count FROM yjs_updates")
						.toArray()[0]?.count ?? 0,
			);
			expect(afterUpdateCount).toBe(beforeUpdateCount);
		} finally {
			await setColumnRoomReadOnly(stub, false);
			if (ws.readyState === WebSocket.OPEN) ws.close();
		}
	});
});
