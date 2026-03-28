import { expect, test } from "@playwright/test";
import { createAccount } from "./helpers/account-api";
import { bootstrapAuthenticatedPage } from "./helpers/ui-session";

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
});
