import { expect, test } from "@playwright/test";
import { createAccount, createColumn, getAccountColumnOrder } from "./helpers/account-api";
import { bootstrapAuthenticatedPage } from "./helpers/ui-session";
import { getSyncStateSnapshot, getYjsOutboxCountForColumn } from "./helpers/local-first-readers";

test("edits held for a trashed column are kept, not counted as pending, and send on restore", async ({ browser, request, baseURL }) => {
	const appUrl = baseURL ?? "http://127.0.0.1:4173";
	const accountId = await createAccount(request, appUrl);
	await createColumn(request, appUrl, accountId);
	const columnId = await createColumn(request, appUrl, accountId);
	const context = await browser.newContext();
	const page = await context.newPage();
	await bootstrapAuthenticatedPage(page, accountId);
	const editors = page.getByRole("textbox", { name: "Todo editor" });
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await expect(editors.last()).toHaveAttribute("contenteditable", "true");

	// Type while offline so the edit is still unsent when the column is deleted.
	await context.setOffline(true);
	await page.evaluate(() => window.dispatchEvent(new Event("offline")));
	await editors.last().click();
	await page.keyboard.type("Held text");
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId)).toBeGreaterThanOrEqual(1);
	await page.getByRole("button", { name: "Delete column" }).last().click();
	await page.getByRole("alertdialog", { name: "Delete column?" }).getByRole("button", { name: "Delete" }).click();
	await expect(editors).toHaveCount(1);

	await context.setOffline(false);
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await expect.poll(() => getAccountColumnOrder(request, appUrl, accountId), { timeout: 15000 }).not.toContain(columnId);

	// Once the server confirms the trash, the edit is held rather than pending.
	await expect.poll(async () => (await getSyncStateSnapshot(page, accountId))?.yjsQueueDepth, { timeout: 15000 }).toBe(0);
	expect(await getYjsOutboxCountForColumn(page, accountId, columnId)).toBeGreaterThanOrEqual(1);

	const compactAccountId = accountId.replace(/\D/g, "");
	await page.getByRole("button", { name: `${compactAccountId.slice(0, 4)}...${compactAccountId.slice(-4)}` }).click();
	await page.getByRole("menuitem", { name: /Recently Deleted/ }).click();
	const recentlyDeleted = page.getByRole("dialog", { name: "Recently Deleted" });
	await recentlyDeleted.getByRole("button", { name: "Restore" }).click();
	await expect(recentlyDeleted.getByText("No recently deleted columns.")).toBeVisible({ timeout: 15000 });
	await recentlyDeleted.getByRole("button", { name: "Close" }).click();
	await expect(editors).toHaveCount(2, { timeout: 15000 });
	await expect.poll(() => getYjsOutboxCountForColumn(page, accountId, columnId), { timeout: 15000 }).toBe(0);

	// A browser with no local copy proves the text reached the server.
	const fresh = await browser.newPage();
	await bootstrapAuthenticatedPage(fresh, accountId);
	await expect(fresh.getByRole("textbox", { name: "Todo editor" }).last()).toContainText("Held text", { timeout: 15000 });
	await fresh.close();
	await context.close();
});
