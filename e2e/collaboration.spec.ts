import { expect, test } from "@playwright/test";
import { createAccount, createColumn } from "./helpers/account-api";
import {
	ACCOUNT_STORAGE_KEY,
	addColumnAndGetId,
	bootstrapAuthenticatedPage,
	ensureColumnExists,
	LOCAL_COLUMNS_KEY,
	WELCOME_KEY,
} from "./helpers/ui-session";

test.describe("collaborative editing", () => {
	test("onboarding first-visit UI renders correctly with screenshots", async ({
		page,
		request,
		baseURL,
	}, testInfo) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);

		await page.addInitScript(
			({ accountStorageKey, localColumnsKey, welcomeKey, id }) => {
				window.localStorage.setItem(accountStorageKey, id);
				window.localStorage.removeItem(welcomeKey);
				window.localStorage.removeItem(localColumnsKey);
			},
			{
				accountStorageKey: ACCOUNT_STORAGE_KEY,
				localColumnsKey: LOCAL_COLUMNS_KEY,
				welcomeKey: WELCOME_KEY,
				id: accountId,
			},
		);

		await page.goto("/");
		await expect(page.getByText("Todoflare")).toBeVisible();
		await expect(
			page.getByText("All your data is saved locally in your browser."),
		).toBeVisible();

		const onboardingPath = testInfo.outputPath("onboarding-first-visit.png");
		await page.screenshot({ path: onboardingPath, fullPage: true });
		await testInfo.attach("onboarding-first-visit", {
			path: onboardingPath,
			contentType: "image/png",
		});

		await page.getByRole("button", { name: "Add column" }).click();
		await expect(page.getByText("Todoflare")).toHaveCount(0);

		const dismissedPath = testInfo.outputPath("onboarding-dismissed.png");
		await page.screenshot({ path: dismissedPath, fullPage: true });
		await testInfo.attach("onboarding-dismissed", {
			path: dismissedPath,
			contentType: "image/png",
		});
	});

	test("generate account and claim data keeps local offline data", async ({ page }) => {
		await page.addInitScript(({ accountStorageKey, localColumnsKey, welcomeKey }) => {
			const offlineColumns = [
				{
					id: "local-col-1",
					value: [
						{ type: "p", children: [{ text: "offline claim text" }] },
					],
					collapsed: false,
				},
			];

			window.localStorage.removeItem(accountStorageKey);
			window.localStorage.setItem(welcomeKey, "true");
			window.localStorage.setItem(localColumnsKey, JSON.stringify(offlineColumns));
		}, {
			accountStorageKey: ACCOUNT_STORAGE_KEY,
			localColumnsKey: LOCAL_COLUMNS_KEY,
			welcomeKey: WELCOME_KEY,
		});

		await page.goto("/");
		await expect(
			page.getByRole("heading", { name: "You have existing local data" }),
		).toBeVisible();

		await page.getByRole("button", { name: "Generate Account & Claim Data" }).click();

		await expect(
			page.getByRole("heading", { name: "You have existing local data" }),
		).toHaveCount(0);

		const localData = await page.evaluate((localColumnsKey) => {
			return window.localStorage.getItem(localColumnsKey);
		}, LOCAL_COLUMNS_KEY);

		expect(localData).toContain("offline claim text");
	});

	test("stale stored account id falls back to account modal", async ({ page }) => {
		const staleAccountId = `9999 0000 ${Math.floor(Date.now() % 10000)
			.toString()
			.padStart(4, "0")} 1234`;

		await page.addInitScript(
			({ accountStorageKey, localColumnsKey, welcomeKey, id }) => {
				window.localStorage.setItem(accountStorageKey, id);
				window.localStorage.setItem(welcomeKey, "true");
				window.localStorage.removeItem(localColumnsKey);
			},
			{
				accountStorageKey: ACCOUNT_STORAGE_KEY,
				localColumnsKey: LOCAL_COLUMNS_KEY,
				welcomeKey: WELCOME_KEY,
				id: staleAccountId,
			},
		);

		await page.goto("/");

		await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
		await expect(
			page.getByRole("heading", { name: "Welcome to Todoflare" }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Generate New Account" })).toBeVisible();
	});

	test("syncs edits between two tabs of the same account", async ({
		browser,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);
		await createColumn(request, appUrl, accountId);

		const firstContext = await browser.newContext();
		const firstPage = await firstContext.newPage();
		await bootstrapAuthenticatedPage(firstPage, accountId);
		await ensureColumnExists(firstPage);

		const secondContext = await browser.newContext();
		const secondPage = await secondContext.newPage();
		await bootstrapAuthenticatedPage(secondPage, accountId);
		await ensureColumnExists(secondPage);

		const text = `Cross-tab ${Date.now()}`;
		const firstEditor = firstPage.getByRole("textbox", { name: "Todo editor" }).first();
		await firstEditor.click();
		await firstPage.keyboard.type(text);

		const secondEditor = secondPage.getByRole("textbox", { name: "Todo editor" }).first();
		await expect
			.poll(async () => (await secondEditor.innerText()).trim(), {
				timeout: 15000,
			})
			.toContain(text);

		await firstContext.close();
		await secondContext.close();
	});

	test("collapses and re-expands a column", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, accountId);
		await addColumnAndGetId(page);

		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1);
		await page.getByRole("button", { name: "Collapse column" }).click();
		await expect(page.getByRole("button", { name: "Expand column" })).toHaveCount(1);

		await page.getByRole("button", { name: "Expand column" }).click();
		await expect(page.getByRole("button", { name: "Collapse column" })).toHaveCount(1);
	});
});
