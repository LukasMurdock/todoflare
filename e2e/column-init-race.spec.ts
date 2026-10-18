import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { ACCOUNT_STORAGE_KEY, bootstrapAuthenticatedPage, WELCOME_KEY } from "./helpers/ui-session";

test.describe("collaborative editing", () => {
	test("newly added synced column keeps first typed characters", async ({
		page,
		request,
		baseURL,
	}) => {
		const appUrl = baseURL ?? "http://127.0.0.1:4173";
		const accountId = await createAccount(request, appUrl);

		await bootstrapAuthenticatedPage(page, accountId);
		await page.getByRole("button", { name: "Add column" }).click();

		const newEditor = page.getByRole("textbox", { name: "Todo editor" }).first();
		await expect(newEditor).toBeVisible({ timeout: 15000 });

		const typedText = `fresh synced text ${Date.now()}`;
		await newEditor.click();
		await page.keyboard.type(typedText, { delay: 40 });

		await expect
			.poll(async () => (await newEditor.innerText()).trim(), {
				timeout: 5000,
			})
			.toBe(typedText);
	});

	test("shows no guest placeholder column while a signed-in account loads", async ({
		page,
		request,
		baseURL,
	}) => {
		const accountId = await createAccount(request, baseURL!);
		let releaseAccount!: () => void;
		const accountReleased = new Promise<void>((resolve) => {
			releaseAccount = resolve;
		});
		let markAccountRequested!: () => void;
		const accountRequested = new Promise<void>((resolve) => {
			markAccountRequested = resolve;
		});
		await page.route("**/api/account", async (route) => {
			markAccountRequested();
			await accountReleased;
			await route.continue();
		}, { times: 1 });
		await page.addInitScript(({ accountKey, welcomeKey, id }) => {
			localStorage.setItem(accountKey, id);
			localStorage.setItem(welcomeKey, "true");
		}, { accountKey: ACCOUNT_STORAGE_KEY, welcomeKey: WELCOME_KEY, id: accountId });

		await page.goto("/");
		await accountRequested;
		await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Todo editor" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Add column" })).toHaveCount(0);

		releaseAccount();
		await expect(page.getByRole("button", { name: "Add column" })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Todo editor" })).toHaveCount(0);
	});
});
