import { expect, test } from "@playwright/test";
import { createAccount, createColumn } from "./helpers/account-api";
import { bootstrapAuthenticatedPage, ensureColumnExists } from "./helpers/ui-session";
import { getYjsOutboxCountForColumn } from "./helpers/local-first-readers";

test("preserves edits from two offline tabs after both close", async ({ browser, request, baseURL }) => {
	const accountId = await createAccount(request, baseURL!);
	const columnId = await createColumn(request, baseURL!, accountId);
	const context = await browser.newContext();
	const first = await context.newPage(), second = await context.newPage();
	await bootstrapAuthenticatedPage(first, accountId);
	await bootstrapAuthenticatedPage(second, accountId);
	await ensureColumnExists(first); await ensureColumnExists(second);
	const editor = (page: typeof first) => page.getByRole("textbox", { name: "Todo editor" }).first();
	await expect(editor(first)).toHaveAttribute("contenteditable", "true");
	await expect(editor(second)).toHaveAttribute("contenteditable", "true");
	await editor(first).click(); await first.keyboard.type("Baseline ");
	await expect(editor(second)).toContainText("Baseline ");
	await expect.poll(() => getYjsOutboxCountForColumn(first, accountId, columnId)).toBe(0);
	await context.setOffline(true);
	for (const page of [first, second]) await page.evaluate(() => window.dispatchEvent(new Event("offline")));
	await editor(first).click(); await first.keyboard.type("First offline tab");
	await editor(second).click(); await second.keyboard.type("Second offline tab");
	await expect(editor(first)).toContainText("First offline tab");
	await expect(editor(second)).toContainText("Second offline tab");
	await expect.poll(() => getYjsOutboxCountForColumn(first, accountId, columnId)).toBeGreaterThanOrEqual(2);
	await first.close(); await second.close();
	await context.setOffline(false);
	const reopened = await context.newPage();
	await bootstrapAuthenticatedPage(reopened, accountId); await ensureColumnExists(reopened);
	await expect(editor(reopened)).toContainText("First offline tab", { timeout: 20000 });
	await expect(editor(reopened)).toContainText("Second offline tab");
	await context.close();
});

test("pauses guest editing on quota failure and exports the unsaved content", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("todoflare-welcomed", "true"));
	await page.goto("/");
	await page.keyboard.press("Escape");
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await expect(editor).toHaveAttribute("contenteditable", "true");
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		(window as unknown as { restoreStorage: () => void }).restoreStorage = () => { Storage.prototype.setItem = original; };
		Storage.prototype.setItem = function (key, value) {
			if (key === "todoflare-columns") throw new DOMException("Quota full", "QuotaExceededError");
			original.call(this, key, value);
		};
	});
	await editor.click(); await page.keyboard.insertText("Retain unsaved guest content");
	await expect(page.getByRole("alert")).toContainText("Editing paused");
	await expect(editor).toHaveAttribute("contenteditable", "false");
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download recovery copy" }).click();
	const download = await downloadPromise;
	const stream = await download.createReadStream();
	let contents = "";
	for await (const chunk of stream!) contents += chunk.toString();
	expect(contents).toContain("Retain unsaved guest content");
	await page.evaluate(() => (window as unknown as { restoreStorage: () => void }).restoreStorage());
	await page.getByRole("button", { name: "Retry saving" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(editor).toHaveAttribute("contenteditable", "true");
	await page.reload();
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(editor).toContainText("Retain unsaved guest content");
});
