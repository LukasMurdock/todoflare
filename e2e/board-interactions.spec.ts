import { expect, test } from "@playwright/test";
import { LOCAL_COLUMNS_KEY, WELCOME_KEY } from "./helpers/ui-session";

test("holding Cmd/Ctrl highlights links in the editor and releasing clears it", async ({ page }) => {
	await page.addInitScript(({ columnsKey, welcomeKey }) => {
		localStorage.setItem(welcomeKey, "true");
		localStorage.setItem(columnsKey, JSON.stringify([
			{ id: "00000000-0000-4000-8000-000000000001", value: [{ type: "p", children: [{ text: "Visit example.com today" }] }] },
		]));
	}, { columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	await expect(page.locator(".url-text")).toHaveText("example.com");
	await expect(page.locator(".cmd-pressed")).toHaveCount(0);
	await page.keyboard.down("ControlOrMeta");
	await expect(page.locator(".cmd-pressed .url-text")).toHaveCount(1);
	await page.keyboard.up("ControlOrMeta");
	await expect(page.locator(".cmd-pressed")).toHaveCount(0);
});
