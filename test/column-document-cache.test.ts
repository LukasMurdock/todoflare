import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Doc as YDoc, applyUpdate, encodeStateAsUpdate, encodeStateVector as YencodeStateVector } from "yjs";
import { createIndexedDbBackedDb } from '../src/lib/local-first/database';
import type { LocalFirstDatabase } from '../src/lib/local-first/database';
import { cacheColumnUpdate, readColumnDocument } from "../src/lib/collaboration/column-document-cache";

const accountId = "1111111111111111";
const databases: Array<LocalFirstDatabase> = [];
async function open() {
	const db = await createIndexedDbBackedDb();
	databases.push(db);
	return db;
}
function text(update: Uint8Array) {
	const doc = new YDoc();
	applyUpdate(doc, update);
	const result = doc.getText("content").toString();
	doc.destroy();
	return result;
}

// Workers have no IndexedDB. Each test gets a fresh browser-compatible storage engine.
beforeEach(() => {
	Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
});
afterEach(async () => {
	for (const db of databases.splice(0)) {await db.close();}
	Reflect.deleteProperty(globalThis, "indexedDB");
});

describe("local column documents", () => {
	it("restores the confirmed base with unacknowledged edits after reload, scoped to the account", async () => {
		const db = await open();
		const doc = new YDoc();
		doc.getText("content").insert(0, "Confirmed");
		cacheColumnUpdate(db, accountId, "column", encodeStateAsUpdate(doc));
		const vector = YencodeStateVector(doc);
		doc.getText("content").insert(9, " and queued");
		const pending = encodeStateAsUpdate(doc, vector);
		await db.flush();
		const reloaded = await open();
		expect(text(readColumnDocument(reloaded, accountId, "column", [pending])!)).toBe("Confirmed and queued");
		expect(readColumnDocument(reloaded, "2222222222222222", "column", [])).toBeNull();
		doc.destroy();
	});

	it("merges document snapshots written by stale tabs instead of losing either edit", async () => {
		const a = await open(), b = await open();
		const first = new YDoc(), second = new YDoc();
		first.getText("content").insert(0, "A");
		second.getText("content").insert(0, "B");
		cacheColumnUpdate(a, accountId, "column", encodeStateAsUpdate(first));
		cacheColumnUpdate(b, accountId, "column", encodeStateAsUpdate(second));
		await Promise.all([a.flush(), b.flush()]);
		const reloaded = await open();
		expect(text(readColumnDocument(reloaded, accountId, "column", [])!).split("").sort()).toEqual(["A", "B"]);
		first.destroy(); second.destroy();
	});
});
