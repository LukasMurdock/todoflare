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

test("dialogs render inside the board, not in document.body", async ({ page }) => {
	await page.addInitScript(({ columnsKey, welcomeKey }) => {
		localStorage.setItem(welcomeKey, "true");
		localStorage.setItem(columnsKey, JSON.stringify([
			{ id: "00000000-0000-4000-8000-000000000001", value: [{ type: "p", children: [{ text: "Content" }] }] },
			{ id: "00000000-0000-4000-8000-000000000002", value: [{ type: "p", children: [{ text: "" }] }] },
		]));
	}, { columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	const board = page.locator("[data-todo-board]");

	await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
	await expect(board.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
	await page.keyboard.press("Escape");

	await board.locator("div.w-80").first().locator("div.h-10 button").last().click();
	await expect(board.getByRole("alertdialog")).toBeVisible();
});

test("guest edits persist across reloads and can be undone", async ({ page }) => {
	await page.addInitScript(({ welcomeKey }) => localStorage.setItem(welcomeKey, "true"), { welcomeKey: WELCOME_KEY });
	await page.goto("/");
	await page.keyboard.press("Escape");
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await editor.click();
	await page.keyboard.type("[] Guest todo");
	await expect(editor).toContainText("Guest todo");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);

	await expect
		.poll(() => page.evaluate((key) => localStorage.getItem(key) ?? "", LOCAL_COLUMNS_KEY))
		.toContain("Guest todo");
	await page.reload();
	// Saved guest data now prompts to claim it; dismiss to reach the board.
	await expect(page.getByRole("dialog", { name: "You have local data" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(editor).toContainText("Guest todo");
	await expect(editor.getByRole("checkbox")).toHaveCount(1);

	await editor.click();
	await page.keyboard.press("End");
	await page.keyboard.type(" extra");
	await expect(editor).toContainText("Guest todo extra");
	await page.keyboard.press("ControlOrMeta+z");
	await expect(editor).not.toContainText("extra");
	await expect(editor).toContainText("Guest todo");
});
