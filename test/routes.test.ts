import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function normalizeAccountId(id: string): string {
	return id.replace(/\D/g, "");
}

async function createAccount(): Promise<string> {
	const res = await SELF.fetch("http://example.com/api/account", {
		method: "POST",
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

function getResponseWebSocket(response: Response): WebSocket {
	const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
	if (!ws) throw new Error("Expected Response.webSocket to be set");
	return ws;
}

function decodeOpcode(data: ArrayBuffer | string): number {
	if (typeof data === "string") {
		throw new Error("Expected binary WebSocket frame");
	}
	const bytes = new Uint8Array(data);
	return bytes[0] ?? 0;
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
		expect(ops).toContain(0x01);
		expect(ops).toContain(0x03);

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
		expect(ops).toContain(0x01);
		expect(ops).toContain(0x03);

		ws.close();
	});
});
