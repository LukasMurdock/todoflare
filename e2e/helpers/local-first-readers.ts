import type { Page } from "@playwright/test";

export interface SyncStateSnapshot {
	mode: string;
	queueDepth: number;
	yjsQueueDepth: number;
	lastServerHydrationAt: number | null;
	lastReplayAt: number | null;
	lastReplayLatencyMs: number | null;
	revokeDiscardCount: number;
	convergenceFailureCount: number;
	recentSyncFailureCount: number;
}

export async function getYjsOutboxCountForColumn(
	page: Page,
	accountId: string,
	columnId: string,
): Promise<number> {
	return page.evaluate(
		async ({ accountIdInput, columnIdInput }) => {
			const normalize = (value: string) => value.replace(/\D/g, "");
			const expectedAccountId = normalize(accountIdInput);

			const countMatchingEntries = (rows: unknown): number => {
				if (!Array.isArray(rows)) return 0;

				return rows.reduce((total, row) => {
					if (!Array.isArray(row) || row.length < 2) return total;
					const entry = row[1] as
						| { accountId?: unknown; columnId?: unknown }
						| undefined;
					if (!entry) return total;
					if (typeof entry.accountId !== "string") return total;
					if (typeof entry.columnId !== "string") return total;
					if (normalize(entry.accountId) !== expectedAccountId) return total;
					if (entry.columnId !== columnIdInput) return total;
					return total + 1;
				}, 0);
			};

			let localStorageCount = 0;
			try {
				const localRaw = window.localStorage.getItem(
					"todoflare-yjs-update-outbox-v1",
				);
				if (localRaw) {
					const parsed = JSON.parse(localRaw);
					if (Array.isArray(parsed)) {
						localStorageCount = parsed.filter((entry) => {
							if (!entry || typeof entry !== "object") return false;
							const candidate = entry as {
								accountId?: unknown;
								columnId?: unknown;
							};
							return (
								typeof candidate.accountId === "string" &&
								typeof candidate.columnId === "string" &&
								normalize(candidate.accountId) === expectedAccountId &&
								candidate.columnId === columnIdInput
							);
						}).length;
					}
				}
			} catch {
				localStorageCount = 0;
			}

			if (typeof indexedDB === "undefined") {
				return localStorageCount;
			}

			const indexedDbCount = await new Promise<number | null>((resolve) => {
				const request = indexedDB.open("todoflare-local-first", 1);

				request.onerror = () => {
					resolve(null);
				};

				request.onsuccess = () => {
					const db = request.result;
					const finish = (count: number | null) => {
						try {
							db.close();
						} catch {
							// ignore
						}
						resolve(count);
					};

					try {
						const tx = db.transaction("collections", "readonly");
						const store = tx.objectStore("collections");
						const getReq = store.get("yjsUpdateOutbox");

						getReq.onerror = () => {
							finish(null);
						};

						getReq.onsuccess = () => {
							const raw = getReq.result as { entries?: unknown } | undefined;
							if (!raw || !Array.isArray(raw.entries)) {
								finish(null);
								return;
							}

							finish(countMatchingEntries(raw.entries));
						};
					} catch {
						finish(null);
					}
				};
			});

			if (typeof indexedDbCount === "number") {
				return indexedDbCount;
			}

			return localStorageCount;
		},
		{ accountIdInput: accountId, columnIdInput: columnId },
	);
}

