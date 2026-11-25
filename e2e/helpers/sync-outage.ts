import { getSyncStateSnapshot } from "./local-first-readers";
import { expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

const E2E_REPLAY_WAKE_EVENT = "todoflare:e2e:replay-wake";

const outageHandler = async (route: Route) => {
	await route.fulfill({
		status: 503,
		contentType: "application/json",
		body: JSON.stringify({ error: "temporary_unavailable" }),
	});
};

export async function withTemporaryBackendOutage(
	page: Page,
	urlPattern: string,
	run: () => Promise<void>,
): Promise<void> {


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
	timeout = 15_000,
): Promise<void> {
	await expect
		.poll(async () => (await getSyncStateSnapshot(page, accountId))?.queueDepth, { timeout })
		.toBeGreaterThan(0);
}

export async function waitForQueueToDrain(
	page: Page,
	accountId: string,
	options: { timeout?: number; wakeReplay?: boolean } = {},
): Promise<void> {
	const { timeout = 15_000, wakeReplay = true } = options;
	await expect
		.poll(async () => {
			if (wakeReplay) {
				await page.evaluate((eventName) => {
					window.dispatchEvent(new Event(eventName));
				}, E2E_REPLAY_WAKE_EVENT);
			}
			return (await getSyncStateSnapshot(page, accountId))?.queueDepth;
		}, { intervals: [25, 50, 100], timeout })
		.toBe(0);
}
