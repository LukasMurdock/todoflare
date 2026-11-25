import type { Page } from "@playwright/test";
import { z } from "zod";

const rows = z.object({ entries: z.array(z.tuple([z.string(), z.unknown()])) });
const account = z.object({ account: z.object({ columnOrder: z.array(z.string()) }) });
const sync = z.object({
	mode: z.string(),
	queueDepth: z.number(),
	yjsQueueDepth: z.number(),
	lastServerHydrationAt: z.number().nullable().default(null),
	lastReplayAt: z.number().nullable().default(null),
	lastReplayLatencyMs: z.number().nullable().default(null),
	revokeDiscardCount: z.number().default(0),
	convergenceFailureCount: z.number().default(0),
	recentSyncFailures: z.array(z.unknown()).default([]),
});

async function collection(page: Page, key: string) {
	const value = await page.evaluate((name) => new Promise<unknown>((resolve, reject) => {
		const open = indexedDB.open("todoflare-local-first", 1);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			try {
				const read = db.transaction("collections").objectStore("collections").get(name);
				read.onsuccess = () => resolve(read.result);
				read.onerror = () => reject(read.error);
			} finally {
				db.close();
			}
		};
	}), key);
	return value === undefined ? undefined : rows.parse(value).entries;
}

export async function getYjsOutboxCountForColumn(page: Page, accountId: string, columnId: string) {
	const entries = await collection(page, "yjsUpdateOutbox");
	const raw = entries === undefined ? await page.evaluate(() => localStorage.getItem("todoflare-yjs-update-outbox-v1")) : null;
	const values = entries?.map(([, entry]) => entry) ?? z.array(z.unknown()).parse(JSON.parse(raw ?? "[]"));
	const expected = accountId.replaceAll(/\D/g, "");
	return values.filter((value) => {
		const entry = z.object({ accountId: z.string(), columnId: z.string() }).parse(value);
		return entry.accountId.replaceAll(/\D/g, "") === expected && entry.columnId === columnId;
	}).length;
}

export async function getAccountSnapshotOwnedColumnCount(page: Page, accountId: string) {
	const key = "account:" + accountId.replaceAll(/\D/g, "");
	const entry = (await collection(page, "accountSnapshot"))?.find(([id]) => id === key);
	return entry ? account.parse(entry[1]).account.columnOrder.length : 0;
}

export async function getSyncStateSnapshot(page: Page, accountId: string) {
	const key = "sync:" + accountId.replaceAll(/\D/g, "");
	const entry = (await collection(page, "syncState"))?.find(([id]) => id === key);
	if (!entry) {return null;}
	const { recentSyncFailures, ...snapshot } = sync.parse(entry[1]);
	return { ...snapshot, recentSyncFailureCount: recentSyncFailures.length };
}