export async function getAccountSnapshotOwnedColumnCount(
	page: Page,
	accountId: string,
): Promise<number> {
	return page.evaluate(async ({ accountIdInput }) => {
		if (typeof indexedDB === "undefined") {
			return 0;
		}

		const normalize = (value: string) => value.replace(/\D/g, "");
		const docId = `account:${normalize(accountIdInput)}`;

		return new Promise<number>((resolve) => {
			const request = indexedDB.open("todoflare-local-first", 1);

			request.onerror = () => {
				resolve(0);
			};

			request.onsuccess = () => {
				const db = request.result;
				const finish = (count: number) => {
					try {
						db.close();
					} catch {
						// ignore
					}
					resolve(count);
				};

				try {
					const tx = db.transaction("collections", "readonly");
					const store = tx.objectStore("collections");
					const getReq = store.get("accountSnapshot");

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

							const snapshot = row[1] as
								| { account?: { columnOrder?: unknown } }
								| undefined;
							if (!snapshot?.account) {
								finish(0);
								return;
							}

							const order = snapshot.account.columnOrder;
							if (!Array.isArray(order)) {
								finish(0);
								return;
							}

							finish(order.length);
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

export async function getSyncStateSnapshot(
	page: Page,
	accountId: string,
): Promise<SyncStateSnapshot | null> {
	return page.evaluate(async ({ accountIdInput }) => {
		if (typeof indexedDB === "undefined") {
			return null;
		}

		const normalize = (value: string) => value.replace(/\D/g, "");
		const docId = `sync:${normalize(accountIdInput)}`;

		return new Promise<SyncStateSnapshot | null>((resolve) => {
			const request = indexedDB.open("todoflare-local-first", 1);

			request.onerror = () => {
				resolve(null);
			};

			request.onsuccess = () => {
				const db = request.result;
				const finish = (snapshot: SyncStateSnapshot | null) => {
					try {
						db.close();
					} catch {
						// ignore
					}
					resolve(snapshot);
				};

				try {
					const tx = db.transaction("collections", "readonly");
					const store = tx.objectStore("collections");
					const getReq = store.get("syncState");

					getReq.onerror = () => {
						finish(null);
					};

					getReq.onsuccess = () => {
						const raw = getReq.result as { entries?: unknown } | undefined;
						if (!raw || !Array.isArray(raw.entries)) {
							finish(null);
							return;
						}

						for (const row of raw.entries) {
							if (!Array.isArray(row) || row.length < 2) continue;
							if (String(row[0]) !== docId) continue;

							const snapshot = row[1] as
								| {
										mode?: unknown;
										queueDepth?: unknown;
										yjsQueueDepth?: unknown;
										lastServerHydrationAt?: unknown;
										lastReplayAt?: unknown;
										lastReplayLatencyMs?: unknown;
										revokeDiscardCount?: unknown;
										convergenceFailureCount?: unknown;
										recentSyncFailures?: unknown;
								  }
								| undefined;

							if (!snapshot || typeof snapshot.mode !== "string") {
								finish(null);
								return;
							}

							finish({
								mode: snapshot.mode,
								queueDepth:
									typeof snapshot.queueDepth === "number"
										? snapshot.queueDepth
										: 0,
								yjsQueueDepth:
									typeof snapshot.yjsQueueDepth === "number"
										? snapshot.yjsQueueDepth
										: 0,
								lastServerHydrationAt:
									typeof snapshot.lastServerHydrationAt === "number"
										? snapshot.lastServerHydrationAt
										: null,
								lastReplayAt:
									typeof snapshot.lastReplayAt === "number"
										? snapshot.lastReplayAt
										: null,
								lastReplayLatencyMs:
									typeof snapshot.lastReplayLatencyMs === "number"
										? snapshot.lastReplayLatencyMs
										: null,
								revokeDiscardCount:
									typeof snapshot.revokeDiscardCount === "number"
										? snapshot.revokeDiscardCount
										: 0,
								convergenceFailureCount:
									typeof snapshot.convergenceFailureCount === "number"
										? snapshot.convergenceFailureCount
										: 0,
								recentSyncFailureCount: Array.isArray(snapshot.recentSyncFailures)
									? snapshot.recentSyncFailures.length
									: 0,
							});
							return;
						}

						finish(null);
					};
				} catch {
					finish(null);
				}
			};
		});
	}, { accountIdInput: accountId });
}
