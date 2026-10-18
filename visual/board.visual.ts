import { expect, test, type Page } from "@playwright/test";
import { createAccount } from "../e2e/helpers/account-api";
import { addColumnAndGetId, bootstrapAuthenticatedPage, LOCAL_COLUMNS_KEY, WELCOME_KEY } from "../e2e/helpers/ui-session";
import { GUEST_COLUMNS } from "./fixtures";

/** Hides UI that is timing-dependent rather than part of the board's rendering. */
const STABLE_CSS = "[data-sonner-toaster] { display: none !important; }";

async function openGuestBoard(page: Page, { welcomed = true } = {}) {
	await page.addInitScript(
		({ columnsKey, welcomeKey, columns, welcomed }) => {
			localStorage.setItem(columnsKey, JSON.stringify(columns));
			if (welcomed) localStorage.setItem(welcomeKey, "true");
		},
		{ columnsKey: LOCAL_COLUMNS_KEY, welcomeKey: WELCOME_KEY, columns: GUEST_COLUMNS, welcomed },
	);
	await page.goto("/");
	// Guests are offered an account; the board is behind that dialog.
	await page.keyboard.press("Escape");
	await expect(page.getByRole("textbox", { name: "Todo editor" }).first()).toContainText("Groceries");
	await page.addStyleTag({ content: STABLE_CSS });
}

const accountBadge = (page: Page) => page.locator(".fixed.top-2.right-2");

test("guest board", async ({ page }) => {
	await openGuestBoard(page);
	await expect(page).toHaveScreenshot("guest-board.png");
});

test("guest board, welcome screen", async ({ page }) => {
	await openGuestBoard(page, { welcomed: false });
	await expect(page).toHaveScreenshot("guest-welcome.png");
});

test("keyboard shortcuts dialog", async ({ page }) => {
	await openGuestBoard(page);
	await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page).toHaveScreenshot("shortcuts-dialog.png");
});

test("delete confirmation for a column with content", async ({ page }) => {
	await openGuestBoard(page);
	// The confirm trigger has no accessible name; it is the last header button of the first column.
	await page.locator("div.w-80").first().locator("div.h-10 button").last().click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(page).toHaveScreenshot("delete-confirm.png");
});

test("signed-in board with share menu", async ({ page, request, baseURL }) => {
	const accountId = await createAccount(request, baseURL!);
	await bootstrapAuthenticatedPage(page, accountId);
	// Not ensureColumnExists: a guest placeholder column renders before the account loads.
	await addColumnAndGetId(page);
	const editor = page.getByRole("textbox", { name: "Todo editor" }).first();
	await expect(editor).toHaveAttribute("contenteditable", "true");
	await editor.click();
	await page.keyboard.type("# Synced\n[] Collaborative todo\n");
	await expect(editor).toContainText("Collaborative todo");
	await page.mouse.click(1200, 700);
	await page.addStyleTag({ content: STABLE_CSS });
	await expect(page).toHaveScreenshot("signed-in-board.png", { mask: [accountBadge(page)] });
	await page.getByRole("button", { name: "Share column" }).click();
	await expect(page.getByRole("textbox", { name: "Account ID" })).toBeVisible();
	await expect(page).toHaveScreenshot("share-menu.png", { mask: [accountBadge(page)] });
});
