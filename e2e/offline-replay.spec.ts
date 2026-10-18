import { expect, test } from "@playwright/test";
import { createAccount, createColumn } from "./helpers/account-api";
import {
	bootstrapAuthenticatedPage,
	ensureColumnExists,
} from "./helpers/ui-session";
import {
	getAccountSnapshotOwnedColumnCount,
	getSyncStateSnapshot,
} from "./helpers/local-first-readers";

test.describe("collaborative editing", () => {
	test("replays offline edits after hard refresh and reconnect", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);

		const firstContext = await browser.newContext();
		let firstPage = await firstContext.newPage();
		await bootstrapAuthenticatedPage(firstPage, accountId);
		await ensureColumnExists(firstPage);

		const secondContext = await browser.newContext();
		const secondPage = await secondContext.newPage();
		await bootstrapAuthenticatedPage(secondPage, accountId);
		await ensureColumnExists(secondPage);

		const offlineText = `Offline refresh ${Date.now()}`;
		const firstEditor = firstPage.getByRole("textbox", { name: "Todo editor" }).first();
		const secondEditor = secondPage.getByRole("textbox", { name: "Todo editor" }).first();

		await firstContext.setOffline(true);
		await firstPage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await firstEditor.click();
		await firstPage.keyboard.type(offlineText);

		await expect
			.poll(async () => (await secondEditor.innerText()).trim(), {
				timeout: 2000,
			})
			.not.toContain(offlineText);

		await firstPage.close();

		await firstContext.setOffline(false);
		firstPage = await firstContext.newPage();
		await bootstrapAuthenticatedPage(firstPage, accountId);

		await ensureColumnExists(firstPage);

		await expect
			.poll(async () => (await secondEditor.innerText()).trim(), {
				timeout: 20000,
			})
			.toContain(offlineText);

		await firstContext.close();
		await secondContext.close();
	});

	test("replays offline edits after browser context restart", async ({
		browser,
		request,
		baseURL,
	}, testInfo) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);

		const writerContext = await browser.newContext();
		const writerPage = await writerContext.newPage();
		await bootstrapAuthenticatedPage(writerPage, accountId);
		await ensureColumnExists(writerPage);

		const observerContext = await browser.newContext();
		const observerPage = await observerContext.newPage();
		await bootstrapAuthenticatedPage(observerPage, accountId);
		await ensureColumnExists(observerPage);

		const offlineText = `Offline restart ${Date.now()}`;
		const writerEditor = writerPage.getByRole("textbox", { name: "Todo editor" }).first();
		const observerEditor = observerPage.getByRole("textbox", { name: "Todo editor" }).first();

		await writerContext.setOffline(true);
		await writerPage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await writerEditor.click();
		await writerPage.keyboard.type(offlineText);

		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 2000,
			})
			.not.toContain(offlineText);

		const writerStatePath = testInfo.outputPath("writer-context-state.json");
		await writerContext.storageState({
			path: writerStatePath,
			indexedDB: true,
		});
		await writerContext.close();

		const restartedContext = await browser.newContext({
			storageState: writerStatePath,
		});
		const restartedPage = await restartedContext.newPage();
		await restartedPage.goto("/");
		await expect(restartedPage.getByRole("button", { name: "Add column" })).toBeVisible();
		await ensureColumnExists(restartedPage);

		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 20000,
			})
			.toContain(offlineText);

		await restartedContext.close();
		await observerContext.close();
	});

	test("recovers from network flap during active editing", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);

		const writerContext = await browser.newContext();
		const writerPage = await writerContext.newPage();
		await bootstrapAuthenticatedPage(writerPage, accountId);

		const observerContext = await browser.newContext();
		const observerPage = await observerContext.newPage();
		await bootstrapAuthenticatedPage(observerPage, accountId);

		await expect(writerPage.getByRole("button", { name: "Collapse column" })).toHaveCount(1, {
			timeout: 15000,
		});
		await expect(
			observerPage.getByRole("button", { name: "Collapse column" }),
		).toHaveCount(1, {
			timeout: 15000,
		});

		const writerEditor = writerPage.getByRole("textbox", { name: "Todo editor" }).first();
		const observerEditor = observerPage
			.getByRole("textbox", { name: "Todo editor" })
			.first();

		const baselineText = `Network flap baseline ${Date.now()}`;
		await writerEditor.click();
		await writerPage.keyboard.type(baselineText);
		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 15000,
			})
			.toContain(baselineText);

		await writerContext.setOffline(true);
		await writerPage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		const offlineText = `Network flap offline ${Date.now()}`;
		await writerEditor.click();
		await writerPage.keyboard.type(offlineText);

		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 3000,
			})
			.not.toContain(offlineText);

		await writerContext.setOffline(false);
		await writerPage.evaluate(() => {
			window.dispatchEvent(new Event("online"));
		});

		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 20000,
			})
			.toContain(offlineText);

		const postReconnectText = `Network flap post reconnect ${Date.now()}`;
		await writerEditor.click();
		await writerPage.keyboard.type(postReconnectText);
		await expect
			.poll(async () => (await observerEditor.innerText()).trim(), {
				timeout: 15000,
			})
			.toContain(postReconnectText);

		await writerContext.close();
		await observerContext.close();
	});

	test("hydrates account columns from local snapshot while offline", async ({
		browser,
		request,
		baseURL,
	}, testInfo) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);
		await createColumn(request, appUrl, accountId);

		const warmContext = await browser.newContext();
		const warmPage = await warmContext.newPage();
		await bootstrapAuthenticatedPage(warmPage, accountId);
		await expect(warmPage.getByRole("button", { name: "Collapse column" })).toHaveCount(2, {
			timeout: 15000,
		});
		await expect
			.poll(() => getAccountSnapshotOwnedColumnCount(warmPage, accountId), {
				timeout: 15000,
			})
			.toBe(2);

		const statePath = testInfo.outputPath("offline-snapshot-state.json");
		await warmContext.storageState({ path: statePath, indexedDB: true });
		await warmContext.close();

		const offlineContext = await browser.newContext({ storageState: statePath });
		await offlineContext.route("**/api/**", async (route) => {
			await route.abort();
		});
		const offlinePage = await offlineContext.newPage();
		await offlinePage.goto("/");
		await offlinePage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await expect(offlinePage.getByRole("button", { name: "Add column" })).toBeVisible();
		await expect(
			offlinePage.getByRole("button", { name: "Collapse column" }),
		).toHaveCount(2, {
			timeout: 15000,
		});

		await offlineContext.close();
	});

	test("persists sync state across offline startup", async ({
		browser,
		request,
		baseURL,
	}, testInfo) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);

		const warmContext = await browser.newContext();
		const warmPage = await warmContext.newPage();
		await bootstrapAuthenticatedPage(warmPage, accountId);
		await ensureColumnExists(warmPage);

		await expect
			.poll(async () => {
				const onlineSyncState = await getSyncStateSnapshot(warmPage, accountId);
				return (
					onlineSyncState !== null &&
					typeof onlineSyncState.lastServerHydrationAt === "number" &&
					typeof onlineSyncState.lastReplayAt === "number" &&
					typeof onlineSyncState.lastReplayLatencyMs === "number"
				);
			}, {
				timeout: 15000,
			})
			.toBe(true);

		// Creating the column triggers one more server hydration. Wait until the
		// state settles so the stored snapshot is the one compared below.
		let previousHydrationAt: number | undefined;
		await expect
			.poll(async () => {
				const state = await getSyncStateSnapshot(warmPage, accountId);
				const settled = state?.lastServerHydrationAt === previousHydrationAt;
				previousHydrationAt = state?.lastServerHydrationAt ?? undefined;
				return settled;
			}, { intervals: [750], timeout: 15000 })
			.toBe(true);

		const onlineSyncState = await getSyncStateSnapshot(warmPage, accountId);

		if (!onlineSyncState) {
			throw new Error("Expected sync state snapshot to be present");
		}

		const statePath = testInfo.outputPath("offline-sync-state.json");
		await warmContext.storageState({ path: statePath, indexedDB: true });
		await warmContext.close();

		const offlineContext = await browser.newContext({ storageState: statePath });
		await offlineContext.route("**/api/**", async (route) => {
			await route.abort();
		});
		const offlinePage = await offlineContext.newPage();
		await offlinePage.goto("/");
		await offlinePage.evaluate(() => {
			window.dispatchEvent(new Event("offline"));
		});

		await expect(offlinePage.getByRole("button", { name: "Add column" })).toBeVisible();

		const offlineSyncState = await getSyncStateSnapshot(offlinePage, accountId);
		expect(offlineSyncState).not.toBeNull();
		expect(offlineSyncState?.lastServerHydrationAt).toBe(
			onlineSyncState.lastServerHydrationAt,
		);
		expect(offlineSyncState?.lastReplayAt).toBe(onlineSyncState.lastReplayAt);
		expect(offlineSyncState?.lastReplayLatencyMs).toBe(
			onlineSyncState.lastReplayLatencyMs,
		);
		expect(offlineSyncState?.revokeDiscardCount).toBe(
			onlineSyncState.revokeDiscardCount,
		);
		expect(offlineSyncState?.convergenceFailureCount).toBe(
			onlineSyncState.convergenceFailureCount,
		);

		await offlineContext.close();
	});
});
