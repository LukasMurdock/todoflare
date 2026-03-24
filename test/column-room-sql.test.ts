import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import type { ColumnMeta } from "../src/types/account";

const WS_OP_SYNC = 0x01;
const WS_OP_AWARENESS = 0x02;
const WS_OP_PRESENCE = 0x03;
const WS_OP_ACCESS_REVOKED = 0x05;

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

function decodeFrame(
	data: ArrayBuffer | string,
): { op: number; payload: Uint8Array } {
	if (typeof data === "string") {
		throw new Error("Expected binary WebSocket frame");
	}
	const bytes = new Uint8Array(data);
	return { op: bytes[0] ?? 0, payload: bytes.subarray(1) };
}

function decodeOp(data: ArrayBuffer | string): number {
	return decodeFrame(data).op;
}

function encodeFrame(op: number, payload: Uint8Array = new Uint8Array()): ArrayBuffer {
	const bytes = new Uint8Array(payload.length + 1);
	bytes[0] = op;
	bytes.set(payload, 1);
	return bytes.buffer;
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
	it("returns 404 for /meta before init", async () => {
		const stub = getColumnRoomStub("meta-before-init");
		const res = await stub.fetch(new Request("http://do/meta"));
		expect(res.status).toBe(404);
	});

	it("initializes, updates meta, and deletes", async () => {
		const columnId = "http-init-meta";
		const stub = getColumnRoomStub(columnId);

		const meta: ColumnMeta = {
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
				body: JSON.stringify({ publicId: "pub123" }),
			}),
		);
		expect(publicRes.ok).toBe(true);

		const metaRes2 = await stub.fetch(new Request("http://do/meta"));
		expect(metaRes2.ok).toBe(true);
		expect((await metaRes2.json()) as ColumnMeta).toMatchObject({
			sharedWith: ["2222 2222 2222 2222"],
			publicId: "pub123",
		});

		const deleteRes = await stub.fetch(
			new Request("http://do/", { method: "DELETE" }),
		);
		expect(deleteRes.ok).toBe(true);

		const metaResAfterDelete = await stub.fetch(new Request("http://do/meta"));
		expect(metaResAfterDelete.status).toBe(404);
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

		const res = await stub.fetch(
			new Request(`http://do/?accountId=${encodeURIComponent(meta.ownerId)}`,
				{
					headers: { Upgrade: "websocket" },
				},
			),
		);
		expect(res.status).toBe(101);

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

		const res = await stub.fetch(
			new Request(`http://do/?accountId=${encodeURIComponent(sharedId)}`,
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

	it("broadcasts Yjs sync updates between clients", async () => {
		const columnId = "ws-yjs-sync";
		const stub = getColumnRoomStub(columnId);
		const ownerId = "1111 1111 1111 1111";

		const meta: ColumnMeta = {
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
			const res = await stub.fetch(
				new Request(`http://do/?accountId=${encodeURIComponent(ownerId)}`,
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

		wsA.send(encodeFrame(WS_OP_SYNC, update));

		const received = await waitForPayloadWithOp(wsB, WS_OP_SYNC, 2000);
		expect(Array.from(received)).toEqual(Array.from(update));

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
});
