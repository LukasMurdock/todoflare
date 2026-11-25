import { describe, expect, it, vi } from "vitest";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { createCloudflareDocuments } from '../src/lib/collaboration/cloudflare-yjs-provider';
import type { ColumnSyncTransport } from '../src/lib/collaboration/cloudflare-yjs-provider';
import type { SyncMessage } from "../src/types/account";

const COLUMN_ID = "00000000-0000-4000-8000-000000000001";

function fakeTransport() {
	const listeners = new Set<(message: SyncMessage) => void>();
	const sent: Array<Uint8Array> = [];
	const subscribed: Array<string> = [];
	const released: Array<string> = [];
	const subscribeToColumn = (columnId: string) => {
		subscribed.push(columnId);
		return () => { released.push(columnId); };
	};
	const transport: ColumnSyncTransport = {
		subscribeToColumn,
		onColumnMessage: (_columnId, callback) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		sendUpdate: (_columnId, update) => sent.push(update),
		sendAwareness: () => {},
	};
	return { transport, listeners, sent, subscribed, released };
}

function cachedText(text: string): Uint8Array {
	const doc = new YDoc();
	doc.getText("t").insert(0, text);
	return encodeStateAsUpdate(doc);
}

describe("Cloudflare document adapter", () => {
	it("opens with the cached document, sends local edits, and releases its subscriptions", async () => {
		const fake = fakeTransport();
		const { sent } = fake;
		const documents = createCloudflareDocuments({
			loadColumnDocument: async () => cachedText("cached"),
			transport: fake.transport,
		});

		const opened = await documents.open(COLUMN_ID, new AbortController().signal);
		expect(opened.doc.getText("t").toString()).toBe("cached");
		expect(fake.subscribed).toEqual([COLUMN_ID]);
		expect(sent).toHaveLength(0);

		opened.doc.getText("t").insert(6, " edit");
		expect(sent).toHaveLength(1);

		opened.release();
		expect(fake.released).toEqual([COLUMN_ID]);
		expect(fake.listeners.size).toBe(0);
	});

	it("applies remote sync messages without echoing them back", async () => {
		const fake = fakeTransport();
		const { sent } = fake;
		const documents = createCloudflareDocuments({ loadColumnDocument: async () => null, transport: fake.transport });
		const opened = await documents.open(COLUMN_ID, new AbortController().signal);

		for (const listener of fake.listeners) {listener({ type: "sync", data: cachedText("remote") });}
		expect(opened.doc.getText("t").toString()).toBe("remote");
		expect(sent).toHaveLength(0);
		opened.release();
	});

	it("opens without the cache when reading it fails", async () => {
		const fake = fakeTransport();
		const reported = vi.spyOn(console, "error");
		const documents = createCloudflareDocuments({
			loadColumnDocument: async () => {
				throw new Error("IndexedDB unavailable");
			},
			transport: fake.transport,
		});
		const opened = await documents.open(COLUMN_ID, new AbortController().signal);
		expect(opened.doc.getText("t").toString()).toBe("");
		expect(reported).toHaveBeenCalled();
		reported.mockRestore();
		opened.release();
	});

	it("rejects without subscribing when the column unmounts while the cache loads", async () => {
		const fake = fakeTransport();
		const controller = new AbortController();
		const documents = createCloudflareDocuments({
			loadColumnDocument: async () => {
				controller.abort();
				return null;
			},
			transport: fake.transport,
		});
		await expect(documents.open(COLUMN_ID, controller.signal)).rejects.toThrow();
		expect(fake.subscribed).toEqual([]);
	});
});
