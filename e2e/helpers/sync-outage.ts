import { expect, type Page, type Route } from "@playwright/test";

async function getSyncQueueDepth(page: Page, accountId: string): Promise<number> {
	return page.evaluate(async ({ accountIdInput }) => {
		if (typeof indexedDB === "undefined") {
			return 0;
		}

		const normalize = (value: string) => value.replace(/\D/g, "");
		const docId = `sync:${normalize(accountIdInput)}`;

		return new Promise<number>((resolve) => {
			const request = indexedDB.open("todoflare-local-first", 1);

			request.onerror = () => {
				resolve(0);
			};

			request.onsuccess = () => {
				const db = request.result;
				const finish = (depth: number) => {
					try {
						db.close();
					} catch {
						// ignore
					}
					resolve(depth);
				};

				try {
					const tx = db.transaction("collections", "readonly");
					const store = tx.objectStore("collections");
					const getReq = store.get("syncState");

					getReq.onerror = () => {
						finish(0);
					};

					getReq.onsuccess = () => {
						const raw = getReq.result as { entries?: unknown } | undefined;
						if (!raw || !Array.isArray(raw.entries)) {
							finish(0);
							return;
						}

						for (const row of raw.entries) {
							if (!Array.isArray(row) || row.length < 2) continue;
							if (String(row[0]) !== docId) continue;

							const snapshot = row[1] as { queueDepth?: unknown } | undefined;
							finish(
								typeof snapshot?.queueDepth === "number" ? snapshot.queueDepth : 0,
							);
							return;
						}

						finish(0);
					};
				} catch {
					finish(0);
				}
			};
		});
	}, { accountIdInput: accountId });
}

export async function withTemporaryBackendOutage(
	page: Page,
	urlPattern: string,
	run: () => Promise<void>,
): Promise<void> {
	const outageHandler = async (route: Route) => {
		await route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: "temporary_unavailable" }),
		});
	};

	await page.route(urlPattern, outageHandler);
	try {
		await run();
	} finally {
		await page.unroute(urlPattern, outageHandler);
	}
}

export async function waitForQueuedMutations(
	page: Page,
	accountId: string,
	timeout = 15000,
): Promise<void> {
	await expect
		.poll(() => getSyncQueueDepth(page, accountId), { timeout })
		.toBeGreaterThan(0);
}

export async function waitForQueueToDrain(
	page: Page,
	accountId: string,
	timeout = 45000,
): Promise<void> {
	await expect
		.poll(() => getSyncQueueDepth(page, accountId), { timeout })
		.toBe(0);
}
