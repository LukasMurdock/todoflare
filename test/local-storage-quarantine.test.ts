import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_STORAGE_QUARANTINE_SUFFIX } from "../src/lib/local-first/local-storage-quarantine";
import { createLocalStorageYjsOutboxStorage } from "../src/lib/sync/yjs-update-outbox";

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	clear() {
		this.values.clear();
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	key(index: number) {
		return Array.from(this.values.keys())[index] ?? null;
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
}

describe("localStorage outbox quarantine", () => {
	const storage = new MemoryStorage();

	beforeEach(() => {
		storage.clear();
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { localStorage: storage },
		});
	});

	afterEach(() => {
		Reflect.deleteProperty(globalThis, "window");
	});

	it("preserves malformed records in a recovery key", () => {
		const key = "test-yjs-outbox";
		storage.setItem(key, JSON.stringify([{ id: "broken", updateBytes: [999] }]));
		const outboxStorage = createLocalStorageYjsOutboxStorage(key);

		expect(outboxStorage.read()).toEqual([]);
		const quarantined = z.array(z.object({ sourceCollection: z.string(), raw: z.unknown() })).parse(JSON.parse(
			storage.getItem(`${key}${LOCAL_STORAGE_QUARANTINE_SUFFIX}`) ?? "[]",
		));
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]).toMatchObject({
			sourceCollection: "yjsUpdateOutbox",
			raw: { id: "broken", updateBytes: [999] },
		});
	});

	it("does not overwrite records written by a newer bundle", () => {
		const key = "test-future-yjs-outbox";
		const future = { schemaVersion: 2, id: "future", futurePayload: true };
		storage.setItem(key, JSON.stringify([future]));
		const outboxStorage = createLocalStorageYjsOutboxStorage(key);

		expect(outboxStorage.read()).toEqual([]);
		expect(() => outboxStorage.write([])).toThrow("unsupported records");
		expect(JSON.parse(storage.getItem(key) ?? "[]")).toEqual([future]);
	});
});
